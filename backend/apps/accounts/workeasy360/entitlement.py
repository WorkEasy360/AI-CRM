"""Is this organization still entitled to WorkEasyCRM? Asked of Workeasy360 on a cadence, never assumed.

A Workeasy360 sign-in proves the organization held WorkEasyCRM at that moment; Keel's own session then lives
on (up to ``SESSION_COOKIE_AGE``). The Workeasy360 integration contract closes that gap (product
integration guide section 6, entitlement API): re-check on the advertised cadence and stop serving an
organization whose access has ended - a trial that ran out, a lapsed or cancelled subscription - within
that window, not whenever a session happens to expire.

The question, its cache and its rules are the workeasy360-sso connector's (``workeasy360_sso.entitlements``);
this module decides *what* Keel asks and what it does with the answer:

- One answer per Workeasy360 organization and signed-in person (the ID token ``sub`` the person signed in
  with), shared by every process through the cache, for the provider's ``revalidate_after`` (900 s at most,
  30 s at least). Asking per person is how a removed member, a disabled account or an unassigned seat stops
  working within the window (``membership_inactive``, ``no_seat``) instead of when the session happens to end.
  A request with no Workeasy360 identity (a Keel-only account in a linked organization) and background work
  ask the organization alone. A denial is asked again sooner (``DENIAL_RECHECK_SECONDS``, or
  ``BACKGROUND_DENIAL_SECONDS`` for background work), so a renewal takes effect quickly.
- An outage (5xx, 429, timeout, network, anything that is not an answer) is never a denial. The last known
  answer stands; with none, access continues - the provider's own rule, so an outage cannot lock out paying
  customers. After a failure the next attempt, from any process, waits ``FAILURE_BACKOFF_SECONDS``.
- A refusal is not an outage: when Workeasy360 answers but refuses WorkEasyCRM's own client (400/401/403 - a
  revoked or wrong credential, a suspended integration), access is refused too
  (``workeasy360_access_unverified``), re-asked every ``DENIAL_RECHECK_SECONDS``. It is client-wide: for
  ``CLIENT_REFUSED_SECONDS`` every question fails closed without being asked, and a 429 within
  ``RATE_LIMIT_AFTER_REFUSAL_SECONDS`` of the last refusal counts as a refusal (extending the mark, not moving
  the moment the window is measured from).
- A known denial never lapses into access: it is kept without expiry, and every process also keeps its own
  copy of the last answers, so a cache outage or eviction cannot hand access back.
- Only organizations linked to Workeasy360 are checked: a Keel-only organization has no Workeasy360
  entitlement to lose.
- Reads need ``allow``; writes also need ``write_allowed`` - a suspended subscription is read-only, so the
  customer can still see and export their data.

Enforced for every tenant API request by ``apps.authz.permissions.RequirePermissions``; the session and
sign-in endpoints stay reachable so the person can see why and sign out. Background jobs ask through
``apps.accounts.workeasy360.background``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import structlog
from django.dispatch import receiver
from rest_framework.exceptions import PermissionDenied
from workeasy360_sso import entitlements as connector
from workeasy360_sso.signals import entitlement_checked

from apps.accounts.workeasy360 import config
from apps.authz.actor import FEDERATED_SUBJECT_SESSION_KEY

log = structlog.get_logger(__name__)

#: Used when the provider names no cadence; also the longest an answer is trusted.
DEFAULT_REVALIDATE_SECONDS = connector.MAX_ALLOW_TTL
MIN_REVALIDATE_SECONDS = connector.MIN_ALLOW_TTL
#: A denial (or a refusal) is re-asked this soon, so an owner who renews is not kept out for the window.
DENIAL_RECHECK_SECONDS = connector.PERSON_DENY_RECHECK
#: How long a refusal of WorkEasyCRM's own client closes every question.
CLIENT_REFUSED_SECONDS = connector.CLIENT_REFUSAL_HOLD
#: A 429 this soon after the last refusal (not only inside the mark above) is read as a refusal.
RATE_LIMIT_AFTER_REFUSAL_SECONDS = connector.REFUSAL_429_WINDOW
#: After a failed check, how long before the provider is asked again (the last answer stands meanwhile).
FAILURE_BACKOFF_SECONDS = connector.OUTAGE_BACKOFF
#: A denial is trusted this long by background work: an expired organization's jobs must not each cost a
#: question a minute. (A refusal of WorkEasyCRM's own client is still re-asked every ``DENIAL_RECHECK_SECONDS``.)
BACKGROUND_DENIAL_SECONDS = connector.BACKGROUND_DENY_RECHECK

ACCESS_ENDED = connector.ACCESS_ENDED
ACCESS_UNVERIFIED = connector.ACCESS_UNVERIFIED
#: SSO-only, linked organization, and the signed-in account has no Workeasy360 identity to ask about.
SIGN_IN_REQUIRED = "workeasy360_sign_in_required"
READ_ONLY = connector.READ_ONLY
#: The reason recorded when Workeasy360 refused WorkEasyCRM's own client.
REFUSED = "refused"
#: Reasons only a per-person answer carries: the person's own access ended, the organization's did not.
PERSON_REASONS = frozenset({"membership_inactive", "no_seat"})


@dataclass(frozen=True)
class Access:
    allowed: bool
    write_allowed: bool
    #: The provider's reason (``entitled``, ``expired``, ``not_entitled``, ``suspended``...), ``refused``
    #: when Workeasy360 refused WorkEasyCRM's client, or ``unchecked`` when no answer was ever available.
    reason: str


UNCHECKED = Access(allowed=True, write_allowed=True, reason="unchecked")


def _access(decision: connector.AccessDecision) -> Access:
    if decision.provisional:
        return UNCHECKED
    if decision.code == connector.ACCESS_UNVERIFIED:
        return Access(allowed=False, write_allowed=False, reason=REFUSED)
    return Access(
        allowed=decision.allowed, write_allowed=decision.allowed and decision.write_allowed, reason=decision.reason
    )


def access_for(organization, subject: str = "", *, background: bool = False) -> Access | None:
    """Workeasy360's current answer for ``organization`` (and, with ``subject``, for that person in it), or
    None when it is not linked to Workeasy360 (or Workeasy360 sign-in is not configured here): there is
    nothing to check."""
    workeasy360_id = getattr(organization, "workeasy360_organization_id", None)
    if not workeasy360_id:
        return None
    return check(workeasy360_id, organization_id=organization.pk, subject=subject, background=background)


def check(
    workeasy360_id: object, *, organization_id: object, subject: str = "", background: bool = False
) -> Access | None:
    """The cached-or-asked answer for one Workeasy360 organization (and person). ``organization_id`` is
    this system's id for it, for logs only. ``background``: a denial is trusted for
    ``BACKGROUND_DENIAL_SECONDS``, not ``DENIAL_RECHECK_SECONDS`` (nobody is waiting on a renewal)."""
    if not workeasy360_id or not config.is_configured():
        return None
    decision = connector.check(
        config.connector(),
        organization_id=uuid.UUID(str(workeasy360_id)),
        subject=subject or None,
        background=background,
        context={"organization_id": str(organization_id)},
    )
    return _access(decision)


def stored_answer(workeasy360_id: object, subject: str = "") -> connector.Answer | None:
    """The last answer known for this organization (and person), however old; for tests and support."""
    return connector.last_answer(
        config.connector(), organization_id=uuid.UUID(str(workeasy360_id)), subject=subject or None
    )


@receiver(entitlement_checked, dispatch_uid="keel.workeasy360.entitlement_log")
def _log_question(
    sender: Any,
    *,
    organization_id: uuid.UUID,
    subject: str,
    outcome: str,
    answer: connector.Answer | None,
    previous: connector.Answer | None,
    detail: str,
    rate_limited: bool,
    context: dict[str, Any] | None,
    **kwargs: Any,
) -> None:
    """Keel's log lines for every question actually put to Workeasy360 (never for a cached answer)."""
    keel_organization = (context or {}).get("organization_id") or str(organization_id)
    if outcome == "refused":
        # Workeasy360 answered and refused WorkEasyCRM's own client: not an outage. Fail closed, loudly - for
        # the whole client, not just this key.
        log.error(
            "workeasy360.entitlement_refused",
            detail=detail,
            organization_id=keel_organization,
            rate_limited=rate_limited,
        )
    elif outcome == "outage":
        # An outage: never a denial. Logged loudly enough to be noticed - while it lasts, access changes
        # made in Workeasy360 are not reaching WorkEasyCRM.
        log.warning(
            "workeasy360.entitlement_unavailable",
            code="provider_unavailable",
            detail=detail,
            organization_id=keel_organization,
            last_known=previous.decision if previous else None,
        )
    elif answer is not None and (
        previous is None or previous.decision != answer.decision or previous.reason != answer.reason
    ):
        log.info(
            "workeasy360.entitlement_changed",
            organization_id=keel_organization,
            decision=answer.decision,
            reason=answer.reason,
            per_person=bool(subject),
        )


