"""Integration Hub business logic: connections, OAuth, sharing policies, inbound endpoints, sync jobs,
API credentials. Views never bypass this module.

Sensitive changes require a recent re-authentication: creating a connection, changing its destination
or credentials, widening what it may share, enabling or rotating inbound secrets, disconnecting, and
creating API credentials.
"""

from __future__ import annotations

import contextlib
import hashlib
import re
import secrets
import uuid
from base64 import urlsafe_b64encode
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import actions
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.reauth import require_recent_auth
from apps.authz.service import check
from apps.core import crypto, validators
from apps.core.exceptions import ConflictError, DomainError
from apps.integrations import credentials as sealed
from apps.integrations import errors, events, fields, net, scopes, signing, sync
from apps.integrations.models import (
    ApiCredential,
    AuthType,
    ConflictStrategy,
    ConnectionStatus,
    Direction,
    FieldMapping,
    IntegrationConnection,
    OutboundDelivery,
    SharingPolicy,
    SyncJob,
)
from apps.integrations.providers import get_provider, hub_managed
from apps.integrations.providers.base import ProviderError
from apps.integrations.providers.generic_rest import DEFAULT_CONVENTIONS, valid_path

OAUTH_STATE_TTL = 600
MAX_CONNECTIONS_PER_ORG = 25
MAX_API_CREDENTIALS_PER_ORG = 50
SECRET_ROTATION_OVERLAP = timedelta(hours=24)
_HEADER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9\-]{0,63}$")
_FIELD_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$")
_SCOPE_RE = re.compile(r"^[A-Za-z0-9:._/\-]{1,200}$")
_FORBIDDEN_HEADERS = {"host", "content-length", "transfer-encoding", "connection", "cookie", "keel-signature"}
_CREDENTIAL_KEYS: dict[str, set[str]] = {
    AuthType.API_KEY: {"api_key"},
    AuthType.BEARER_TOKEN: {"token"},
    AuthType.OAUTH2_CLIENT_CREDENTIALS: {"client_secret"},
    AuthType.OAUTH2_CODE: {"client_secret"},
    AuthType.SIGNED_WEBHOOK: set(),
}


# ----------------------------------------------------------------------------- validation


def _unsafe(exc: net.UnsafeDestination, field: str) -> ValidationError:
    return ValidationError({field: exc.message})


def _clean_url(value: Any, field: str, *, required: bool = True) -> str:
    url = str(value or "").strip()
    if not url:
        if required:
            raise ValidationError({field: "This field is required."})
        return ""
    try:
        target = net.validate_url(url)
    except net.UnsafeDestination as exc:
        raise _unsafe(exc, field) from exc
    if "#" in url:
        raise ValidationError({field: "Remove the #fragment from the URL."})
    return url.rstrip("/") if field == "base_url" and not target.query else url


