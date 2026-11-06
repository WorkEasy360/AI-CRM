"""The two browser-facing steps of "Sign in with Workeasy360". Plain Django views, both top-level GET
navigations (the page's CSP allows no cross-origin fetch or form post, and none is needed).

``start``    keeps state, nonce and PKCE verifier in the session and redirects to Workeasy360.
             ``reauth=1`` ("Confirm it's you") asks Workeasy360 for a fresh sign-in (``prompt=login``)
             for the current organization, remembering which Workeasy360 account is signed in here.
``callback`` matches the returned state against the session, exchanges the code, verifies the ID token,
             provisions, signs the browser in and lands it in the organization the token names. For a
             "Confirm it's you" flow it also requires the ID token's ``auth_time`` to be no older than the
             flow (a round trip on a still-open Workeasy360 session is not a confirmation) and its ``sub``
             to be the account signed in here (another person's password confirms nothing about them).
``end_session`` sends the browser on to Workeasy360's sign-out confirmation ("sign out of Workeasy360
             too"); Keel's own session is ended by the frontend first.

CSRF: the callback is protected by state (bound to this browser's session), nonce (bound to the ID token)
and PKCE (bound to the code), as OAuth requires; Django's CSRF check does not apply to GET. The session
cookie is SameSite=Lax, so it accompanies the top-level navigation back from Workeasy360.

Failures redirect to ``/login?sso_error=<code>`` with a code from ``ERROR_CODES``; details go to the log.
"""

from __future__ import annotations

import hmac
import time
import uuid
from urllib.parse import parse_qs, urlsplit

import structlog
from allauth.account import signals as account_signals
from allauth.account.internal.flows.login import record_authentication
from allauth.core import ratelimit
from django.contrib.auth import login as django_login
from django.http import HttpRequest, HttpResponse, HttpResponseRedirect
from django.utils.http import url_has_allowed_host_and_scheme, urlencode
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

from apps.accounts.models import ExternalIdentity, User
from apps.accounts.session import set_active_membership
from apps.accounts.workeasy360 import config, provisioning
from apps.accounts.workeasy360.oidc import SSOError
from apps.audit import actions
from apps.audit import service as audit
from apps.authz.actor import FEDERATED_AAL_SESSION_KEY, FEDERATED_SUBJECT_SESSION_KEY

log = structlog.get_logger(__name__)

#: Pending sign-ins, keyed by nothing guessable: a short list of {state, nonce, verifier, ...}.
FLOWS_SESSION_KEY = "workeasy360_flows"
#: Two tabs may sign in at once; older pending flows beyond this are dropped.
MAX_PENDING_FLOWS = 5
#: Time allowed at Workeasy360 (sign-in, MFA, organization choice) before the flow is abandoned.
FLOW_TTL_SECONDS = 600
BACKEND = "allauth.account.auth_backends.AuthenticationBackend"
DEFAULT_NEXT = "/"
#: Session cookie the frontend sets (script-readable, no secret) when the person signs out of WorkEasy CRM, so that
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
        "not_entitled",  # the Workeasy360 organization has no WorkEasy CRM subscription
        "no_seat",  # the person has no WorkEasy CRM seat in that organization
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
    # Workeasy360 says WorkEasy CRM is not registered to use its sign-in (sign_in_mode local_only).
    "unauthorized_client": "unavailable",
    # Only answered to prompt=none, which Keel never sends; treated like a lapsed flow.
    "interaction_required": "expired",
    "invalid_scope": "unavailable",
    "server_error": "unavailable",
    "temporarily_unavailable": "unavailable",
}

# SSOError codes from the protocol client, mapped to the vocabulary above.
_CLIENT_ERRORS = {
    "provider_unavailable": "unavailable",
    "provider_misconfigured": "unavailable",
    "state_mismatch": "expired",
    "invalid_token": "refused",  # nosec B105 - error code, not a secret
    "invalid_request": "refused",
    "sign_in_refused": "refused",  # includes the routine invalid_grant: the message says "try again"
}


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
        authorization = config.get_client().authorization_request(
            organization_id=organization, prompt="login" if reauth else ""
        )
    except SSOError as exc:
        log.warning("workeasy360.start_failed", code=exc.code, detail=exc.detail)
        return _login_error(_CLIENT_ERRORS.get(exc.code, "unavailable"))
    now = time.time()
    flows = [f for f in request.session.get(FLOWS_SESSION_KEY, []) if now - f.get("at", 0) < FLOW_TTL_SECONDS]
    flows.append(
        {
            "state": authorization.state,
            "nonce": authorization.nonce,
            "verifier": authorization.code_verifier,
            "organization": organization,
            "next": _safe_next(request.GET.get("next")),
            "at": now,
            "reauth": reauth,
            "subject": subject,
        }
    )
    request.session[FLOWS_SESSION_KEY] = flows[-MAX_PENDING_FLOWS:]
    return HttpResponseRedirect(authorization.url)


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