def subject_for_session(session, user, organization) -> str:
    """The Workeasy360 ``sub`` this session's person is asked about in ``organization``: "" when there is
    none (a Keel-only account, an organization not linked to Workeasy360, or sign-in not configured).

    Sign-in puts it on the session, so a request costs no query; a session without it (a password
    session, or one older than this) looks it up once and remembers the answer, "" included."""
    if not getattr(organization, "workeasy360_organization_id", None) or not config.is_configured():
        return ""
    remembered = session.get(FEDERATED_SUBJECT_SESSION_KEY)
    if isinstance(remembered, str):
        return remembered
    from apps.accounts.models import ExternalIdentity

    subject = (
        ExternalIdentity.objects.filter(user_id=user.pk, issuer=config.issuer())
        .values_list("subject", flat=True)
        .first()
    ) or ""
    session[FEDERATED_SUBJECT_SESSION_KEY] = subject
    return subject


def require(organization, *, write: bool, subject: str = "", person_required: bool = False) -> None:
    """Refuse the request when Workeasy360 says the organization's access to WorkEasyCRM - or, with
    ``subject``, this person's access in it - has ended (or will not confirm it), or that it is read-only
    and this is a write.

    ``person_required``: a person's request (not an API credential's). When Workeasy360 is the only way in
    (``WORKEASY360_SSO_ONLY``) and the organization is linked, an account with no Workeasy360 identity
    cannot be asked about, so it is not served on the organization's answer: it is sent to sign in with
    Workeasy360 (which links it by verified e-mail, after which it is checked per person). This closes a
    session opened before SSO-only was switched on, and a Keel-only account in a linked organization."""
    if (
        person_required
        and not subject
        and getattr(organization, "workeasy360_organization_id", None)
        and config.is_configured()
        and config.sso_only()
    ):
        raise PermissionDenied(
            detail="Sign in with Workeasy360 to keep using WorkEasyCRM.",
            code=SIGN_IN_REQUIRED,
        )
    access = access_for(organization, subject)
    if access is None:
        return
    if not access.allowed and access.reason == REFUSED:
        raise PermissionDenied(
            detail=(
                "WorkEasyCRM cannot confirm your organization's access with Workeasy360 at the moment. Try again"
                " in a few minutes; if this continues, contact support."
            ),
            code=ACCESS_UNVERIFIED,
        )
    if not access.allowed and access.reason in PERSON_REASONS:
        raise PermissionDenied(
            detail=("Your access to WorkEasyCRM in this organization has ended. Ask an administrator in Workeasy360."),
            code=ACCESS_ENDED,
        )
    if not access.allowed:
        raise PermissionDenied(
            detail="Your organization's access to WorkEasyCRM has ended. An owner can renew it in Workeasy360.",
            code=ACCESS_ENDED,
        )
    if write and not access.write_allowed:
        raise PermissionDenied(
            detail=(
                "Your organization's WorkEasyCRM subscription is read-only at the moment: you can view and export"
                " your data but not change it. An owner can resolve this in Workeasy360."
            ),
            code=READ_ONLY,
        )


def clear_local() -> None:
    """Forget this process's copy of the answers (tests; the shared cache is cleared separately)."""
    connector.reset_state()
