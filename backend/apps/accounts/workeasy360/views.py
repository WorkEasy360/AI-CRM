"""The browser-facing steps of "Sign in with Workeasy360". Plain Django views, top-level GET navigations
(the page's CSP allows no cross-origin fetch or form post, and none is needed). The protocol is the
workeasy360-sso connector's (``workeasy360_sso.api``); these views keep Keel's routes, rules and error
vocabulary around it.

``start``    asks the connector to begin a sign-in: a single-use flow (state, nonce, PKCE verifier) kept
             server-side and bound to this browser by a cookie, so several tabs can sign in at once.
             ``reauth=1`` ("Confirm it's you") asks Workeasy360 for a fresh sign-in (``prompt=login``) for the
             current organization, naming the Workeasy360 account signed in here.
``callback`` asks the connector to finish it: the flow is spent first, the code exchanged with a
             ``private_key_jwt`` client assertion, the ID token verified offline, the organization binding and
             product checked; Keel's adapters (``provisioning``) then resolve the user, organization and
             membership, and the connector signs the browser in with a new session id. This view adds what
             Keel records about a sign-in and lands the browser in the organization the token names. For
             "Confirm it's you" the ID token's ``sub`` must be the account signed in here and its
             ``auth_time`` no older than the request.
``end_session`` sends the browser on to Workeasy360's sign-out confirmation ("sign out of Workeasy360
             too"); Keel's own session is ended by the frontend first.

Back-channel logout (``POST /api/auth/workeasy360/backchannel-logout``) is the connector's own receiver,
mounted in config/urls.py; ``backchannel`` adds Keel's "sign out everywhere".

Failures redirect to ``/login?sso_error=<code>`` with a code from ``ERROR_CODES``; details go to the log.
"""

from __future__ import annotations

import uuid
from urllib.parse import parse_qs, urlsplit

import structlog
from allauth.account import signals as account_signals
from allauth.account.internal.flows.login import record_authentication
from allauth.core import ratelimit
from django.http import HttpRequest, HttpResponse, HttpResponseRedirect
from django.utils.http import url_has_allowed_host_and_scheme, urlencode
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET
from workeasy360_sso import api
from workeasy360_sso.errors import (
    STAGE_AUTHORIZATION,
    STAGE_BINDING,
    STAGE_ID_TOKEN,
    STAGE_REAUTHENTICATION,
    STAGE_TOKEN,
    SignInRefused,
)

from apps.accounts.models import ExternalIdentity, User
from apps.accounts.session import set_active_membership
from apps.accounts.workeasy360 import config, provisioning
from apps.audit import actions
from apps.audit import service as audit
from apps.authz.actor import FEDERATED_AAL_SESSION_KEY, FEDERATED_SUBJECT_SESSION_KEY

log = structlog.get_logger(__name__)

DEFAULT_NEXT = "/"
#: Session cookie the frontend sets (script-readable, no secret) when the person signs out of WorkEasyCRM, so that
#: opening the product directly shows the sign-in page instead of starting a Workeasy360 sign-in by itself
#: (Workeasy360 integration guide 6b). Named like the CSRF cookie: ``__Host-`` over https (no sibling subdomain
#: can set or shadow it), plain over http. A successful sign-in clears both. Keep equal to the names in
#: frontend/src/lib/direct-sign-in.ts.
SIGNED_OUT_MARKER_COOKIES = ("__Host-keel_signed_out", "keel_signed_out")

#: The only values ``sso_error`` ever takes. The frontend maps each to a message.
ERROR_CODES = frozenset(
    {
        "cancelled",  # the user declined at Workeasy360
        "expired",  # the flow is unknown, used or too old, or Workeasy360 asks to start again
        "unavailable",  # Workeasy360 unreachable, misconfigured on either side, or not configured here
        "refused",  # the response failed verification or Workeasy360 refused for an unlisted reason
        "rate_limited",
        "not_entitled",  # the Workeasy360 organization has no WorkEasyCRM subscription
        "no_seat",  # the person has no WorkEasyCRM seat in that organization
        "provider_membership_inactive",  # their Workeasy360 membership is suspended or removed
        "organization_inactive",  # the Workeasy360 organization is suspended
        "access_policy",  # a Workeasy360 access policy (network, MFA, ...) denied the sign-in
        "email_missing",
        "email_unverified",
        "account_conflict",  # the Keel account for this address is linked to another Workeasy360 account
        "account_disabled",  # the Keel account is deactivated
        "membership_inactive",  # a Keel admin suspended or removed the person from this organization
        "organization_unavailable",  # the Keel organization is suspended or being deleted
        "seat_limit",  # the Keel organization's plan has no free seat
        "wrong_product",
        "reauthentication_failed",  # "Confirm it's you" came back without a fresh Workeasy360 sign-in
        "reauthentication_wrong_account",  # ... or signed in as a different Workeasy360 account
    }
)

