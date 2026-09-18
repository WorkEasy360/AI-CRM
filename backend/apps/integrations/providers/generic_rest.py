"""Generic REST connector: any external system with a JSON REST API.

Configurable per connection (validated in ``services.validate_config``): base URL, authentication,
the resource path per shared entity and a few response conventions. Every call goes through
``net.safe_request`` (https only, public destinations only, no redirects, capped responses), so a
configuration can never make Keel call internal addresses.

Inbound webhooks for this connector use Keel's own signed envelope::

    {"type": "contact.upsert" | "company.upsert" | "deal.upsert",
     "data": {"id": "<external id>", ...external fields...}}
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import re
from typing import Any
from urllib.parse import quote, urlencode

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.integrations import net
from apps.integrations.providers.base import (
    ExternalRecord,
    HealthResult,
    IntegrationProvider,
    ProviderContext,
    ProviderError,
    PullPage,
    PushResult,
)

MAX_PAGE_ITEMS = 500
MAX_ID_LENGTH = 255
PATH_RE = re.compile(r"^/[A-Za-z0-9_\-./~]{0,200}$")
TOKEN_REFRESH_MARGIN = dt.timedelta(seconds=60)
WEBHOOK_TYPES = {"contact.upsert": "contact", "company.upsert": "company", "deal.upsert": "deal"}

DEFAULT_CONVENTIONS: dict[str, str] = {
    "id_field": "id",
    "updated_field": "updated_at",
    "list_key": "data",
    "next_cursor_field": "next_cursor",
    "cursor_param": "cursor",
    "since_param": "updated_since",
    "update_method": "PATCH",
    "health_path": "/",
    "api_key_header": "X-API-Key",
}


def conventions(config: dict[str, Any]) -> dict[str, str]:
    merged = dict(DEFAULT_CONVENTIONS)
    merged.update({k: str(v) for k, v in (config.get("conventions") or {}).items() if k in DEFAULT_CONVENTIONS})
    return merged


def valid_path(path: str) -> bool:
    return bool(PATH_RE.match(path or "")) and ".." not in path and "//" not in path


def _dig(data: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(part)
    return data


def _classify(response: net.SafeResponse, *, updating: bool = False) -> None:
    status = response.status_code
    if 200 <= status < 300:
        return
    if status == 401:
        raise ProviderError("auth_expired", action_required=True, status=status)
    if status == 403:
        raise ProviderError("auth_failed", action_required=True, status=status)
    if status == 404 and updating:
        raise ProviderError("record_not_found", status=status)
    if status in (408, 425, 429) or status >= 500:
        code = "rate_limited" if status == 429 else "unavailable"
        raise ProviderError(code, retryable=True, retry_after=net.retry_after_seconds(response), status=status)
    raise ProviderError("rejected", status=status)


def _json(response: net.SafeResponse) -> Any:
    if not response.content:
        return None
    try:
        return response.json()
    except (ValueError, UnicodeDecodeError) as exc:
        raise ProviderError("invalid_response") from exc


def _call(method: str, url: str, **kwargs: Any) -> net.SafeResponse:
    try:
        return net.safe_request(method, url, **kwargs)
    except net.UnsafeDestination as exc:
        raise ProviderError(exc.code) from exc
    except net.TransportError as exc:
        retryable = exc.code in {"timeout", "connection_failed", "dns_failure"}
        raise ProviderError(exc.code, retryable=retryable) from exc


class GenericRestProvider(IntegrationProvider):
    key = "generic_rest"
    name = "Generic REST API"
    description = "Connect any system with a JSON REST API using OAuth 2.0, an API key or a bearer token."
    category = "custom"
    auth_types = ("oauth2_code", "oauth2_client_credentials", "api_key", "bearer_token", "signed_webhook")
    supports_sync = True
    supports_inbound_webhooks = True

    # ------------------------------------------------------------------ helpers
    def _base(self, ctx: ProviderContext) -> str:
        base = str(ctx.connection.config.get("base_url") or "").rstrip("/")
        if not base:
            raise ProviderError("not_configured")
        return base

    def _url(self, ctx: ProviderContext, path: str, external_id: str | None = None) -> str:
        if not valid_path(path):
            raise ProviderError("invalid_resource")
        url = self._base(ctx) + path
        if external_id is not None:
            url += "/" + quote(external_id, safe="")
        return url

    def _auth_headers(self, ctx: ProviderContext) -> dict[str, str]:
        auth_type = ctx.connection.auth_type
        creds = ctx.credentials
        if auth_type == "api_key":
            header = conventions(ctx.connection.config)["api_key_header"]
            if not creds.get("api_key"):
                raise ProviderError("not_configured", action_required=True)
            return {header: str(creds["api_key"])}
        if auth_type == "bearer_token":
            if not creds.get("token"):
                raise ProviderError("not_configured", action_required=True)
            return {"Authorization": f"Bearer {creds['token']}"}
        if auth_type in ("oauth2_code", "oauth2_client_credentials"):
            self.refresh_credentials(ctx)
            if not ctx.credentials.get("access_token"):
                raise ProviderError("auth_expired", action_required=True)
            return {"Authorization": f"Bearer {ctx.credentials['access_token']}"}
        raise ProviderError("not_supported:api_calls")

    def _oauth(self, ctx: ProviderContext) -> dict[str, Any]:
        return dict(ctx.connection.config.get("oauth") or {})

    def _token_request(self, ctx: ProviderContext, form: dict[str, str]) -> None:
        oauth = self._oauth(ctx)
        form = {**form, "client_id": str(oauth.get("client_id", ""))}
        if ctx.credentials.get("client_secret"):
            form["client_secret"] = str(ctx.credentials["client_secret"])
        response = _call("POST", str(oauth.get("token_url", "")), form=form, headers={"Accept": "application/json"})
        if response.status_code in (400, 401, 403):
            raise ProviderError("auth_expired", action_required=True, status=response.status_code)
        _classify(response)
        payload = _json(response)
        if not isinstance(payload, dict) or not isinstance(payload.get("access_token"), str):
            raise ProviderError("invalid_response")
        try:
            expires_in = int(payload.get("expires_in") or 3600)
        except (TypeError, ValueError):
            expires_in = 3600
        updates: dict[str, Any] = {"access_token": payload["access_token"][:8192]}
        if isinstance(payload.get("refresh_token"), str):
            updates["refresh_token"] = payload["refresh_token"][:8192]
        ctx.save_credentials(
            updates, expires_at=timezone.now() + dt.timedelta(seconds=max(60, min(expires_in, 86400 * 90)))
        )

    # ------------------------------------------------------------------ lifecycle
    def connect(self, ctx: ProviderContext) -> HealthResult:
        if ctx.connection.auth_type == "oauth2_client_credentials":
            self._token_request(
                ctx, {"grant_type": "client_credentials", "scope": " ".join(self._oauth(ctx).get("scopes") or [])}
            )
        if ctx.connection.auth_type == "signed_webhook":
            return HealthResult(ok=True)
        return self.test_connection(ctx)

    def authorization_url(self, ctx: ProviderContext, *, state: str, redirect_uri: str, code_challenge: str) -> str:
        oauth = self._oauth(ctx)
        params = {
            "response_type": "code",
            "client_id": str(oauth.get("client_id", "")),
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if oauth.get("scopes"):
            params["scope"] = " ".join(oauth["scopes"])
        authorize_url = str(oauth.get("authorize_url", ""))
        net.validate_url(authorize_url)  # the browser is sent there: https + public host only
        separator = "&" if "?" in authorize_url else "?"
        return f"{authorize_url}{separator}{urlencode(params)}"

    def complete_authorization(self, ctx: ProviderContext, *, code: str, redirect_uri: str, code_verifier: str) -> None:
        self._token_request(
            ctx,
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
        )

    def refresh_credentials(self, ctx: ProviderContext) -> None:
        auth_type = ctx.connection.auth_type
        if auth_type not in ("oauth2_code", "oauth2_client_credentials"):
            return
        expires = ctx.connection.token_expires_at
        if ctx.credentials.get("access_token") and expires and expires > timezone.now() + TOKEN_REFRESH_MARGIN:
            return
        if auth_type == "oauth2_client_credentials":
            self._token_request(
                ctx, {"grant_type": "client_credentials", "scope": " ".join(self._oauth(ctx).get("scopes") or [])}
            )
            return
        refresh = ctx.credentials.get("refresh_token")
        if not refresh:
            raise ProviderError("auth_expired", action_required=True)
        self._token_request(ctx, {"grant_type": "refresh_token", "refresh_token": str(refresh)})

    def disconnect(self, ctx: ProviderContext) -> None:
        revoke_url = self._oauth(ctx).get("revoke_url")
        token = ctx.credentials.get("refresh_token") or ctx.credentials.get("access_token")
        if not revoke_url or not token:
            return
        form = {"token": str(token), "client_id": str(self._oauth(ctx).get("client_id", ""))}
        if ctx.credentials.get("client_secret"):
            form["client_secret"] = str(ctx.credentials["client_secret"])
        with contextlib.suppress(ProviderError):  # RFC 7009 revocation, best effort
            _call("POST", str(revoke_url), form=form)

    def test_connection(self, ctx: ProviderContext) -> HealthResult:
        if ctx.connection.auth_type == "signed_webhook":
            return HealthResult(
                ok=bool(ctx.connection.inbound_secret_enc),
                code="" if ctx.connection.inbound_secret_enc else "not_configured",
            )
        path = conventions(ctx.connection.config)["health_path"]
        response = _call("GET", self._url(ctx, path), headers={**self._auth_headers(ctx), "Accept": "application/json"})
        _classify(response)
        return HealthResult(ok=True)

    # ------------------------------------------------------------------ data exchange
    def pull(
        self, ctx: ProviderContext, entity_type: str, *, resource: str, cursor: str | None, since: dt.datetime | None
    ) -> PullPage:
        conv = conventions(ctx.connection.config)
        params: dict[str, str] = {"limit": "100"}
        if cursor:
            params[conv["cursor_param"]] = cursor
        elif since is not None:
            params[conv["since_param"]] = since.isoformat()
        response = _call(
            "GET",
            self._url(ctx, resource),
            params=params,
            headers={**self._auth_headers(ctx), "Accept": "application/json"},
        )
        _classify(response)
        payload = _json(response)
        items = payload if isinstance(payload, list) else _dig(payload, conv["list_key"])
        if not isinstance(items, list) or len(items) > MAX_PAGE_ITEMS:
            raise ProviderError("invalid_response")
        records = [record for item in items if (record := self._record(item, conv)) is not None]
        next_cursor = _dig(payload, conv["next_cursor_field"]) if isinstance(payload, dict) else None
        if next_cursor is not None and (not isinstance(next_cursor, str | int) or len(str(next_cursor)) > 512):
            raise ProviderError("invalid_response")
        return PullPage(records=records, next_cursor=str(next_cursor) if next_cursor not in (None, "") else None)

    @staticmethod
    def _record(item: Any, conv: dict[str, str]) -> ExternalRecord | None:
        if not isinstance(item, dict):
            return None
        external_id = _dig(item, conv["id_field"])
        if not isinstance(external_id, str | int) or isinstance(external_id, bool):
            return None
        external_id = str(external_id)
        if not external_id or len(external_id) > MAX_ID_LENGTH:
            return None
        updated_raw = _dig(item, conv["updated_field"])
        updated_at = parse_datetime(updated_raw) if isinstance(updated_raw, str) else None
        return ExternalRecord(external_id=external_id, values=item, updated_at=updated_at)

    def push(
        self,
        ctx: ProviderContext,
        entity_type: str,
        *,
        resource: str,
        values: dict[str, Any],
        external_id: str | None,
        idempotency_key: str,
    ) -> PushResult:
        conv = conventions(ctx.connection.config)
        method = conv["update_method"].upper() if external_id else "POST"
        if method not in ("PATCH", "PUT", "POST"):
            method = "PATCH"
        body = json.dumps(values, separators=(",", ":"), default=str).encode("utf-8")
        headers = {
            **self._auth_headers(ctx),
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Idempotency-Key": idempotency_key,
        }
        response = _call(method, self._url(ctx, resource, external_id), content=body, headers=headers)
        _classify(response, updating=external_id is not None)
        if external_id:
            return PushResult(external_id=external_id)
        payload = _json(response)
        new_id = _dig(payload, conv["id_field"]) if isinstance(payload, dict) else None
        if (
            not isinstance(new_id, str | int)
            or isinstance(new_id, bool)
            or not str(new_id)
            or len(str(new_id)) > MAX_ID_LENGTH
        ):
            raise ProviderError("invalid_response")
        return PushResult(external_id=str(new_id))

    def handle_webhook(self, ctx: ProviderContext, payload: dict[str, Any]) -> list[tuple[str, ExternalRecord]]:
        entity_type = WEBHOOK_TYPES.get(str(payload.get("type", "")))
        data = payload.get("data")
        if entity_type is None or not isinstance(data, dict):
            raise ProviderError("invalid_payload")
        record = self._record(data, conventions(ctx.connection.config))
        if record is None:
            raise ProviderError("invalid_payload")
        return [(entity_type, record)]