def _pop_flow(request: HttpRequest, state: str) -> dict | None:
    """Remove and return the pending flow whose state matches (constant-time), if still fresh."""
    flows = request.session.get(FLOWS_SESSION_KEY, [])
    match = None
    remaining = []
    for flow in flows:
        if state and hmac.compare_digest(str(flow.get("state", "")).encode(), state.encode()):
            match = flow
        else:
            remaining.append(flow)
    if match is not None:
        request.session[FLOWS_SESSION_KEY] = remaining
    if match is None or time.time() - match.get("at", 0) >= FLOW_TTL_SECONDS:
        return None
    return match


def _fail(request: HttpRequest, code: str, detail: str = "") -> HttpResponseRedirect:
    log.warning("workeasy360.sign_in_failed", code=code, detail=detail)
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
    state = request.GET.get("state", "")[:512]
    flow = _pop_flow(request, state)  # popped first: a flow is good for one callback, whatever happens
    provider_error = request.GET.get("error")
    if provider_error:
        code = _PROVIDER_ERRORS.get(provider_error[:64], "refused")
        return _fail(request, code, f"provider returned error={provider_error[:64]!r}")
    if flow is None:
        return _fail(request, "expired", "no pending flow for this state")
    if not config.is_configured():
        return _fail(request, "unavailable", "not configured")
    try:
        client = config.get_client()
        raw_claims = client.complete(
            code=request.GET.get("code", "")[:2048],
            returned_state=state,
            expected_state=flow["state"],
            nonce=flow["nonce"],
            code_verifier=flow["verifier"],
        )
        claims = provisioning.read_claims(raw_claims)
        if flow.get("reauth") and flow.get("subject") and claims.subject != flow["subject"]:
            # Somebody else signed in at Workeasy360. That confirms nothing about the person signed in
            # here, and silently switching accounts in the middle of "Confirm it's you" would be worse:
            # refused, and the session here is left exactly as it was (still not recently confirmed).
            return _fail(request, "reauthentication_wrong_account", "a different Workeasy360 account answered")
        if flow.get("reauth") and not _fresh(raw_claims.get("auth_time"), since=flow["at"]):
            # "Confirm it's you" asked for a fresh sign-in (prompt=login); a token whose auth_time
            # predates the request proves only that a Workeasy360 session was still open.
            return _fail(request, "reauthentication_failed", "auth_time predates the confirmation request")
        if flow["organization"] and str(claims.organization_id) != flow["organization"]:
            # The launcher asked for one organization and the provider answered for another.
            raise SSOError("invalid_token", "organization_id differs from the requested organization")
        result = provisioning.provision(claims, issuer=client.issuer, request=request)
    except SSOError as exc:
        return _fail(request, _CLIENT_ERRORS.get(exc.code, exc.code), exc.detail)

    _sign_in(
        request,
        result.user,
        result.membership,
        aal=claims.aal,
        subject=claims.subject,
        auth_time=_auth_time(raw_claims),
    )
    response = HttpResponseRedirect(flow["next"] or DEFAULT_NEXT)
    for name in SIGNED_OUT_MARKER_COOKIES:
        response.delete_cookie(name, path="/", samesite="Lax")
    return response


#: Clock skew allowed between Workeasy360's auth_time and the moment the flow started here.
AUTH_TIME_LEEWAY_SECONDS = 30


def _auth_time(claims: dict) -> int | None:
    value = claims.get("auth_time")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _fresh(value: object, *, since: float) -> bool:
    """Whether Workeasy360 authenticated the person at or after ``since`` (epoch seconds)."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= since - AUTH_TIME_LEEWAY_SECONDS


def _sign_in(
    request: HttpRequest, user: User, membership, *, aal: int, subject: str, auth_time: int | None = None
) -> None:
    """Sign in exactly like a password login does (see services.register_with_invitation)."""
    # Rotates the session key (or flushes the session when another user was signed in).
    django_login(request, user, backend=BACKEND)
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
    """GET /api/auth/workeasy360/logout - "sign out of WorkEasy CRM and Workeasy360".

    The frontend ends Keel's own session first (allauth's session DELETE, a CSRF-protected write);
    this only sends the browser on to Workeasy360, which asks the person to confirm before signing
    anyone out and then returns them to the registered post-logout URI. It changes nothing here, so a
    link to it cannot sign anyone out of Keel. Without the setting, or if Workeasy360 advertises no
    end-session endpoint, it lands on the sign-in page.
    """
    if not config.sign_out_of_workeasy360_available():
        return HttpResponseRedirect("/login")
    try:
        target = config.get_client().end_session_url(post_logout_redirect_uri=config.post_logout_redirect_uri())
    except SSOError as exc:
        log.warning("workeasy360.end_session_failed", code=exc.code, detail=exc.detail)
        target = ""
    return HttpResponseRedirect(target or "/login")
