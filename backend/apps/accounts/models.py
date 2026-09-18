from __future__ import annotations

import secrets
import uuid
from typing import Any, ClassVar, cast

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone
from django.utils.crypto import salted_hmac

from apps.core.exceptions import TenantContextMissing
from apps.core.models import TenantManager, TenantModel, TimestampedModel
from apps.core.tenancy.context import get_context


def generate_session_salt() -> str:
    return secrets.token_hex(16)


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def _create(self, email: str, password: str | None, **extra: Any) -> User:
        if not email:
            raise ValueError("Email is required.")
        email = self.normalize_email(email).strip().lower()
        user = self.model(email=email, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str | None = None, **extra: Any) -> User:
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create(email, password, **extra)

    def create_superuser(self, email: str, password: str | None = None, **extra: Any) -> User:
        # Django's permission framework is not used for CRM authorization; superusers are
        # only meaningful for operational tooling and are never created through the product.
        extra["is_staff"] = True
        extra["is_superuser"] = True
        return self._create(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    """Global identity. Everything the user can do inside an organization is a Membership."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(max_length=254)
    first_name = models.CharField(max_length=80, blank=True)
    last_name = models.CharField(max_length=80, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    password_changed_at = models.DateTimeField(null=True, blank=True)
    # Rotated to invalidate every session of the user (role change, disable, password events).
    session_salt = models.CharField(max_length=32, default=generate_session_salt)

    USERNAME_FIELD: ClassVar[str] = "email"
    REQUIRED_FIELDS: ClassVar[list[str]] = []

    objects: ClassVar[UserManager] = UserManager()

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("email"), name="uniq_user_email_ci"),
        ]

    def __str__(self) -> str:
        return self.email

    def save(self, *args: Any, **kwargs: Any) -> None:
        self.email = (self.email or "").strip().lower()
        super().save(*args, **kwargs)

    @property
    def display_name(self) -> str:
        name = f"{self.first_name} {self.last_name}".strip()
        return name or self.email.split("@", 1)[0]

    def get_session_auth_hash(self) -> str:
        """Django verifies this on every request; rotating ``session_salt`` logs the user out everywhere."""
        key_salt = "apps.accounts.models.User.get_session_auth_hash"
        return salted_hmac(key_salt, f"{self.password}:{self.session_salt}", algorithm="sha256").hexdigest()

    def rotate_session_salt(self) -> None:
        self.session_salt = generate_session_salt()
        type(self).objects.filter(pk=self.pk).update(session_salt=self.session_salt)


class OrganizationManager(models.Manager["Organization"]):
    """Tenant root. Reads are limited to the bound organization; system context sees all."""

    def get_queryset(self) -> models.QuerySet[Organization]:
        ctx = get_context()
        if ctx is None:
            raise TenantContextMissing("Organization.objects used without a tenant context.")
        qs = super().get_queryset()
        if ctx.is_system:
            return qs
        if ctx.organization_id is None:
            raise TenantContextMissing("Organization.objects used without an organization.")
        return qs.filter(pk=ctx.organization_id)


class OrganizationIdentityManager(models.Manager["Organization"]):
    """Identity-side access: organizations a given user belongs to, usable before a tenant is bound."""

    def get_queryset(self) -> models.QuerySet[Organization]:
        raise TenantContextMissing("Use Organization.identity.for_user(user).")

    def for_user(self, user: User) -> models.QuerySet[Organization]:
        return (
            super()
            .get_queryset()
            .filter(
                memberships__user=user,
                memberships__status=Membership.Status.ACTIVE,
                status=Organization.Status.ACTIVE,
            )
            .distinct()
        )


class Organization(TimestampedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        SUSPENDED = "suspended", "Suspended"
        DELETING = "deleting", "Deleting"

    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=60, unique=True)
    base_currency = models.CharField(max_length=3, default="INR")
    timezone = models.CharField(max_length=64, default="Asia/Kolkata")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    plan = models.CharField(max_length=32, default="trial")
    settings = models.JSONField(default=dict, blank=True)
    data_retention_days = models.PositiveIntegerField(default=0)  # 0 = retain until deleted

    objects: ClassVar[OrganizationManager] = OrganizationManager()
    identity: ClassVar[OrganizationIdentityManager] = OrganizationIdentityManager()

    def __str__(self) -> str:
        return self.name

    @property
    def require_mfa(self) -> bool:
        return bool(self.settings.get("require_mfa", False))


class MembershipQuerySet(models.QuerySet["Membership"]):
    def active(self) -> MembershipQuerySet:
        return self.filter(status=Membership.Status.ACTIVE, user__is_active=True)


class MembershipManager(TenantManager):
    """Tenant-scoped manager exposing the queryset helpers statically (django-stubs friendly)."""

    _queryset_class = MembershipQuerySet

    def get_queryset(self) -> MembershipQuerySet:  # type: ignore[override]  # narrowed queryset type
        return cast(MembershipQuerySet, super().get_queryset())

    def active(self) -> MembershipQuerySet:
        return self.get_queryset().active()


class MembershipIdentityManager(models.Manager["Membership"]):
    """Identity-side access to a user's own memberships (login, session, org switch)."""

    def get_queryset(self) -> models.QuerySet[Membership]:
        raise TenantContextMissing("Use Membership.identity.for_user(user).")

    def for_user(self, user: User) -> MembershipQuerySet:
        return MembershipQuerySet(self.model, using=self._db).filter(user=user)


class Membership(TenantModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        # Temporarily blocked by an administrator; ``reactivate`` restores the same role and teams.
        SUSPENDED = "suspended", "Suspended"
        # Removed from the organization. The row stays for ownership and audit history; only a new
        # invitation brings the person back.
        DISABLED = "disabled", "Disabled"

    organization = models.ForeignKey(
        "accounts.Organization", on_delete=models.CASCADE, editable=False, related_name="memberships"
    )
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="memberships")
    role = models.ForeignKey("authz.Role", on_delete=models.PROTECT, related_name="memberships")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    invited_by = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    joined_at = models.DateTimeField(default=timezone.now)
    disabled_at = models.DateTimeField(null=True, blank=True)
    last_active_at = models.DateTimeField(null=True, blank=True)

    objects: ClassVar[MembershipManager] = MembershipManager()
    identity: ClassVar[MembershipIdentityManager] = MembershipIdentityManager()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "user"], name="uniq_membership_org_user"),
        ]
        indexes = [models.Index(fields=["user"], name="membership_user_idx")]

    def __str__(self) -> str:
        return f"{self.user_id}@{self.organization_id} ({self.role_id})"

    @property
    def is_active(self) -> bool:
        return self.status == self.Status.ACTIVE


class Invitation(TenantModel):
    email = models.EmailField(max_length=254)
    # Display name suggested by the inviter; the invitee may change it when creating the account.
    name = models.CharField(max_length=120, blank=True)
    role = models.ForeignKey("authz.Role", on_delete=models.PROTECT, related_name="+")
    team = models.ForeignKey("teams.Team", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    send_count = models.PositiveSmallIntegerField(default=1)
    last_sent_at = models.DateTimeField(null=True, blank=True)
    token_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    invited_by = models.ForeignKey(Membership, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    accepted_by = models.ForeignKey(Membership, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        indexes = [models.Index(fields=["organization", "email"], name="invitation_org_email_idx")]

    @property
    def is_pending(self) -> bool:
        return self.accepted_at is None and self.revoked_at is None and self.expires_at > timezone.now()
