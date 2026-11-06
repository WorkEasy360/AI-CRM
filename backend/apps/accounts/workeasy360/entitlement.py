"""Is this organization still entitled to WorkEasy CRM? Asked of Workeasy360 on a cadence, never assumed.

A Workeasy360 sign-in proves the organization held WorkEasy CRM at that moment; Keel's own session then lives
on (up to ``SESSION_COOKIE_AGE``). The Workeasy360 integration contract closes that gap (product
integration guide section 6, entitlement API): re-check on the advertised cadence and stop serving an
organization whose access has ended - a trial that ran out, a lapsed or cancelled subscription - within
that window, not whenever a session happens to expire.

- One answer per Workeasy360 organization and signed-in person (the ID token ``sub`` the person signed in
  with), shared by every process through the cache, for the provider's ``revalidate_after`` (900 s). Asking
  per person is how a removed member, a disabled account or an unassigned seat stops working within the
  window (``membership_inactive``, ``no_seat``) instead of when the session happens to end. A request with
  no Workeasy360 identity (a Keel-only account in a linked organization) and background work ask the
  organization alone. A denial is asked again sooner (``DENIAL_RECHECK_SECONDS``, or
  ``BACKGROUND_DENIAL_SECONDS`` for background work), so a renewal takes effect quickly.
- An outage (5xx, 429, timeout, network) is never a denial. The last known answer stands; with none,
  access continues - the provider's own rule, so an outage cannot lock out paying customers. After a
  failure the next attempt waits ``FAILURE_BACKOFF_SECONDS``.
- A refusal is not an outage: when Workeasy360 answers but refuses WorkEasy CRM's own client (400/401/403 - a
  revoked or wrong credential, a suspended integration), access is refused too
  (``workeasy360_access_unverified``), re-asked every ``DENIAL_RECHECK_SECONDS``. Keeping on serving would
  let every expired organization in for as long as nobody noticed.
- A known denial never lapses into access: it is kept without expiry, and every process also keeps its
  own copy of the last answers, so a cache outage or eviction cannot hand access back.
- A refusal is about WorkEasy CRM's client, not about one organization or person, so it is client-wide: for
  ``CLIENT_REFUSED_SECONDS`` after one, every question (a person's, an organization's, a job's) fails closed
  without being asked, and a 429 (Workeasy360 limits failed client authentications) within
  ``RATE_LIMIT_AFTER_REFUSAL_SECONDS`` of the last refusal counts as a refusal too, not as the outage it
  would otherwise be: the one question asked again after the window can still meet that limiter, and
  reading it as an outage would hand everyone their last answers back while the credential is revoked.
  Like a denial, the mark survives a cache outage (each process keeps its own).
- Only organizations linked to Workeasy360 are checked: a Keel-only organization has no Workeasy360
  entitlement to lose.
- Reads need ``allow``; writes also need ``write_allowed`` - a suspended subscription is read-only, so the
  customer can still see and export their data.

Enforced for every tenant API request by ``apps.authz.permissions.RequirePermissions``; the session and
sign-in endpoints stay reachable so the person can see why and sign out. Background jobs ask through
``apps.accounts.workeasy360.background``.
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import structlog
from celery.exceptions import SoftTimeLimitExceeded
from django.core.cache import cache
from rest_framework.exceptions import PermissionDenied

from apps.accounts.workeasy360 import config
from apps.accounts.workeasy360.oidc import SSOError
from apps.authz.actor import FEDERATED_SUBJECT_SESSION_KEY

log = structlog.get_logger(__name__)

#: Used when the provider names no cadence; also the longest an answer is trusted.
DEFAULT_REVALIDATE_SECONDS = 900
MIN_REVALIDATE_SECONDS = 30
#: A denial (or a refusal) is re-asked this soon, so an owner who renews is not kept out for the window.
DENIAL_RECHECK_SECONDS = 60
#: How long a refusal of WorkEasy CRM's own client closes every question (and how long a 429 is read as part of it).
CLIENT_REFUSED_SECONDS = 60
#: A 429 this soon after the last refusal (not only inside the mark above) is read as a refusal.
RATE_LIMIT_AFTER_REFUSAL_SECONDS = 300
#: After a failed check, how long before the provider is asked again (the last answer stands meanwhile).
FAILURE_BACKOFF_SECONDS = 60
#: A denial is trusted this long by background work: an expired organization's jobs must not each cost a
#: question a minute. (A refusal of WorkEasy CRM's own client is still re-asked every ``DENIAL_RECHECK_SECONDS``.)
BACKGROUND_DENIAL_SECONDS = 900
#: One request asks; the others use the last answer until it has.
REFRESH_LOCK_SECONDS = 15
#: How long a last ``allow`` is kept to stand in for the provider during an outage (a denial: forever).
LAST_KNOWN_KEEP_SECONDS = 7 * 24 * 3600
#: Bound on this process's own copy of the last answers.
LOCAL_MAX_ENTRIES = 10_000

ACCESS_ENDED = "workeasy360_access_ended"
ACCESS_UNVERIFIED = "workeasy360_access_unverified"
#: SSO-only, linked organization, and the signed-in account has no Workeasy360 identity to ask about.
SIGN_IN_REQUIRED = "workeasy360_sign_in_required"
READ_ONLY = "workeasy360_read_only"
#: The reason recorded when Workeasy360 refused WorkEasy CRM's own client.
REFUSED = "refused"
#: Reasons only a per-person answer carries: the person's own access ended, the organization's did not.
PERSON_REASONS = frozenset({"membership_inactive", "no_seat"})


@dataclass(frozen=True)
class Access:
    allowed: bool
    write_allowed: bool
    #: The provider's reason (``entitled``, ``expired``, ``not_entitled``, ``suspended``...), ``refused``
    #: when Workeasy360 refused WorkEasy CRM's client, or ``unchecked`` when no answer was ever available.
    reason: str


UNCHECKED = Access(allowed=True, write_allowed=True, reason="unchecked")

# This process's copy of the last answers and of its failure back-offs: the shared cache's stand-in when
# it is down (it then answers nothing) or has evicted an entry.
_local_lock = threading.Lock()
_local: OrderedDict[str, dict[str, Any]] = OrderedDict()
_local_backoff: dict[str, float] = {}
_local_refused_until = 0.0
_local_last_refusal = 0.0
_CLIENT_REFUSED_KEY = "workeasy360:entitlement:client_refused"
_LAST_REFUSAL_KEY = "workeasy360:entitlement:client_last_refusal"


def _key(workeasy360_organization_id: object, subject: str = "") -> str:
    """Cache key of one answer: the organization's, or (with ``subject``) one person's in it."""
    base = f"workeasy360:entitlement:{workeasy360_organization_id}"
    if not subject:
        return base
    # Hashed: a subject is the provider's string, and a cache key must be short and free of odd characters.
    return f"{base}:p:{hashlib.sha256(subject.encode()).hexdigest()[:32]}"


def _access(record: dict[str, Any]) -> Access:
    allowed = record.get("decision") == "allow"
    return Access(
        allowed=allowed,
        write_allowed=allowed and bool(record.get("write_allowed")),
        reason=str(record.get("reason", "")),
    )


def _fresh_for(answer: dict[str, Any]) -> int:
    if answer.get("decision") != "allow":
        return DENIAL_RECHECK_SECONDS
    try:
        seconds = int(answer.get("revalidate_after", DEFAULT_REVALIDATE_SECONDS))
    except (TypeError, ValueError):
        seconds = DEFAULT_REVALIDATE_SECONDS
    return max(MIN_REVALIDATE_SECONDS, min(seconds, DEFAULT_REVALIDATE_SECONDS))


def _last_known(key: str) -> dict[str, Any] | None:
    record = cache.get(key)
    if record:
        return record
    with _local_lock:
        return _local.get(key)


def _remember(key: str, record: dict[str, Any]) -> None:
    cache.set(key, record, None if record["decision"] != "allow" else LAST_KNOWN_KEEP_SECONDS)
    with _local_lock:
        _local[key] = record
        _local.move_to_end(key)
        while len(_local) > LOCAL_MAX_ENTRIES:
            _local.popitem(last=False)
        _local_backoff.pop(key, None)


def _backing_off(key: str, now: float) -> bool:
    if cache.get(f"{key}:backoff"):
        return True
    with _local_lock:
        return _local_backoff.get(key, 0) > now


def _back_off(key: str, now: float) -> None:
    cache.set(f"{key}:backoff", 1, FAILURE_BACKOFF_SECONDS)
    with _local_lock:
        _local_backoff[key] = now + FAILURE_BACKOFF_SECONDS


def _client_refused(now: float) -> bool:
    if cache.get(_CLIENT_REFUSED_KEY):
        return True
    with _local_lock:
        return _local_refused_until > now


def _recently_refused(now: float) -> bool:
    """Whether Workeasy360 refused the client (400/401/403, not merely 429) within the last few minutes."""
    at = cache.get(_LAST_REFUSAL_KEY)
    with _local_lock:
        local = _local_last_refusal
    return now - max(at if isinstance(at, (int, float)) else 0.0, local) < RATE_LIMIT_AFTER_REFUSAL_SECONDS


def _refuse_client(now: float, *, refusal: bool = True) -> None:
    """Close every question for ``CLIENT_REFUSED_SECONDS``. ``refusal`` False: a 429 read as a refusal, which
    extends the mark but does not move the anchor the 429 rule measures from."""
    global _local_refused_until, _local_last_refusal
    cache.set(_CLIENT_REFUSED_KEY, 1, CLIENT_REFUSED_SECONDS)
    if refusal:
        cache.set(_LAST_REFUSAL_KEY, now, RATE_LIMIT_AFTER_REFUSAL_SECONDS)
    with _local_lock:
        _local_refused_until = now + CLIENT_REFUSED_SECONDS
        if refusal:
            _local_last_refusal = now


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
    key = _key(workeasy360_id, subject)
    known = _last_known(key)
    now = time.time()
    if _client_refused(now):
        # Workeasy360 has just refused WorkEasy CRM's own client: nobody can be confirmed, so nobody is served.
        return Access(allowed=False, write_allowed=False, reason=REFUSED)
    if known and now - known.get("checked_at", 0) < _trusted_for(known, background):
        return _access(known)
    if _backing_off(key, now):
        # The provider failed a moment ago: the last answer stands, or (none yet) access continues.
        return _access(known) if known else UNCHECKED
    # True: this request asks. False: another one is asking - use the last answer if there is one, and
    # ask too if there is none (a first check is never waved through). None: the cache is down - ask.
    if cache.add(f"{key}:refreshing", 1, REFRESH_LOCK_SECONDS) is False and known:
        return _access(known)
    try:
        answer = config.get_client().verify_entitlement(str(workeasy360_id), subject or None)
    except SoftTimeLimitExceeded:
        # Celery's way of telling a task its time is up: not an outage of Workeasy360, and not ours to swallow.
        raise
    except Exception as exc:  # anything that is not an answer is handled below, never a 500
        rate_limited_after_refusal = (
            isinstance(exc, SSOError) and exc.code == "provider_rate_limited" and _recently_refused(time.time())
        )
        if (isinstance(exc, SSOError) and exc.code == "provider_refused") or rate_limited_after_refusal:
            # Workeasy360 answered and refused WorkEasy CRM's own client: not an outage. Fail closed, loudly - for
            # the whole client, not just this key.
            log.error(
                "workeasy360.entitlement_refused",
                detail=exc.detail if isinstance(exc, SSOError) else "",
                organization_id=str(organization_id),
                rate_limited=rate_limited_after_refusal,
            )
            _refuse_client(now, refusal=not rate_limited_after_refusal)
            record = {
                "decision": "deny",
                "reason": REFUSED,
                "write_allowed": False,
                "checked_at": now,
                "fresh_for": DENIAL_RECHECK_SECONDS,
            }
            _remember(key, record)
            return _access(record)
        # An outage: never a denial. Logged loudly enough to be noticed - while it lasts, access changes
        # made in Workeasy360 are not reaching WorkEasy CRM.
        # (A non-SSOError - an unreadable key file, a broken HTTP reply - is logged by its type only.)
        log.warning(
            "workeasy360.entitlement_unavailable",
            code=exc.code if isinstance(exc, SSOError) else type(exc).__name__,
            detail=exc.detail if isinstance(exc, SSOError) else "",
            organization_id=str(organization_id),
            last_known=known.get("decision") if known else None,
        )
        _back_off(key, now)
        return _access(known) if known else UNCHECKED
    finally:
        cache.delete(f"{key}:refreshing")
    record = {
        "decision": answer["decision"],
        "reason": str(answer.get("reason", ""))[:64],
        "write_allowed": bool(answer.get("write_allowed")),
        "checked_at": now,
        "fresh_for": _fresh_for(answer),
    }
    _remember(key, record)
    if not known or known.get("decision") != record["decision"] or known.get("reason") != record["reason"]:
        log.info(
            "workeasy360.entitlement_changed",
            organization_id=str(organization_id),
            decision=record["decision"],
            reason=record["reason"],
            per_person=bool(subject),
        )
    return _access(record)


def _trusted_for(known: dict[str, Any], background: bool) -> float:
    fresh = known.get("fresh_for", 0)
    if background and known.get("decision") != "allow" and known.get("reason") != REFUSED:
        return max(fresh, BACKGROUND_DENIAL_SECONDS)
    return fresh


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
    """Refuse the request when Workeasy360 says the organization's access to WorkEasy CRM - or, with
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
            detail="Sign in with Workeasy360 to keep using WorkEasy CRM.",
            code=SIGN_IN_REQUIRED,
        )
    access = access_for(organization, subject)
    if access is None:
        return
    if not access.allowed and access.reason == REFUSED:
        raise PermissionDenied(
            detail=(
                "WorkEasy CRM cannot confirm your organization's access with Workeasy360 at the moment. Try again"
                " in a few minutes; if this continues, contact support."
            ),
            code=ACCESS_UNVERIFIED,
        )
    if not access.allowed and access.reason in PERSON_REASONS:
        raise PermissionDenied(
            detail=("Your access to WorkEasy CRM in this organization has ended. Ask an administrator in Workeasy360."),
            code=ACCESS_ENDED,
        )
    if not access.allowed:
        raise PermissionDenied(
            detail="Your organization's access to WorkEasy CRM has ended. An owner can renew it in Workeasy360.",
            code=ACCESS_ENDED,
        )
    if write and not access.write_allowed:
        raise PermissionDenied(
            detail=(
                "Your organization's WorkEasy CRM subscription is read-only at the moment: you can view and export"
                " your data but not change it. An owner can resolve this in Workeasy360."
            ),
            code=READ_ONLY,
        )


def clear_local() -> None:
    """Forget this process's copy of the answers (tests; the shared cache is cleared separately)."""
    global _local_refused_until, _local_last_refusal
    with _local_lock:
        _local.clear()
        _local_backoff.clear()
        _local_refused_until = 0.0
        _local_last_refusal = 0.0