def validate_config(auth_type: str, config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ValidationError({"config": "Expected an object."})
    unknown = set(config) - {"base_url", "oauth", "conventions"}
    if unknown:
        raise ValidationError({"config": f"Unknown settings: {', '.join(sorted(unknown))}."})
    cleaned: dict[str, Any] = {}
    needs_api = auth_type != AuthType.SIGNED_WEBHOOK
    base_url = _clean_url(config.get("base_url"), "base_url", required=needs_api)
    if base_url:
        if net.validate_url(base_url).query:
            raise ValidationError({"base_url": "The base URL cannot contain a query string."})
        cleaned["base_url"] = base_url

    if auth_type in (AuthType.OAUTH2_CODE, AuthType.OAUTH2_CLIENT_CREDENTIALS):
        oauth = config.get("oauth") or {}
        if not isinstance(oauth, dict):
            raise ValidationError({"oauth": "Expected an object."})
        if "client_secret" in oauth:
            raise ValidationError({"oauth": "Send the client secret as a credential, not as a setting."})
        client_id = validators.clean_text(oauth.get("client_id"), max_length=256)
        if not client_id:
            raise ValidationError({"oauth.client_id": "This field is required."})
        oauth_clean: dict[str, Any] = {
            "client_id": client_id,
            "token_url": _clean_url(oauth.get("token_url"), "oauth.token_url"),
        }
        if auth_type == AuthType.OAUTH2_CODE:
            oauth_clean["authorize_url"] = _clean_url(oauth.get("authorize_url"), "oauth.authorize_url")
        revoke = _clean_url(oauth.get("revoke_url"), "oauth.revoke_url", required=False)
        if revoke:
            oauth_clean["revoke_url"] = revoke
        requested = oauth.get("scopes") or []
        if (
            not isinstance(requested, list)
            or len(requested) > 20
            or not all(isinstance(s, str) and _SCOPE_RE.match(s) for s in requested)
        ):
            raise ValidationError({"oauth.scopes": "Enter up to 20 valid scope names."})
        oauth_clean["scopes"] = requested
        cleaned["oauth"] = oauth_clean

    conv = config.get("conventions") or {}
    if not isinstance(conv, dict) or set(conv) - set(DEFAULT_CONVENTIONS):
        raise ValidationError({"conventions": "Unknown response convention."})
    conv_clean: dict[str, str] = {}
    for key, value in conv.items():
        value = str(value).strip()
        if key == "health_path":
            ok = valid_path(value)
        elif key == "update_method":
            value = value.upper()
            ok = value in {"PATCH", "PUT", "POST"}
        elif key == "api_key_header":
            ok = bool(_HEADER_RE.match(value)) and value.lower() not in _FORBIDDEN_HEADERS
        else:
            ok = bool(_FIELD_NAME_RE.match(value))
        if not ok:
            raise ValidationError({f"conventions.{key}": "Invalid value."})
        conv_clean[key] = value
    if conv_clean:
        cleaned["conventions"] = conv_clean
    return cleaned


def validate_credentials(auth_type: str, supplied: dict[str, Any]) -> dict[str, str]:
    if not isinstance(supplied, dict):
        raise ValidationError({"credentials": "Expected an object."})
    allowed = _CREDENTIAL_KEYS.get(auth_type, set())
    unknown = set(supplied) - allowed
    if unknown:
        raise ValidationError(
            {"credentials": f"Not accepted for this authentication type: {', '.join(sorted(unknown))}."}
        )
    cleaned: dict[str, str] = {}
    for key in allowed:
        value = supplied.get(key)
        if value in (None, ""):
            continue
        if not isinstance(value, str) or len(value) > 8192 or any(ch in value for ch in "\r\n\x00"):
            raise ValidationError({f"credentials.{key}": "Invalid value."})
        cleaned[key] = value
    required = {AuthType.API_KEY: "api_key", AuthType.BEARER_TOKEN: "token"}.get(auth_type)  # type: ignore[call-overload]
    if required and required not in cleaned:
        raise ValidationError({f"credentials.{required}": "This field is required."})
    return cleaned


# ----------------------------------------------------------------------------- connections


def _after_config_change(connection: IntegrationConnection) -> None:
    events.invalidate_targets(connection.organization_id)


def _run_connect(connection: IntegrationConnection) -> None:
    """Verify credentials with the provider and record the result on the connection."""
    provider = get_provider(connection.provider)
    try:
        ctx = sync.provider_context(connection)
        result = provider.connect(ctx)
    except ProviderError as exc:
        sync.record_failure(connection, exc)
        return
    if result.ok:
        IntegrationConnection.objects.filter(pk=connection.pk).update(
            status=ConnectionStatus.CONNECTED,
            connected_at=timezone.now(),
            last_error_code="",
            consecutive_failures=0,
            updated_at=timezone.now(),
        )
        connection.refresh_from_db()
    else:
        sync.record_failure(connection, ProviderError(result.code or "not_configured", action_required=True))


@transaction.atomic
def create_connection(
    actor: Actor,
    *,
    provider: str,
    name: str,
    auth_type: str,
    config: dict[str, Any],
    credentials: dict[str, Any],
    request: Any = None,
) -> IntegrationConnection:
    check(actor, "integrations.manage")
    require_recent_auth(request)
    if not hub_managed(provider):
        raise ValidationError({"provider": "Connect this integration from its own settings page."})
    implementation = get_provider(provider)
    if auth_type not in implementation.auth_types:
        raise ValidationError({"auth_type": "Not supported by this integration."})
    name = validators.clean_text(name, max_length=80)
    if not name:
        raise ValidationError({"name": "Name is required."})
    if IntegrationConnection.objects.count() >= MAX_CONNECTIONS_PER_ORG:
        raise DomainError("Connection limit reached.", code="connection_limit", status_code=429)
    clean_config = validate_config(auth_type, config)
    clean_credentials = validate_credentials(auth_type, credentials)
    try:
        with transaction.atomic():
            connection = IntegrationConnection.objects.create(
                provider=provider,
                name=name,
                auth_type=auth_type,
                config=clean_config,
                credentials_enc=sealed.seal(clean_credentials),
                status=ConnectionStatus.DISCONNECTED,
                connected_by=actor.membership,
                conflict_strategy=ConflictStrategy.MANUAL,
            )
    except IntegrityError as exc:
        raise ConflictError("A connection with this name already exists.", code="connection_name_taken") from exc
    audit.record(
        actions.INTEGRATION_CONNECTED,
        request=request,
        user=actor.user,
        resource=connection,
        resource_type="integration",
        metadata={"provider": provider, "auth_type": auth_type, "name": name, "host": _host(clean_config)},
    )
    if auth_type == AuthType.OAUTH2_CODE:
        connection.status = ConnectionStatus.ACTION_REQUIRED
        connection.save(update_fields=["status", "updated_at"])
    elif auth_type == AuthType.SIGNED_WEBHOOK:
        connection.status = ConnectionStatus.CONNECTED
        connection.connected_at = timezone.now()
        connection.save(update_fields=["status", "connected_at", "updated_at"])
    else:
        _run_connect(connection)
    _after_config_change(connection)
    return connection


def _host(config: dict[str, Any]) -> str:
    try:
        return net.validate_url(config["base_url"]).host if config.get("base_url") else ""
    except net.UnsafeDestination:
        return ""


@transaction.atomic
def update_connection(actor: Actor, connection: IntegrationConnection, *, request: Any = None, **changes: Any):
    check(actor, "integrations.manage")
    update_fields: list[str] = []
    metadata: dict[str, Any] = {}
    if changes.get("name") is not None:
        name = validators.clean_text(changes["name"], max_length=80)
        if not name:
            raise ValidationError({"name": "Name is required."})
        if IntegrationConnection.objects.filter(name=name).exclude(pk=connection.pk).exists():
            raise ConflictError("A connection with this name already exists.", code="connection_name_taken")
        connection.name = name
        update_fields.append("name")
    if changes.get("config") is not None:
        # A new destination decides where CRM data goes: same bar as new credentials.
        require_recent_auth(request)
        connection.config = validate_config(connection.auth_type, changes["config"])
        update_fields.append("config")
        metadata["host"] = _host(connection.config)
    if changes.get("conflict_strategy") is not None:
        if changes["conflict_strategy"] not in ConflictStrategy.values:
            raise ValidationError({"conflict_strategy": "Unknown strategy."})
        connection.conflict_strategy = changes["conflict_strategy"]
        update_fields.append("conflict_strategy")
    if changes.get("sync_interval_minutes") is not None:
        interval = int(changes["sync_interval_minutes"])
        if interval not in settings.INTEGRATIONS_SYNC_INTERVALS:
            raise ValidationError({"sync_interval_minutes": "Choose one of the offered intervals."})
        connection.sync_interval_minutes = interval
        connection.next_sync_at = timezone.now() + timedelta(minutes=interval) if interval else None
        update_fields += ["sync_interval_minutes", "next_sync_at"]
    if not update_fields:
        return connection
    connection.save(update_fields=[*update_fields, "updated_at"])
    metadata["fields"] = sorted(set(update_fields))
    audit.record(
        actions.INTEGRATION_UPDATED,
        request=request,
        user=actor.user,
        resource=connection,
        resource_type="integration",
        metadata=metadata,
    )
    return connection


@transaction.atomic
def rotate_credentials(
    actor: Actor, connection: IntegrationConnection, *, credentials: dict[str, Any], request: Any = None
) -> IntegrationConnection:
    check(actor, "integrations.manage")
    require_recent_auth(request)
    clean = validate_credentials(connection.auth_type, credentials)
    connection.credentials_enc = sealed.seal(clean)
    connection.token_expires_at = None
    connection.connected_by = actor.membership
    connection.save(update_fields=["credentials_enc", "token_expires_at", "connected_by", "updated_at"])
    audit.record(
        actions.INTEGRATION_CREDENTIALS_ROTATED,
        request=request,
        user=actor.user,
        resource=connection,
        resource_type="integration",
        metadata={"fields": sorted(clean)},
    )
    if connection.auth_type == AuthType.OAUTH2_CODE:
        IntegrationConnection.objects.filter(pk=connection.pk).update(status=ConnectionStatus.ACTION_REQUIRED)
        connection.status = ConnectionStatus.ACTION_REQUIRED
    elif connection.status != ConnectionStatus.DISABLED:
        _run_connect(connection)
    _after_config_change(connection)
    return connection


def test_connection(actor: Actor, connection: IntegrationConnection) -> dict[str, Any]:
    check(actor, "integrations.manage")
    provider = get_provider(connection.provider)
    try:
        ctx = sync.provider_context(connection)
        if sync.connection_actor(connection) is None:
            raise ProviderError("member_lost_access", action_required=True)
        result = provider.test_connection(ctx)
    except ProviderError as exc:
        sync.record_failure(connection, exc)
        return {"ok": False, "code": exc.code, "message": errors.message_for(exc.code, provider.name)}
    if result.ok:
        sync.record_success(connection)
        return {"ok": True, "code": "", "message": f"{provider.name} connection is working."}
    return {"ok": False, "code": result.code, "message": errors.message_for(result.code, provider.name)}


@transaction.atomic
def set_paused(actor: Actor, connection: IntegrationConnection, *, paused: bool, request: Any = None):
    check(actor, "integrations.manage")
    if paused:
        if connection.status == ConnectionStatus.DISCONNECTED:
            raise DomainError("This integration is disconnected.", code="connection_disconnected", status_code=409)
        connection.status = ConnectionStatus.DISABLED
        connection.save(update_fields=["status", "updated_at"])
        action = actions.INTEGRATION_PAUSED
    else:
        if connection.status != ConnectionStatus.DISABLED:
            return connection
        connection.status = ConnectionStatus.ERROR  # re-verified immediately below
        connection.save(update_fields=["status", "updated_at"])
        if connection.auth_type == AuthType.SIGNED_WEBHOOK:
            sync.record_success(connection)
        else:
            _run_connect(connection)
        action = actions.INTEGRATION_RESUMED
    audit.record(action, request=request, user=actor.user, resource=connection, resource_type="integration")
    _after_config_change(connection)
    return connection


@transaction.atomic
def disconnect(actor: Actor, connection: IntegrationConnection, *, request: Any = None) -> IntegrationConnection:
    """Revoke remote tokens where supported, wipe stored secrets, stop sync. CRM data is never deleted."""
    check(actor, "integrations.manage")
    require_recent_auth(request)
    if connection.status == ConnectionStatus.DISCONNECTED and not connection.credentials_enc:
        return connection
    provider = get_provider(connection.provider)
    with contextlib.suppress(ProviderError):  # revocation is best effort; local secrets are wiped regardless
        provider.disconnect(sync.provider_context(connection))
    now = timezone.now()
    connection.status = ConnectionStatus.DISCONNECTED
    connection.credentials_enc = ""
    connection.token_expires_at = None
    connection.inbound_enabled = False
    connection.inbound_key_hash = ""
    connection.inbound_secret_enc = ""  # nosec B105 - empty means no stored secret
    connection.inbound_previous_secret_enc = ""  # nosec B105 - empty means no stored secret
    connection.inbound_previous_secret_expires_at = None
    connection.next_sync_at = None
    connection.disconnected_at = now
    connection.save()
    SyncJob.objects.filter(
        connection=connection, status__in=[SyncJob.Status.PENDING, SyncJob.Status.PROCESSING]
    ).update(status=SyncJob.Status.FAILED, error_code="disconnected", finished_at=now, updated_at=now)
    OutboundDelivery.objects.filter(connection=connection, status=OutboundDelivery.Status.PENDING).update(
        status=OutboundDelivery.Status.FAILED, error_code="disconnected", next_attempt_at=None, updated_at=now
    )
    audit.record(
        actions.INTEGRATION_DISCONNECTED,
        request=request,
        user=actor.user,
        resource=connection,
        resource_type="integration",
        metadata={"provider": connection.provider, "name": connection.name},
    )
    _after_config_change(connection)
    return connection


@transaction.atomic
def delete_connection(actor: Actor, connection: IntegrationConnection, *, request: Any = None) -> None:
    check(actor, "integrations.manage")
    require_recent_auth(request)
    if connection.status != ConnectionStatus.DISCONNECTED:
        raise DomainError("Disconnect the integration before deleting it.", code="connection_active", status_code=409)
    connection_id, name = connection.pk, connection.name
    connection.delete()
    audit.record(
        actions.INTEGRATION_DELETED,
        request=request,
        user=actor.user,
        resource_type="integration",
        resource_id=connection_id,
        metadata={"name": name},
    )
    events.invalidate_targets(actor.organization.pk)


# ----------------------------------------------------------------------------- OAuth (authorization code + PKCE)


def oauth_redirect_uri() -> str:
    return f"{settings.FRONTEND_ORIGIN}/api/v1/integrations/oauth/callback/"


def start_oauth(actor: Actor, connection: IntegrationConnection, *, request: Any = None) -> str:
    check(actor, "integrations.manage")
    require_recent_auth(request)
    if connection.auth_type != AuthType.OAUTH2_CODE:
        raise DomainError("This connection does not use OAuth sign-in.", code="oauth_not_supported")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    cache.set(
        f"oauth:integration:{state}",
        {
            "organization_id": str(actor.organization.pk),
            "membership_id": str(actor.membership.pk),
            "connection_id": str(connection.pk),
            "verifier": verifier,
        },
        OAUTH_STATE_TTL,
    )
    try:
        url = get_provider(connection.provider).authorization_url(
            sync.provider_context(connection), state=state, redirect_uri=oauth_redirect_uri(), code_challenge=challenge
        )
    except (ProviderError, net.UnsafeDestination) as exc:
        raise DomainError("The authorization URL is not valid.", code="oauth_config_invalid") from exc
    audit.record(
        actions.INTEGRATION_OAUTH_STARTED,
        request=request,
        user=actor.user,
        resource=connection,
        resource_type="integration",
    )
    return url


@transaction.atomic
def complete_oauth(actor: Actor, *, state: str, code: str, request: Any = None) -> IntegrationConnection:
    """Validate state (single use, bound to this organization and member), exchange the code, store tokens."""
    check(actor, "integrations.manage")
    key = f"oauth:integration:{state}"
    pending = cache.get(key) if state and len(state) <= 128 else None
    if (
        not pending
        or pending.get("organization_id") != str(actor.organization.pk)
        or pending.get("membership_id") != str(actor.membership.pk)
    ):
        raise DomainError("This sign-in link is invalid or has expired. Start again.", code="oauth_state_invalid")
    cache.delete(key)
    connection = IntegrationConnection.objects.filter(pk=pending["connection_id"]).first()
    if connection is None or connection.auth_type != AuthType.OAUTH2_CODE:
        raise DomainError("This sign-in link is invalid or has expired. Start again.", code="oauth_state_invalid")
    if not code or len(code) > 2048:
        raise DomainError("The provider did not return an authorization code.", code="oauth_failed")
    provider = get_provider(connection.provider)
    try:
        provider.complete_authorization(
            sync.provider_context(connection),
            code=code,
            redirect_uri=oauth_redirect_uri(),
            code_verifier=pending["verifier"],
        )
    except ProviderError as exc:
        sync.record_failure(connection, exc)
        raise DomainError(errors.message_for(exc.code, provider.name), code="oauth_failed", status_code=502) from exc
    connection.refresh_from_db()
    connection.connected_by = actor.membership
    connection.save(update_fields=["connected_by", "updated_at"])
    _run_connect(connection)
    audit.record(
        actions.INTEGRATION_CREDENTIALS_ROTATED,
        request=request,
        user=actor.user,
        resource=connection,
        resource_type="integration",
        metadata={"via": "oauth"},
    )
    _after_config_change(connection)
    return connection


# ----------------------------------------------------------------------------- sharing & mapping


@transaction.atomic
def set_sharing(
    actor: Actor,
    connection: IntegrationConnection,
    *,
    entity_type: str,
    direction: str,
    external_resource: str,
    mappings: list[dict[str, str]],
    request: Any = None,
) -> SharingPolicy:
    check(actor, "integrations.manage")
    spec = fields.entity(entity_type)
    if direction not in Direction.values:
        raise ValidationError({"direction": "Unknown direction."})
    provider = get_provider(connection.provider)
    if direction != Direction.NONE and not provider.supports_sync and not provider.supports_inbound_webhooks:
        raise ValidationError({"direction": "This integration does not exchange CRM records."})
    if direction in (Direction.INBOUND, Direction.TWO_WAY) and not spec.writable:
        raise ValidationError({"direction": "This data cannot be written by integrations."})
    if direction in (Direction.OUTBOUND, Direction.TWO_WAY) and connection.auth_type == AuthType.SIGNED_WEBHOOK:
        raise ValidationError({"direction": "A webhook-only connection can only receive data."})
    resource = (external_resource or "").strip()
    if direction != Direction.NONE and connection.auth_type != AuthType.SIGNED_WEBHOOK and not valid_path(resource):
        raise ValidationError({"external_resource": "Enter the API path for this data, for example /contacts."})
    cleaned = fields.validate_mappings(entity_type, direction, mappings)

    policy = SharingPolicy.objects.filter(connection=connection, entity_type=entity_type).first()
    previous = policy.direction if policy else Direction.NONE
    previous_fields = set(
        FieldMapping.objects.filter(connection=connection, entity_type=entity_type).values_list("crm_field", flat=True)
    )
    new_fields = {m["crm_field"] for m in cleaned}
    widens_outbound = direction in (Direction.OUTBOUND, Direction.TWO_WAY) and (
        previous not in (Direction.OUTBOUND, Direction.TWO_WAY) or not new_fields <= previous_fields
    )
    widens_inbound = direction in (Direction.INBOUND, Direction.TWO_WAY) and previous not in (
        Direction.INBOUND,
        Direction.TWO_WAY,
    )
    if widens_outbound or widens_inbound:
        require_recent_auth(request)  # "data export configured": more CRM data may leave or enter

    if policy is None:
        policy = SharingPolicy.objects.create(
            connection=connection, entity_type=entity_type, direction=direction, external_resource=resource
        )
    else:
        policy.direction = direction
        policy.external_resource = resource
        policy.save(update_fields=["direction", "external_resource", "updated_at"])
    FieldMapping.objects.filter(connection=connection, entity_type=entity_type).delete()
    FieldMapping.objects.bulk_create(
        [
            FieldMapping(
                organization_id=connection.organization_id, connection=connection, entity_type=entity_type, **m
            )
            for m in cleaned
        ]
    )
    if previous != direction:
        audit.record(
            actions.INTEGRATION_SHARING_CHANGED,
            request=request,
            user=actor.user,
            resource=connection,
            resource_type="integration",
            metadata={"entity_type": entity_type, "from": previous, "to": direction},
        )
    if previous_fields != new_fields or previous != direction:
        audit.record(
            actions.INTEGRATION_MAPPING_CHANGED,
            request=request,
            user=actor.user,
            resource=connection,
            resource_type="integration",
            metadata={"entity_type": entity_type, "fields": sorted(new_fields)},
        )
    _after_config_change(connection)
    return policy


# ----------------------------------------------------------------------------- inbound webhook endpoint


def inbound_url(key: str) -> str:
    return f"{settings.FRONTEND_ORIGIN}/api/v1/integrations/inbound/{key}/"


@transaction.atomic
def enable_inbound(actor: Actor, connection: IntegrationConnection, *, request: Any = None) -> dict[str, str]:
    """Create (or replace) the inbound endpoint. The URL key and secret are returned once, never again."""
    check(actor, "integrations.manage")
    require_recent_auth(request)
    if not get_provider(connection.provider).supports_inbound_webhooks:
        raise DomainError("This integration does not accept webhooks.", code="webhooks_not_supported")
    if connection.status == ConnectionStatus.DISCONNECTED:
        raise DomainError("Connect the integration first.", code="connection_disconnected", status_code=409)
    key = secrets.token_urlsafe(32)
    secret = signing.generate_secret()
    connection.inbound_enabled = True
    connection.inbound_key_hash = hashlib.sha256(key.encode("ascii")).hexdigest()
    connection.inbound_secret_enc = crypto.encrypt(secret)
    connection.inbound_previous_secret_enc = ""  # nosec B105 - empty means no stored secret
    connection.inbound_previous_secret_expires_at = None
    connection.save(
        update_fields=[
            "inbound_enabled",
            "inbound_key_hash",
            "inbound_secret_enc",
            "inbound_previous_secret_enc",
            "inbound_previous_secret_expires_at",
            "updated_at",
        ]
    )
    audit.record(
        actions.INTEGRATION_INBOUND_ENABLED,
        request=request,
        user=actor.user,
        resource=connection,
        resource_type="integration",
    )
    return {"url": inbound_url(key), "secret": secret}


@transaction.atomic
def rotate_inbound_secret(actor: Actor, connection: IntegrationConnection, *, request: Any = None) -> dict[str, str]:
    """New signing secret; the previous one keeps verifying for 24 hours so the sender can switch."""
    check(actor, "integrations.manage")
    require_recent_auth(request)
    if not connection.inbound_enabled or not connection.inbound_secret_enc:
        raise DomainError("The inbound webhook is not enabled.", code="inbound_disabled", status_code=409)
    secret = signing.generate_secret()
    connection.inbound_previous_secret_enc = connection.inbound_secret_enc
    connection.inbound_previous_secret_expires_at = timezone.now() + SECRET_ROTATION_OVERLAP
    connection.inbound_secret_enc = crypto.encrypt(secret)
    connection.save(
        update_fields=[
            "inbound_secret_enc",
            "inbound_previous_secret_enc",
            "inbound_previous_secret_expires_at",
            "updated_at",
        ]
    )
    audit.record(
        actions.INTEGRATION_INBOUND_SECRET_ROTATED,
        request=request,
        user=actor.user,
        resource=connection,
        resource_type="integration",
    )
    return {"secret": secret}


# ----------------------------------------------------------------------------- sync jobs


def start_sync(
    actor: Actor | None,
    connection: IntegrationConnection,
    *,
    trigger: str = SyncJob.Trigger.MANUAL,
    request: Any = None,
) -> SyncJob:
    if actor is not None:
        check(actor, "integrations.manage")
    if connection.status not in (ConnectionStatus.CONNECTED, ConnectionStatus.ERROR):
        raise DomainError("Only connected integrations can sync.", code="connection_not_ready", status_code=409)
    if not get_provider(connection.provider).supports_sync or connection.auth_type == AuthType.SIGNED_WEBHOOK:
        raise DomainError(
            "This integration does not support synchronization.", code="sync_not_supported", status_code=409
        )
    if not SharingPolicy.objects.filter(connection=connection).exclude(direction=Direction.NONE).exists():
        raise DomainError("Choose what data to share before syncing.", code="nothing_shared", status_code=409)
    try:
        with transaction.atomic():
            job = SyncJob.objects.create(
                connection=connection, trigger=trigger, triggered_by=actor.membership if actor else None, state={}
            )
    except IntegrityError as exc:
        raise ConflictError("A sync is already running for this integration.", code="sync_in_progress") from exc
    audit.record(
        actions.INTEGRATION_SYNC_STARTED,
        request=request,
        user=actor.user if actor else None,
        actor_type="user" if actor else "system",
        resource=job,
        resource_type="sync_job",
        metadata={"connection_id": str(connection.pk), "trigger": trigger},
    )
    job_pk, org_pk = job.pk, connection.organization_id
    transaction.on_commit(lambda: _enqueue_job(job_pk, org_pk))
    return job


def _enqueue_job(job_id: uuid.UUID, organization_id: uuid.UUID) -> None:
    from apps.integrations import tasks

    tasks.run_sync_job.delay(job_id=str(job_id), organization_id=str(organization_id))


# ----------------------------------------------------------------------------- API credentials


KEY_PREFIX = "keel_"


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


@transaction.atomic
def create_api_credential(
    actor: Actor,
    *,
    name: str,
    scope_keys: list[str],
    expires_in_days: int | None,
    request: Any = None,
) -> tuple[ApiCredential, str]:
    """Returns the credential and the full key. The key is never stored or shown again."""
    check(actor, "integrations.manage")
    require_recent_auth(request)
    name = validators.clean_text(name, max_length=80)
    if not name:
        raise ValidationError({"name": "Name is required."})
    cleaned = scopes.validate_scopes(scope_keys)
    missing = sorted(p for p in scopes.permissions_for(cleaned) if not actor.has(p))
    if missing:
        raise PermissionDenied(detail="You cannot grant access you do not have yourself.", code="scope_exceeds_actor")
    if expires_in_days is not None and not 1 <= int(expires_in_days) <= settings.INTEGRATIONS_API_KEY_MAX_DAYS:
        raise ValidationError(
            {"expires_in_days": f"Choose between 1 and {settings.INTEGRATIONS_API_KEY_MAX_DAYS} days."}
        )
    active = ApiCredential.objects.filter(revoked_at__isnull=True).count()
    if active >= MAX_API_CREDENTIALS_PER_ORG:
        raise DomainError(
            "API credential limit reached. Revoke unused credentials.", code="api_credential_limit", status_code=429
        )
    prefix = secrets.token_hex(8)
    secret = secrets.token_urlsafe(32)
    credential = ApiCredential.objects.create(
        name=name,
        prefix=prefix,
        secret_hash=hash_secret(secret),
        scopes=cleaned,
        created_by=actor.membership,
        expires_at=timezone.now() + timedelta(days=int(expires_in_days)) if expires_in_days else None,
    )
    audit.record(
        actions.API_CREDENTIAL_CREATED,
        request=request,
        user=actor.user,
        resource=credential,
        resource_type="api_credential",
        metadata={"name": name, "scopes": cleaned, "prefix": prefix, "expires_at": credential.expires_at},
    )
    return credential, f"{KEY_PREFIX}{prefix}_{secret}"


@transaction.atomic
def revoke_api_credential(actor: Actor, credential: ApiCredential, *, request: Any = None) -> ApiCredential:
    check(actor, "integrations.manage")
    if credential.revoked_at is not None:
        return credential
    credential.revoked_at = timezone.now()
    credential.revoked_by = actor.membership
    credential.save(update_fields=["revoked_at", "revoked_by", "updated_at"])
    audit.record(
        actions.API_CREDENTIAL_REVOKED,
        request=request,
        user=actor.user,
        resource=credential,
        resource_type="api_credential",
        metadata={"name": credential.name, "prefix": credential.prefix},
    )
    return credential