# OAuth ``error`` values Workeasy360's authorization endpoint redirects back with.
_PROVIDER_ERRORS = {
    "access_denied": "cancelled",
    "login_required": "expired",
    "organization_required": "expired",
    "product_not_entitled": "not_entitled",
    "product_no_seat": "no_seat",
    "membership_inactive": "provider_membership_inactive",
    "organization_inactive": "organization_inactive",
    "access_policy_denied": "access_policy",
    "integration_suspended": "unavailable",
    # Workeasy360 says WorkEasyCRM is not registered to use its sign-in (sign_in_mode local_only).
    "unauthorized_client": "unavailable",
    # Only answered to prompt=none, which Keel never sends; treated like a lapsed flow.
    "interaction_required": "expired",
    "invalid_scope": "unavailable",
    "server_error": "unavailable",
    "temporarily_unavailable": "unavailable",
}


def error_code(refusal: SignInRefused) -> str:
    """The connector's refusal in Keel's vocabulary (``ERROR_CODES``), which the frontend already maps."""
    if refusal.stage == STAGE_AUTHORIZATION:
        return _PROVIDER_ERRORS.get(refusal.provider_error, "refused")
    if refusal.stage == STAGE_TOKEN:
        # Unreachable, a server error or "temporarily unavailable" is an outage; any other answer from the token
        # endpoint (the routine invalid_grant included: the message says "try again") is a refusal.
        status = refusal.http_status
        if status is None or status >= 500 or refusal.provider_error == "temporarily_unavailable":
            return "unavailable"
        return "refused"
    if refusal.stage == STAGE_ID_TOKEN:
        return "unavailable" if refusal.code == "unavailable" else "refused"
    if refusal.stage == STAGE_REAUTHENTICATION:
        if refusal.reason == "different_subject":
            return "reauthentication_wrong_account"
        return "reauthentication_failed"
    if refusal.stage == STAGE_BINDING:
        if refusal.code == "session_ended":
            # The Workeasy360 session this sign-in came from was signed out meanwhile: start again.
            return "expired"
        if refusal.code == "wrong_organization":
            # The launcher asked for one organization and the provider answered for another.
            return "refused"
    return refusal.code if refusal.code in ERROR_CODES else "refused"


def _login_error(code: str) -> HttpResponseRedirect:
    if code not in ERROR_CODES:
        code = "refused"
    return HttpResponseRedirect("/login?" + urlencode({"sso_error": code}))


def _safe_next(value: str | None) -> str:
    """A same-site path to land on after sign-in, or "/". Never another host, never an auth page."""
    if not value or len(value) > 2048 or not value.startswith("/") or value.startswith(("//", "/\\")):
        return DEFAULT_NEXT
    if "\\" in value or any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return DEFAULT_NEXT
    if not url_has_allowed_host_and_scheme(value, allowed_hosts=None, require_https=False):
        return DEFAULT_NEXT
    if value.startswith(("/api/", "/_allauth/", "/login", "/signup", "/forgot-password", "/reset-password")):
        return DEFAULT_NEXT
    parts = urlsplit(value)
    if "organization" in parse_qs(parts.query):
        # The frontend sends any page carrying ?organization= back into this flow (the launcher entry
        # point); landing on one would loop.
        return parts.path or DEFAULT_NEXT
    return value


def _clean_uuid(value: str | None) -> str:
    try:
        return str(uuid.UUID(value)) if value else ""
    except ValueError:
        return ""


@never_cache
@require_GET
def start(request: HttpRequest) -> HttpResponse:
    """GET /api/auth/workeasy360/start?organization=<uuid>&next=<path>"""
    if not config.is_configured():
        return _login_error("unavailable")
    if not ratelimit.consume(request, action="login"):
        return _login_error("rate_limited")
    organization = _clean_uuid(request.GET.get("organization"))
    reauth = request.GET.get("reauth") == "1"
    subject = ""
    if reauth:
        # "Confirm it's you" is about the person and the organization already here: Workeasy360 is asked
        # for this organization (so it shows no organization chooser), and the callback insists that the
        # same Workeasy360 account answers.
        organization, subject = _current_federation(request)
        if not subject:
            # Nobody here is linked to a Workeasy360 account (not signed in, or a Keel-only account):
            # there is no one Workeasy360 could confirm, and an unbound confirmation would only sign in
            # whoever answered.
            return _login_error("reauthentication_failed")
    try:
        return api.begin_sign_in(
            request,
            next_path=_safe_next(request.GET.get("next")),
            organization=organization or None,
            prompt="login" if reauth else "",
            reauth_subject=subject,
        )
    except SignInRefused as refusal:
        log.warning("workeasy360.start_failed", code=refusal.code, detail=refusal.log_reason)
        return _login_error(error_code(refusal))


