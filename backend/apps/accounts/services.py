"""Business logic for organizations, memberships and invitations. Views never bypass this module."""

from __future__ import annotations

import hashlib
import secrets
import uuid
import zoneinfo
from datetime import timedelta

from allauth.usersessions.models import UserSession
from django.conf import settings
from django.db import transaction
from django.http import Http404
from django.utils import timezone
from django.utils.text import slugify
from rest_framework.exceptions import PermissionDenied

from apps.accounts import emails, limits
from apps.accounts.models import Invitation, Membership, Organization, User
from apps.accounts.session import set_active_membership
from apps.audit import actions
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.models import Role
from apps.authz.reauth import require_recent_auth
from apps.authz.roles import ADMIN, ASSIGNABLE_BY_ADMIN, OWNER, SYSTEM_ROLES
from apps.authz.service import check
from apps.core import validators
from apps.core.exceptions import ConflictError, DomainError
from apps.core.tenancy.context import get_context, set_db_user, system_context, tenant_context
from apps.core.tenancy.middleware import ACTIVE_MEMBERSHIP_KEY

# ----------------------------------------------------------------------------- helpers

# Roles whose grant (by invitation or role change) requires a recent re-authentication.
PRIVILEGED_ROLES = frozenset({OWNER, ADMIN})


def _system_role(key: str) -> Role:
    return Role.objects.get(key=key, is_system=True, organization__isnull=True)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _unique_slug(name: str) -> str:
    base = slugify(name)[:40] or "org"
    for _ in range(10):
        candidate = f"{base}-{secrets.token_hex(3)}"
        if not Organization.objects.filter(slug=candidate).exists():
            return candidate
    raise ConflictError("Could not allocate an organization slug.")


def _validate_currency(code: str) -> str:
    code = (code or "").strip().upper()
    if len(code) != 3 or not code.isalpha():
        raise DomainError("base_currency must be a 3-letter ISO 4217 code.", code="invalid_currency")
    return code


def _validate_timezone(name: str) -> str:
    name = (name or "").strip()
    if name not in zoneinfo.available_timezones():
        raise DomainError("Unknown timezone.", code="invalid_timezone")
    return name


def _assert_can_assign_role(actor: Actor, role_key: str) -> Role:
    if role_key not in SYSTEM_ROLES:
        raise DomainError("Unknown role.", code="invalid_role")
    if actor.role_key == OWNER:
        return _system_role(role_key)
    if actor.role_key == ADMIN and role_key in ASSIGNABLE_BY_ADMIN:
        return _system_role(role_key)
    raise PermissionDenied(code="permission_denied")


def _active_owner_count() -> int:
    return Membership.objects.active().filter(role__key=OWNER, role__is_system=True).count()


# ----------------------------------------------------------------------------- organizations


def create_organization(
    user: User,
    *,
    name: str,
    base_currency: str = "INR",
    timezone_name: str = "Asia/Kolkata",
    request=None,
    source: str = "user",
) -> Membership:
    name = (name or "").strip()
    if not name:
        raise DomainError("Organization name is required.", code="invalid_name")
    base_currency = _validate_currency(base_currency)
    timezone_name = _validate_timezone(timezone_name)

    with system_context(reason="organization.create"), transaction.atomic():
        owned = Membership.identity.for_user(user).active().filter(role__key=OWNER).count()
        if owned >= settings.MAX_ORGANIZATIONS_PER_USER:
            raise DomainError(
                "Organization limit reached for this account.", code="organization_limit", status_code=403
            )
        org = Organization.objects.create(
            name=name, slug=_unique_slug(name), base_currency=base_currency, timezone=timezone_name
        )
    with tenant_context(org.pk, user_id=user.pk, reason="organization.create"):
        membership = Membership.objects.create(user=user, role=_system_role(OWNER), joined_at=timezone.now())
        membership.organization = org  # cache the relation: outside a context RLS hides the row
        audit.record(
            actions.ORG_CREATED, request=request, user=user, resource=org, metadata={"name": name, "source": source}
        )
        # Every organization starts with a usable sales pipeline (Phase 2).
        from apps.pipelines.services import ensure_default_pipeline

        ensure_default_pipeline()
    if request is not None:
        request.session.cycle_key()
        set_active_membership(request, membership)
    return membership


