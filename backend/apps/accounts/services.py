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

from apps.accounts import emails
from apps.accounts.models import Invitation, Membership, Organization, User
from apps.accounts.session import set_active_membership
from apps.audit import actions
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.models import Role
from apps.authz.reauth import require_recent_auth
from apps.authz.roles import ADMIN, ASSIGNABLE_BY_ADMIN, OWNER, SYSTEM_ROLES
from apps.authz.service import check
from apps.core.exceptions import ConflictError, DomainError
from apps.core.tenancy.context import get_context, system_context, tenant_context

# ----------------------------------------------------------------------------- helpers


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
    user: User, *, name: str, base_currency: str = "INR", timezone_name: str = "Asia/Kolkata", request=None
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
        audit.record(actions.ORG_CREATED, request=request, user=user, resource=org, metadata={"name": name})
        # Every organization starts with a usable sales pipeline (Phase 2).
        from apps.pipelines.services import ensure_default_pipeline

        ensure_default_pipeline()
    if request is not None:
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


@transaction.atomic
def change_member_role(actor: Actor, membership: Membership, *, role_key: str, request=None) -> Membership:
    check(actor, "members.update_role", membership)
    require_recent_auth(request)
    if membership.user_id == actor.user.pk:
        raise DomainError("You cannot change your own role.", code="self_role_change", status_code=403)
    if membership.role.key == OWNER and actor.role_key != OWNER:
        raise PermissionDenied(code="permission_denied")
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
def disable_member(actor: Actor, membership: Membership, *, request=None) -> Membership:
    check(actor, "members.disable", membership)
    require_recent_auth(request)
    if membership.user_id == actor.user.pk:
        raise DomainError("You cannot disable yourself.", code="self_disable", status_code=403)
    if membership.role.key == OWNER:
        if actor.role_key != OWNER:
            raise PermissionDenied(code="permission_denied")
        if _active_owner_count() <= 1:
            raise DomainError("The organization must keep at least one owner.", code="last_owner", status_code=409)
    if membership.status == Membership.Status.DISABLED:
        return membership
    membership.status = Membership.Status.DISABLED
    membership.disabled_at = timezone.now()
    membership.save(update_fields=["status", "disabled_at", "updated_at"])
    revoke_user_sessions(membership.user)
    audit.record(
        actions.MEMBER_DISABLED,
        request=request,
        user=actor.user,
        resource=membership,
        metadata={"user_id": str(membership.user_id)},
    )
    return membership


@transaction.atomic
def enable_member(actor: Actor, membership: Membership, *, request=None) -> Membership:
    check(actor, "members.disable", membership)
    require_recent_auth(request)
    if membership.role.key == OWNER and actor.role_key != OWNER:
        raise PermissionDenied(code="permission_denied")
    if membership.status == Membership.Status.ACTIVE:
        return membership
    membership.status = Membership.Status.ACTIVE
    membership.disabled_at = None
    membership.save(update_fields=["status", "disabled_at", "updated_at"])
    audit.record(
        actions.MEMBER_ENABLED,
        request=request,
        user=actor.user,
        resource=membership,
        metadata={"user_id": str(membership.user_id)},
    )
    return membership


# ----------------------------------------------------------------------------- invitations


@transaction.atomic
def invite_member(actor: Actor, *, email: str, role_key: str, request=None) -> Invitation:
    check(actor, "members.invite")
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        raise DomainError("A valid email address is required.", code="invalid_email")
    role = _assert_can_assign_role(actor, role_key)
    if Membership.objects.filter(user__email=email).exists():
        raise ConflictError("This person is already a member of the organization.", code="already_member")
    now = timezone.now()
    pending = Invitation.objects.filter(accepted_at__isnull=True, revoked_at__isnull=True, expires_at__gt=now)
    if pending.count() >= settings.MAX_PENDING_INVITATIONS_PER_ORG:
        raise DomainError("Too many pending invitations.", code="invitation_limit", status_code=429)
    pending.filter(email=email).update(revoked_at=now)

    token = secrets.token_urlsafe(32)
    invitation = Invitation.objects.create(
        email=email,
        role=role,
        token_hash=_hash_token(token),
        expires_at=now + timedelta(days=settings.INVITATION_EXPIRY_DAYS),
        invited_by=actor.membership,
    )
    accept_url = f"{settings.FRONTEND_ORIGIN}/invitations/accept?token={token}"
    emails.send_invitation_email(
        to_email=email,
        organization_name=actor.organization.name,
        inviter_name=actor.user.display_name,
        accept_url=accept_url,
        expires_days=settings.INVITATION_EXPIRY_DAYS,
    )
    audit.record(
        actions.MEMBER_INVITED,
        request=request,
        user=actor.user,
        resource=invitation,
        metadata={"email": email, "role": role.key},
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
            "role": inv.role.key,
            "expires_at": inv.expires_at,
        }


def accept_invitation(user: User, token: str, *, request=None) -> Membership:
    with system_context(reason="invitation.accept"):
        inv = _pending_invitation_by_token(token)
        if inv is None:
            raise DomainError("This invitation is invalid or has expired.", code="invitation_invalid", status_code=404)
        if inv.email != user.email.lower():
            raise DomainError(
                "This invitation was sent to a different email address.",
                code="invitation_email_mismatch",
                status_code=403,
            )
        org_id = inv.organization_id
        organization = inv.organization
    with tenant_context(org_id, user_id=user.pk, reason="invitation.accept"), transaction.atomic():
        inv = Invitation.objects.select_for_update().get(pk=inv.pk)
        if not inv.is_pending:
            raise DomainError("This invitation is invalid or has expired.", code="invitation_invalid", status_code=404)
        existing = Membership.objects.filter(user=user).first()
        if existing is not None:
            if existing.status == Membership.Status.DISABLED:
                raise DomainError(
                    "Your access to this organization has been disabled.", code="member_disabled", status_code=403
                )
            membership = existing
        else:
            membership = Membership.objects.create(
                user=user, role=inv.role, invited_by=inv.invited_by, joined_at=timezone.now()
            )
        membership.organization = organization
        inv.accepted_at = timezone.now()
        inv.accepted_by = membership
        inv.save(update_fields=["accepted_at", "accepted_by", "updated_at"])
        audit.record(
            actions.MEMBER_JOINED,
            request=request,
            user=user,
            resource=membership,
            metadata={"invitation_id": str(inv.pk), "role": inv.role.key},
        )
    if request is not None:
        request.session.cycle_key()
        set_active_membership(request, membership)
    return membership


def current_context_is(org_id: uuid.UUID) -> bool:
    ctx = get_context()
    return ctx is not None and ctx.organization_id == org_id
