"""Back-channel logout (OpenID Connect Back-Channel Logout 1.0), Keel's part.

The connector's receiver (``POST /api/auth/workeasy360/backchannel-logout``, see config/urls.py) verifies the
logout token, refuses replays and ends the Keel sessions its sign-ins opened:

- a token naming ``sid`` (one Workeasy360 sign-in, e.g. "sign out of this device"): the sessions that sign-in
  opened here, nothing else - the same person's other devices stay signed in;
- a token naming only ``sub`` ("sign out everywhere"): every session the connector recorded for that person.

Keel's sessions are older than the connector's records: a session opened before this release has none. So for
"sign out everywhere" Keel also revokes every session of the person itself (``services.revoke_user_sessions``:
the session salt is rotated, which ends any session however old, and allauth's tracked sessions are purged).
This runs inside the connector's transaction: if it fails, nothing is recorded and Workeasy360 is told to
deliver the token again.
"""

from __future__ import annotations

from typing import Any

import structlog
from django.dispatch import receiver
from workeasy360_sso.signals import backchannel_logout

from apps.accounts.models import ExternalIdentity
from apps.audit import actions
from apps.audit import service as audit

log = structlog.get_logger(__name__)

METHOD = "workeasy360_backchannel"


@receiver(backchannel_logout, dispatch_uid="keel.workeasy360.backchannel_logout")
def end_keel_sessions(
    sender: Any, *, request: Any, issuer: str, subject: str, sid: str, product_sessions: list, **kwargs: Any
) -> None:
    from apps.accounts.services import revoke_user_sessions

    for product_session in product_sessions:
        audit.record(
            actions.AUTH_LOGOUT,
            user=product_session.identity.user,
            organization_id=None,
            actor_type="system",
            metadata={"method": METHOD, "scope": "session"},
        )
    if sid or not subject:
        log.info("workeasy360.backchannel_logout", scope="session", sessions_ended=len(product_sessions))
        return
    identity = ExternalIdentity.objects.select_related("user").filter(issuer=issuer, subject=subject).first()
    if identity is None:
        log.info("workeasy360.backchannel_logout", scope="everywhere", user_found=False)
        return
    revoked = revoke_user_sessions(identity.user)
    audit.record(
        actions.AUTH_SESSIONS_REVOKED,
        user=identity.user,
        organization_id=None,
        actor_type="system",
        metadata={"method": METHOD, "sessions_revoked": revoked, "sessions_ended": len(product_sessions)},
    )
    log.info(
        "workeasy360.backchannel_logout",
        scope="everywhere",
        user_id=str(identity.user_id),
        sessions_revoked=revoked,
        sessions_ended=len(product_sessions),
    )