# ----------------------------------------------------------------------------- automatic onboarding


def personal_organization_name(user: User) -> str:
    """Display name of the workspace created for a new account; the owner can rename it in Settings."""
    base = (user.first_name or "").strip() or user.email.split("@", 1)[0]
    base = " ".join(base.split())[:100] or "My"
    return f"{base}'s workspace"


def ensure_personal_organization(user: User) -> Membership | None:
    """Create the user's own workspace the first time they need one. Idempotent and race-safe.

    Called after email verification and again on every login as a fallback (accounts verified
    before this existed). Nothing about the organization comes from the client: name, defaults,
    owner role and the default pipeline are all decided here.

    Concurrency: the user row is locked for the duration of the transaction, so two overlapping
    callers (double verification callback, a refreshed login, a retried bootstrap request) serialize
    and the second one sees the membership the first one committed. Any failure inside rolls the
    whole workspace back: no organization without its owner membership and default pipeline.

    Returns the new owner membership, or None when the user already belongs to an organization.
    """
    with system_context(reason="organization.auto_create"), transaction.atomic():
        locked = User.objects.select_for_update().get(pk=user.pk)
        if not locked.is_active:
            return None
        if Membership.identity.for_user(locked).exists():
            return None
        return create_organization(
            locked,
            name=personal_organization_name(locked),
            base_currency=settings.DEFAULT_ORGANIZATION_CURRENCY,
            timezone_name=settings.DEFAULT_ORGANIZATION_TIMEZONE,
            source="auto",
        )


def bootstrap_session(request, user: User) -> Membership | None:
    """Make sure the signed-in user has somewhere to land: a workspace and an active membership.

    Used by the login signal and by ``POST /session/bootstrap/`` for sessions that have no active
    organization. Idempotent: an existing active membership is simply (re)activated.
    """
    from apps.accounts.session import pick_default_membership

    ensure_personal_organization(user)
    set_db_user(user.pk)
    membership = pick_default_membership(user)
    if membership is not None and request is not None:
        current = request.session.get(ACTIVE_MEMBERSHIP_KEY)
        if current != str(membership.pk):
            request.session.cycle_key()
        set_active_membership(request, membership)
    return membership


def update_organization(actor: Actor, *, request=None, **changes) -> Organization:
    check(actor, "org.update")
    require_recent_auth(request)
    org = Organization.objects.get(pk=actor.organization.pk)
    changed: dict[str, object] = {}
    if "name" in changes and changes["name"] is not None:
        name = changes["name"].strip()
        if not name:
            raise DomainError("Organization name is required.", code="invalid_name")
        org.name = name
        changed["name"] = name
    if "base_currency" in changes and changes["base_currency"] is not None:
        org.base_currency = changed["base_currency"] = _validate_currency(changes["base_currency"])
    if "timezone" in changes and changes["timezone"] is not None:
        org.timezone = changed["timezone"] = _validate_timezone(changes["timezone"])
    if "require_mfa" in changes and changes["require_mfa"] is not None:
        org.settings = {**org.settings, "require_mfa": bool(changes["require_mfa"])}
        changed["require_mfa"] = bool(changes["require_mfa"])
    if changed:
        org.save(update_fields=["name", "base_currency", "timezone", "settings", "updated_at"])
        audit.record(actions.ORG_UPDATED, request=request, user=actor.user, resource=org, metadata=changed)
    return org


def switch_organization(request, user: User, membership_id: uuid.UUID) -> Membership:
    membership = (
        Membership.identity.for_user(user)
        .active()
        .filter(pk=membership_id, organization__status=Organization.Status.ACTIVE)
        .select_related("organization", "role")
        .first()
    )
    if membership is None:
        raise Http404
    request.session.cycle_key()
    set_active_membership(request, membership)
    Membership.identity.for_user(user).filter(pk=membership.pk).update(last_active_at=timezone.now())
    audit.record(actions.ORG_SWITCHED, request=request, user=user, organization_id=membership.organization_id)
    return membership


# ----------------------------------------------------------------------------- sessions