def _current_federation(request: HttpRequest) -> tuple[str, str]:
    """(Workeasy360 organization id, Workeasy360 subject) of the signed-in person in their current
    organization, each "" when there is none (not signed in, a Keel-only organization or account)."""
    user = getattr(request, "user", None)
    if user is None or not user.is_authenticated:
        return "", ""
    actor = getattr(request, "actor", None)
    linked = getattr(getattr(actor, "organization", None), "workeasy360_organization_id", None)
    subject = (
        ExternalIdentity.objects.filter(user=user, issuer=config.issuer()).values_list("subject", flat=True).first()
    )
    return (str(linked) if linked else ""), (subject or "")


def _fail(request: HttpRequest, code: str, detail: str = "", stage: str = "") -> HttpResponseRedirect:
    log.warning("workeasy360.sign_in_failed", code=code, detail=detail, stage=stage)
    audit.record(
        actions.AUTH_LOGIN_FAILED,
        request=request,
        organization_id=None,
        actor_type="system",
        metadata={"method": "workeasy360", "reason": code},
    )
    return _login_error(code)


@never_cache
@require_GET
def callback(request: HttpRequest) -> HttpResponse:
    """GET /api/auth/callback/workeasy360?code=...&state=...  (or ?error=...&state=...)"""
    try:
        # A confirmation is a full sign-in of the same person, so allauth's authentication log gets the
        # fresh record (with its auth_time) that apps.authz.reauth looks for.
        result = api.complete_sign_in(request, reauthentication=api.REAUTH_SIGN_IN)
    except SignInRefused as refusal:
        return _fail(request, error_code(refusal), refusal.log_reason, refusal.stage)

    claims = provisioning.read_claims(result.claims)
    _sign_in(
        request,
        result.user,
        result.binding,
        aal=claims.aal,
        subject=claims.subject,
        auth_time=_auth_time(result.claims),
    )
    response = HttpResponseRedirect(result.flow.next_path or DEFAULT_NEXT)
    for name in SIGNED_OUT_MARKER_COOKIES:
        response.delete_cookie(name, path="/", samesite="Lax")
    return response


def _auth_time(claims: dict) -> int | None:
    value = claims.get("auth_time")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _sign_in(request: HttpRequest, user, membership, *, aal: int, subject: str, auth_time: int | None = None) -> None:
    """Record the sign-in exactly like a password login does (see services.register_with_invitation).

    The connector has already called Django's ``login()`` (allauth's backend, a new session key - or a flushed
    session when another person was signed in here) and recorded the session for back-channel logout."""
    request.session[FEDERATED_AAL_SESSION_KEY] = aal
    # The person Workeasy360 is asked about while this session lasts (entitlement.py), without a query per request.
    request.session[FEDERATED_SUBJECT_SESSION_KEY] = subject
    # ``auth_time``: when the person last entered their password at Workeasy360, which is what
    # "recently authenticated" means for a federated session (apps.authz.reauth) - not the moment
    # this callback ran.
    record_authentication(
        request, user, method=config.AUTH_METHOD, issuer=config.issuer(), aal=aal, auth_time=auth_time
    )
    # Keel's login hook picks the most recently active membership -- the one provisioning just touched --
    # writes the login audit event and checks for a new device.
    account_signals.user_logged_in.send(
        sender=User, request=request, response=None, user=user, auth_method=config.AUTH_METHOD, aal=aal
    )
    set_active_membership(request, membership)


@never_cache
@require_GET
def end_session(request: HttpRequest) -> HttpResponse:
    """GET /api/auth/workeasy360/logout - "sign out of WorkEasyCRM and Workeasy360".

    The frontend ends Keel's own session first (allauth's session DELETE, a CSRF-protected write);
    this only sends the browser on to Workeasy360, which asks the person to confirm before signing
    anyone out and then returns them to the registered post-logout URI. It changes nothing here, so a
    link to it cannot sign anyone out of Keel. Without the setting, or if Workeasy360 advertises no
    end-session endpoint, it lands on the sign-in page.
    """
    if not config.sign_out_of_workeasy360_available():
        return HttpResponseRedirect("/login")
    target = api.end_session_url(config.connector())
    if not target:
        log.warning("workeasy360.end_session_failed", detail="no end_session_endpoint or discovery unavailable")
    return HttpResponseRedirect(target or "/login")
