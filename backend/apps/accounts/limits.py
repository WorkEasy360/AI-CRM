"""Seat limits kept apart from authentication and membership logic.

The number of seats comes from the organization's edition and purchased licences
(``apps.billing.entitlements``); an organization may carry an explicit ``settings["max_users"]``
override (enterprise contracts). Invitation and membership code asks ``assert_seat_available`` and
never reads plan names itself.

A seat is taken by an active or suspended member and by every pending invitation, so an organization
cannot exceed its limit by sending invitations faster than people accept them.
"""

from __future__ import annotations

from django.utils import timezone

from apps.core.exceptions import DomainError


def seat_limit(organization) -> int | None:
    override = (organization.settings or {}).get("max_users")
    if isinstance(override, int) and override > 0:
        return override
    from apps.billing import entitlements

    return entitlements.resolve(organization).seat_limit


def seats_in_use(*, exclude_invitation_email: str | None = None) -> int:
    """Seats used by the organization bound to the current tenant context."""
    from apps.accounts.models import Invitation, Membership

    members = Membership.objects.filter(status__in=[Membership.Status.ACTIVE, Membership.Status.SUSPENDED]).count()
    pending = Invitation.objects.filter(
        accepted_at__isnull=True, revoked_at__isnull=True, expires_at__gt=timezone.now()
    )
    if exclude_invitation_email:
        pending = pending.exclude(email=exclude_invitation_email)
    return members + pending.count()


def assert_seat_available(organization, *, exclude_invitation_email: str | None = None) -> None:
    """Raise when one more seat would exceed the plan.

    Pass the invitee's email both when inviting (a previous pending invitation to the same address is
    replaced) and when accepting (the invitation being accepted turns into the membership), so the
    seat that invitation holds is not counted twice.
    """
    limit = seat_limit(organization)
    if limit is None:
        return
    used = seats_in_use(exclude_invitation_email=exclude_invitation_email)
    if used + 1 > limit:
        error = DomainError(
            "Your plan's user limit has been reached. Remove a user or upgrade the plan.",
            code="user_limit_reached",
            status_code=403,
        )
        error.extra = {
            "upgrade": {"kind": "limit", "metric": "users", "limit": limit, "used": used, "url": "/settings/billing"}
        }
        raise error