def revoke_user_sessions(user: User) -> int:
    """Invalidate every session of ``user``.

    Two independent mechanisms: rotating the session salt makes Django's per-request session hash
    check fail for all existing sessions, and allauth's tracked sessions are purged so the session
    rows disappear immediately.
    """
    user.rotate_session_salt()
    revoked = 0
    for session in UserSession.objects.filter(user=user):
        if session.purge():
            revoked += 1
        else:
            session.delete()
    return revoked


# ----------------------------------------------------------------------------- members


def _guard_owner_target(actor: Actor, membership: Membership) -> None:
    """Only owners act on owners, and the organization always keeps one active owner."""
    if membership.role.key != OWNER:
        return
    if actor.role_key != OWNER:
        raise PermissionDenied(code="permission_denied")
    if membership.status == Membership.Status.ACTIVE and _active_owner_count() <= 1:
        raise DomainError("The organization must keep at least one owner.", code="last_owner", status_code=409)


@transaction.atomic
def change_member_role(actor: Actor, membership: Membership, *, role_key: str, request=None) -> Membership:
    check(actor, "members.update_role", membership)
    require_recent_auth(request)
    if membership.user_id == actor.user.pk:
        raise DomainError("You cannot change your own role.", code="self_role_change", status_code=403)
    if membership.role.key == OWNER and actor.role_key != OWNER:
        raise PermissionDenied(code="permission_denied")
    if membership.status == Membership.Status.DISABLED:
        raise DomainError("This person was removed from the organization.", code="member_removed", status_code=409)
    new_role = _assert_can_assign_role(actor, role_key)
    if membership.role.key == OWNER and role_key != OWNER and _active_owner_count() <= 1:
        raise DomainError("The organization must keep at least one owner.", code="last_owner", status_code=409)
    old_role = membership.role.key
    if old_role == new_role.key:
        return membership
    membership.role = new_role
    membership.save(update_fields=["role", "updated_at"])
    revoke_user_sessions(membership.user)
    audit.record(
        actions.MEMBER_ROLE_CHANGED,
        request=request,
        user=actor.user,
        resource=membership,
        metadata={"from": old_role, "to": new_role.key, "user_id": str(membership.user_id)},
    )
    return membership


@transaction.atomic
def suspend_member(actor: Actor, membership: Membership, *, request=None) -> Membership:
    """Block access immediately; ``reactivate_member`` restores the same role and teams."""
    check(actor, "members.disable", membership)
    require_recent_auth(request)
    if membership.user_id == actor.user.pk:
        raise DomainError("You cannot suspend yourself.", code="self_disable", status_code=403)
    _guard_owner_target(actor, membership)
    if membership.status == Membership.Status.SUSPENDED:
        return membership
    if membership.status == Membership.Status.DISABLED:
        raise DomainError("This person was removed from the organization.", code="member_removed", status_code=409)
    membership.status = Membership.Status.SUSPENDED
    membership.disabled_at = timezone.now()
    membership.save(update_fields=["status", "disabled_at", "updated_at"])
    revoke_user_sessions(membership.user)
    audit.record(
        actions.MEMBER_SUSPENDED,
        request=request,
        user=actor.user,
        resource=membership,
        metadata={"user_id": str(membership.user_id)},
    )
    return membership


@transaction.atomic
def reactivate_member(actor: Actor, membership: Membership, *, request=None) -> Membership:
    check(actor, "members.disable", membership)
    require_recent_auth(request)
    if membership.role.key == OWNER and actor.role_key != OWNER:
        raise PermissionDenied(code="permission_denied")
    if membership.status == Membership.Status.ACTIVE:
        return membership
    if membership.status == Membership.Status.DISABLED:
        raise DomainError("Removed users must be invited again to rejoin.", code="member_removed", status_code=409)
    membership.status = Membership.Status.ACTIVE
    membership.disabled_at = None
    membership.save(update_fields=["status", "disabled_at", "updated_at"])
    audit.record(
        actions.MEMBER_REACTIVATED,
        request=request,
        user=actor.user,
        resource=membership,
        metadata={"user_id": str(membership.user_id)},
    )
    return membership


