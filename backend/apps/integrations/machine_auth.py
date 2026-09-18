"""Authentication of external software calling the Keel API with an API credential.

Machine credentials never create or use a browser session. The middleware runs before
``TenantMiddleware`` and only handles ``Authorization: Bearer keel_...``:

- the path must be one of ``scopes.MACHINE_PATH_PREFIXES`` (CRM record APIs); any other endpoint
  (session, members, settings, integrations, allauth, AI) refuses machine credentials outright;
- a request carrying both a session cookie and a credential is refused (no ambiguous identity);
- the key is looked up by its public prefix and compared by hash in constant time; revoked or
  expired credentials, or ones whose creator can no longer act, are rejected;
- the resulting ``IntegrationActor`` holds the intersection of the creator's grants and the scopes.

``TenantMiddleware`` then binds the tenant context from that actor exactly as it does for a session.
"""

from __future__ import annotations

import hmac
import re
from collections.abc import Callable

import structlog
from django.conf import settings
from django.core.cache import cache
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils import timezone
from rest_framework.authentication import BaseAuthentication

from apps.core.tenancy.context import system_context
from apps.integrations import scopes
from apps.integrations.identity import IntegrationActor, build_integration_actor

log = structlog.get_logger(__name__)

_KEY_RE = re.compile(r"^keel_([0-9a-f]{16})_([A-Za-z0-9_\-]{43})$")
_LAST_USED_INTERVAL = 60


def _problem(status: int, type_: str, title: str) -> JsonResponse:
    response = JsonResponse({"type": type_, "title": title, "status": status}, status=status)
    if status == 401:
        response["WWW-Authenticate"] = 'Bearer realm="keel"'
    return response


def authenticate_key(raw_key: str) -> IntegrationActor | None:
    from apps.accounts.models import Membership
    from apps.integrations.models import ApiCredential
    from apps.integrations.services import hash_secret

    match = _KEY_RE.match(raw_key or "")
    if match is None:
        return None
    prefix, secret = match.groups()
    now = timezone.now()
    # Cross-tenant on purpose: the organization is unknown until the credential is found. The lookup is by
    # the credential's public prefix; everything after it is pinned to that credential's organization.
    with system_context("integrations.api_credential.authenticate"):
        credentials = ApiCredential.all_objects  # nosemgrep: keel-unscoped-manager-outside-system-code
        credential = credentials.filter(prefix=prefix).first()
        if credential is None or not hmac.compare_digest(credential.secret_hash, hash_secret(secret)):
            return None
        if credential.revoked_at is not None or (credential.expires_at is not None and credential.expires_at <= now):
            return None
        memberships = Membership.all_objects  # nosemgrep: keel-unscoped-manager-outside-system-code
        membership = (
            memberships.select_related("user", "role", "organization")
            .filter(pk=credential.created_by_id, organization_id=credential.organization_id)
            .first()
            if credential.created_by_id
            else None
        )
        actor = build_integration_actor(
            membership, scopes.permissions_for(credential.scopes), credential_id=credential.pk
        )
        if actor is None:
            return None
        if cache.add(f"apicred:used:{credential.pk}", 1, _LAST_USED_INTERVAL):
            credentials.filter(pk=credential.pk).update(last_used_at=now)
    return actor


class MachineCredentialMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if header[:12].lower() != "bearer keel_":
            return self.get_response(request)
        if not request.path.startswith(scopes.MACHINE_PATH_PREFIXES):
            return _problem(403, "machine_credential_not_allowed", "API credentials cannot be used on this endpoint.")
        if request.COOKIES.get(settings.SESSION_COOKIE_NAME):
            return _problem(400, "ambiguous_authentication", "Send either a session or an API credential, not both.")
        actor = authenticate_key(header[7:].strip())
        if actor is None:
            log.info("integrations.api_credential_rejected", path=request.path)
            return _problem(401, "invalid_credential", "The API credential is invalid, expired or revoked.")
        request.integration_actor = actor  # type: ignore[attr-defined]
        request.api_credential_id = actor.credential_id  # type: ignore[attr-defined]
        request.user = actor.user
        return self.get_response(request)


class MachineCredentialAuthentication(BaseAuthentication):
    """DRF side: a request the middleware authenticated is authenticated as its integration identity.

    Returning a user here (instead of letting SessionAuthentication run) also means no CSRF check applies:
    there is no cookie-based ambient authority for a browser to abuse.
    """

    def authenticate(self, request):
        actor = getattr(request._request, "integration_actor", None)
        if actor is None:
            return None
        return (actor.user, actor.credential_id)

    # No authenticate_header: DRF would then answer every unauthenticated *browser* request with 401 and a
    # Bearer challenge instead of the existing 403. Bad API credentials get their 401 from the middleware.