@transaction.atomic
def remove_member(actor: Actor, membership: Membership, *, request=None) -> Membership:
    """Remove a person from the organization without deleting history.

    The membership row stays (records they own keep their owner reference and the audit trail keeps
    its actor) but is marked disabled: sessions are revoked, team memberships and personal mailbox
    tokens are dropped, and only a new invitation can bring the person back. Integration identities
    that act through this membership (API credentials, connections) stop working because every
    machine request re-checks that the membership is active.
    """
    from apps.messaging.models import ConnectionStatus, EmailAccount
    from apps.teams.models import Team, TeamMembership

    check(actor, "members.remove", membership)
    require_recent_auth(request)
    if membership.user_id == actor.user.pk:
        raise DomainError("You cannot remove yourself.", code="self_remove", status_code=403)
    _guard_owner_target(actor, membership)
    if membership.status == Membership.Status.DISABLED:
        return membership
    now = timezone.now()
    membership.status = Membership.Status.DISABLED
    membership.disabled_at = now
    membership.save(update_fields=["status", "disabled_at", "updated_at"])
    teams_removed, _ = TeamMembership.objects.filter(membership=membership).delete()
    Team.objects.filter(manager=membership).update(manager=None, updated_at=now)
    EmailAccount.objects.filter(
        membership=membership, status__in=[ConnectionStatus.CONNECTED, ConnectionStatus.ERROR]
    ).update(
        status=ConnectionStatus.DISCONNECTED,
        disconnected_at=now,
        access_token_enc="",  # nosec B106 - empty means no stored token
        refresh_token_enc="",  # nosec B106 - empty means no stored token
        updated_at=now,
    )
    revoked = revoke_user_sessions(membership.user)
    audit.record(
        actions.MEMBER_REMOVED,
        request=request,
        user=actor.user,
        resource=membership,
        metadata={"user_id": str(membership.user_id), "teams_removed": teams_removed, "sessions_revoked": revoked},
    )
    return membership


@transaction.atomic
def revoke_member_sessions(actor: Actor, membership: Membership, *, request=None) -> int:
    """Sign a member out of every device (for example after a lost laptop). Access itself is unchanged."""
    check(actor, "members.disable", membership)
    if membership.role.key == OWNER and actor.role_key != OWNER:
        raise PermissionDenied(code="permission_denied")
    revoked = revoke_user_sessions(membership.user)
    audit.record(
        actions.AUTH_SESSIONS_REVOKED,
        request=request,
        user=actor.user,
        resource=membership,
        metadata={"user_id": str(membership.user_id), "sessions_revoked": revoked, "by_admin": True},
    )
    return revoked


@transaction.atomic
def set_member_teams(actor: Actor, membership: Membership, *, team_ids: list[uuid.UUID], request=None) -> list:
    """Replace the member's team memberships with ``team_ids`` (teams of the current organization only)."""
    from apps.teams.models import Team, TeamMembership

    check(actor, "teams.manage")
    if membership.status == Membership.Status.DISABLED:
        raise DomainError("This person was removed from the organization.", code="member_removed", status_code=409)
    wanted = list(dict.fromkeys(team_ids))
    if len(wanted) > settings.MAX_TEAMS_PER_MEMBER:
        raise DomainError(
            f"A member can belong to at most {settings.MAX_TEAMS_PER_MEMBER} teams.", code="too_many_teams"
        )
    teams = list(Team.objects.filter(pk__in=wanted))
    if len(teams) != len(wanted):
        # Unknown ids and ids of another organization's teams look the same: not found.
        raise DomainError("One or more teams do not exist.", code="team_not_found", status_code=404)
    current = set(TeamMembership.objects.filter(membership=membership).values_list("team_id", flat=True))
    target = {t.pk for t in teams}
    TeamMembership.objects.filter(membership=membership).exclude(team_id__in=target).delete()
    for team in teams:
        if team.pk not in current:
            TeamMembership.objects.create(team=team, membership=membership)
    if current != target:
        audit.record(
            actions.MEMBER_TEAMS_CHANGED,
            request=request,
            user=actor.user,
            resource=membership,
            metadata={
                "user_id": str(membership.user_id),
                "added": sorted(str(t) for t in target - current),
                "removed": sorted(str(t) for t in current - target),
            },
        )
    return teams


# ----------------------------------------------------------------------------- invitations


def _invitation_team(team_id: uuid.UUID | None):
    if team_id is None:
        return None
    from apps.teams.models import Team

    team = Team.objects.filter(pk=team_id).first()
    if team is None:
        raise DomainError("That team does not exist.", code="team_not_found", status_code=404)
    return team


def _send_invitation(actor: Actor, invitation: Invitation, token: str) -> None:
    accept_url = f"{settings.FRONTEND_ORIGIN}/invitations/accept?token={token}"
    emails.send_invitation_email(
        to_email=invitation.email,
        organization_name=actor.organization.name,
        inviter_name=actor.user.display_name,
        accept_url=accept_url,
        expires_days=settings.INVITATION_EXPIRY_DAYS,
    )


@transaction.atomic
def invite_member(
    actor: Actor,
    *,
    email: str,
    role_key: str,
    name: str = "",
    team_id: uuid.UUID | None = None,
    request=None,
) -> Invitation:
    check(actor, "members.invite")
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        raise DomainError("A valid email address is required.", code="invalid_email")
    role = _assert_can_assign_role(actor, role_key)
    if role.key in PRIVILEGED_ROLES:
        # Inviting someone as owner/admin grants administrative control: same bar as a role change.
        require_recent_auth(request)
    team = None
    if team_id is not None:
        check(actor, "teams.manage")
        team = _invitation_team(team_id)
    existing = Membership.objects.filter(user__email=email).first()
    if existing is not None and existing.status != Membership.Status.DISABLED:
        raise ConflictError("This person is already a member of the organization.", code="already_member")
    now = timezone.now()
    pending = Invitation.objects.filter(accepted_at__isnull=True, revoked_at__isnull=True, expires_at__gt=now)
    if pending.count() >= settings.MAX_PENDING_INVITATIONS_PER_ORG:
        raise DomainError("Too many pending invitations.", code="invitation_limit", status_code=429)
    limits.assert_seat_available(actor.organization, exclude_invitation_email=email)
    pending.filter(email=email).update(revoked_at=now)

    token = secrets.token_urlsafe(32)
    invitation = Invitation.objects.create(
        email=email,
        name=validators.clean_text(name, max_length=120),
        role=role,
        team=team,
        token_hash=_hash_token(token),
        expires_at=now + timedelta(days=settings.INVITATION_EXPIRY_DAYS),
        invited_by=actor.membership,
        last_sent_at=now,
    )
    _send_invitation(actor, invitation, token)
    audit.record(
        actions.MEMBER_INVITED,
        request=request,
        user=actor.user,
        resource=invitation,
        metadata={"email": email, "role": role.key, "team_id": str(team.pk) if team else None},
    )
    return invitation


@transaction.atomic
def resend_invitation(actor: Actor, invitation: Invitation, *, request=None) -> Invitation:
    """Send a fresh link. The previous link stops working (new token) and the expiry restarts."""
    check(actor, "members.invite", invitation)
    invitation = Invitation.objects.select_for_update().get(pk=invitation.pk)
    if invitation.accepted_at is not None or invitation.revoked_at is not None:
        raise DomainError("Only pending invitations can be resent.", code="invitation_not_pending", status_code=409)
    now = timezone.now()
    if invitation.send_count >= settings.INVITATION_MAX_SENDS:
        raise DomainError(
            "This invitation has been sent too many times. Revoke it and invite again.",
            code="invitation_resend_limit",
            status_code=429,
        )
    if (
        invitation.last_sent_at
        and (now - invitation.last_sent_at).total_seconds() < settings.INVITATION_RESEND_COOLDOWN
    ):
        raise DomainError("Please wait a minute before resending.", code="invitation_resend_too_soon", status_code=429)
    _assert_can_assign_role(actor, invitation.role.key)
    if invitation.expires_at <= now:
        # An expired invitation no longer holds a seat; renewing it takes one again.
        limits.assert_seat_available(actor.organization, exclude_invitation_email=invitation.email)
    token = secrets.token_urlsafe(32)
    invitation.token_hash = _hash_token(token)
    invitation.expires_at = now + timedelta(days=settings.INVITATION_EXPIRY_DAYS)
    invitation.send_count += 1
    invitation.last_sent_at = now
    invitation.save(update_fields=["token_hash", "expires_at", "send_count", "last_sent_at", "updated_at"])
    _send_invitation(actor, invitation, token)
    audit.record(
        actions.MEMBER_INVITATION_RESENT,
        request=request,
        user=actor.user,
        resource=invitation,
        metadata={"email": invitation.email, "send_count": invitation.send_count},
    )
    return invitation


@transaction.atomic
def revoke_invitation(actor: Actor, invitation: Invitation, *, request=None) -> None:
    check(actor, "members.invite", invitation)
    if not invitation.is_pending:
        return
    invitation.revoked_at = timezone.now()
    invitation.save(update_fields=["revoked_at", "updated_at"])
    audit.record(
        actions.MEMBER_INVITATION_REVOKED,
        request=request,
        user=actor.user,
        resource=invitation,
        metadata={"email": invitation.email},
    )


def _pending_invitation_by_token(token: str) -> Invitation | None:
    if not token or len(token) > 128:
        return None
    return (
        Invitation.all_objects.select_related("organization", "role", "invited_by__user")
        .filter(
            token_hash=_hash_token(token),
            accepted_at__isnull=True,
            revoked_at__isnull=True,
            expires_at__gt=timezone.now(),
            organization__status=Organization.Status.ACTIVE,
        )
        .first()
    )


def preview_invitation(token: str) -> dict | None:
    with system_context(reason="invitation.preview"):
        inv = _pending_invitation_by_token(token)
        if inv is None:
            return None
        return {
            "organization_name": inv.organization.name,
            "email": inv.email,
            "name": inv.name,
            "role": inv.role.key,
            "role_name": inv.role.name,
            "invited_by": inv.invited_by.user.display_name if inv.invited_by else "",
            "expires_at": inv.expires_at,
        }


def _invalid_invitation() -> DomainError:
    return DomainError("This invitation is invalid or has expired.", code="invitation_invalid", status_code=404)


def _join_from_invitation(inv: Invitation, user: User, *, existing: Membership | None) -> Membership:
    """Create or restore the membership an invitation grants. Runs inside the invitation's tenant context,
    with the invitation row locked. Role, team and organization come only from the invitation row."""
    from apps.teams.models import Team, TeamMembership

    now = timezone.now()
    if existing is None:
        limits.assert_seat_available(inv.organization, exclude_invitation_email=inv.email)
        membership = Membership.objects.create(user=user, role=inv.role, invited_by=inv.invited_by, joined_at=now)
    elif existing.status == Membership.Status.ACTIVE:
        membership = existing  # already in: consume the invitation, keep the current role
    elif existing.status == Membership.Status.SUSPENDED:
        raise DomainError(
            "Your access to this organization is suspended. Contact an administrator.",
            code="member_disabled",
            status_code=403,
        )
    else:  # removed earlier: the new invitation brings them back with the invited role
        limits.assert_seat_available(inv.organization, exclude_invitation_email=inv.email)
        membership = existing
        membership.status = Membership.Status.ACTIVE
        membership.role = inv.role
        membership.disabled_at = None
        membership.invited_by = inv.invited_by
        membership.joined_at = now
        membership.save(update_fields=["status", "role", "disabled_at", "invited_by", "joined_at", "updated_at"])
    if inv.team_id is not None and Team.objects.filter(pk=inv.team_id).exists():
        TeamMembership.objects.get_or_create(team_id=inv.team_id, membership=membership)
    inv.accepted_at = now
    inv.accepted_by = membership
    inv.save(update_fields=["accepted_at", "accepted_by", "updated_at"])
    return membership


def accept_invitation(user: User, token: str, *, request=None) -> Membership:
    """A signed-in user accepts an invitation addressed to their email."""
    with system_context(reason="invitation.accept"):
        inv = _pending_invitation_by_token(token)
        if inv is None:
            raise _invalid_invitation()
        if inv.email != user.email.lower():
            raise DomainError(
                "This invitation was sent to a different email address.",
                code="invitation_email_mismatch",
                status_code=403,
            )
        org_id = inv.organization_id
        organization = inv.organization
    with tenant_context(org_id, user_id=user.pk, reason="invitation.accept"), transaction.atomic():
        inv = Invitation.objects.select_for_update().select_related("role").get(pk=inv.pk)
        if not inv.is_pending:
            raise _invalid_invitation()
        inv.organization = organization
        existing = Membership.objects.filter(user=user).first()
        membership = _join_from_invitation(inv, user, existing=existing)
        membership.organization = organization
        audit.record(
            actions.MEMBER_JOINED,
            request=request,
            user=user,
            resource=membership,
            metadata={"invitation_id": str(inv.pk), "role": membership.role.key},
        )
    if request is not None:
        request.session.cycle_key()
        set_active_membership(request, membership)
    return membership


def register_with_invitation(request, *, token: str, name: str, password: str) -> Membership:
    """Create the invitee's account from the invitation link and sign them in.

    Holding the token proves control of the invited address (it was only ever sent there), so the
    email is marked verified. Everything the account gets - organization, role, team - is read from
    the invitation row; the request carries only the token, a display name and the new password.

    One transaction: lock the invitation, create user + verified email + membership + team, consume
    the invitation, audit. Any failure rolls all of it back. A second request with the same token
    waits on the row lock and then finds the invitation consumed.
    """
    from allauth.account import signals as account_signals
    from allauth.account.internal.flows.login import record_authentication
    from allauth.account.models import EmailAddress
    from django.contrib.auth import login as django_login
    from django.contrib.auth.password_validation import validate_password
    from django.core.exceptions import ValidationError as DjangoValidationError
    from django.db import IntegrityError
    from rest_framework.exceptions import ValidationError

    from apps.accounts.forms import split_name

    with system_context(reason="invitation.register.lookup"):
        found = _pending_invitation_by_token(token)
        if found is None:
            raise _invalid_invitation()
        inv_pk, org_id, organization, email = found.pk, found.organization_id, found.organization, found.email
        suggested_name = found.name

    display = validators.clean_text(name, max_length=120) or suggested_name
    first_name, last_name = split_name(display) if display else ("", "")
    try:
        validate_password(password, user=User(email=email, first_name=first_name, last_name=last_name))
    except DjangoValidationError as exc:
        raise ValidationError({"password": list(exc.messages)}) from exc

    with tenant_context(org_id, reason="invitation.register"), transaction.atomic():
        inv = Invitation.objects.select_for_update(of=("self",)).select_related("role", "invited_by").get(pk=inv_pk)
        if not inv.is_pending:
            raise _invalid_invitation()
        inv.organization = organization
        if User.objects.filter(email__iexact=email).exists():
            raise ConflictError(
                "An account already exists for this email. Sign in to accept the invitation.", code="account_exists"
            )
        try:
            with transaction.atomic():
                user = User.objects.create_user(
                    email=email, password=password, first_name=first_name, last_name=last_name
                )
        except IntegrityError as exc:  # a concurrent sign-up with the same address won
            raise ConflictError(
                "An account already exists for this email. Sign in to accept the invitation.", code="account_exists"
            ) from exc
        User.objects.filter(pk=user.pk).update(password_changed_at=timezone.now())
        EmailAddress.objects.create(user=user, email=email, verified=True, primary=True)
        set_db_user(user.pk)
        membership = _join_from_invitation(inv, user, existing=None)
        membership.organization = organization
        audit.record(
            actions.MEMBER_JOINED,
            request=request,
            user=user,
            resource=membership,
            metadata={"invitation_id": str(inv.pk), "role": membership.role.key, "new_account": True},
        )

    # Sign in exactly like a password login: Django rotates the session key, allauth's signal sets the
    # active membership (the only one the account has) and writes the login audit event.
    django_login(request, user, backend="allauth.account.auth_backends.AuthenticationBackend")
    record_authentication(request, user, method="password", email=email)
    account_signals.user_logged_in.send(sender=User, request=request, response=None, user=user)
    return membership


def current_context_is(org_id: uuid.UUID) -> bool:
    ctx = get_context()
    return ctx is not None and ctx.organization_id == org_id
