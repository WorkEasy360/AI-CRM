"""Turn the verified claims of a Workeasy360 ID token into a Keel user, organization and membership.

Nothing here reads the request: every input is a claim the provider signed, checked by
``oidc.Workeasy360Client.verify_id_token`` before this module sees it.

Who the user is:
1. (issuer, sub) already known            -> that user.
2. else a Keel account has the address,   -> link it, but only when Workeasy360 says the address is
   and it has no Workeasy360 identity        verified (otherwise anyone who registered that address at
                                             the provider could take the Keel account over).
3. else                                   -> a new account with no usable password, its address
                                             recorded as verified (the provider verified it).

Which organization: the one whose ``workeasy360_organization_id`` is the token's ``organization_id``,
created on first sign-in (the person who caused that becomes its owner). ``organization_name`` is only
the starting display name, never a key.

Which membership: an active one is used as is; a suspended or removed one is refused (a Keel admin took
the person out, and a sign-in elsewhere must not undo that); none -> joined with
``WORKEASY360_DEFAULT_ROLE``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from allauth.account.models import EmailAddress
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts import limits
from apps.accounts.forms import split_name
from apps.accounts.models import ExternalIdentity, Membership, Organization, User
from apps.accounts.workeasy360.oidc import SSOError
from apps.audit import actions
from apps.audit import service as audit
from apps.authz.models import Role
from apps.authz.roles import OWNER, SYSTEM_ROLES
from apps.core import validators
from apps.core.exceptions import DomainError
from apps.core.tenancy.context import system_context, tenant_context

#: Display name of an organization created before Workeasy360 told us its name (no organization scope).
FALLBACK_ORGANIZATION_NAME = "My organization"


@dataclass(frozen=True)
class SignInClaims:
    subject: str
    organization_id: uuid.UUID
    email: str
    email_verified: bool
    name: str
    organization_name: str
    aal: int


@dataclass(frozen=True)
class Provisioned:
    user: User
    membership: Membership
    created_user: bool
    linked_user: bool
    created_organization: bool


def read_claims(claims: dict[str, Any]) -> SignInClaims:
    """Validate the claims this module relies on. Any surprise refuses the sign-in."""
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject or len(subject) > 255:
        raise SSOError("invalid_token", "sub missing or too long")
    try:
        organization_id = uuid.UUID(str(claims.get("organization_id")))
    except ValueError:
        raise SSOError("invalid_token", "organization_id is not a UUID") from None
    expected_product = settings.WORKEASY360_PRODUCT_CODE
    product = claims.get("product_code")
    if expected_product and product is not None and product != expected_product:
        raise SSOError("wrong_product", f"token is for product {product!r}")
    email = claims.get("email")
    email = email.strip().lower() if isinstance(email, str) else ""
    if not email or "@" not in email or len(email) > 254:
        # The email scope is registered for this client; without the claim there is nothing to key a
        # Keel account on (the email is Keel's username).
        raise SSOError("email_missing", "no usable email claim")
    aal = claims.get("aal")
    return SignInClaims(
        subject=subject,
        organization_id=organization_id,
        email=email,
        email_verified=claims.get("email_verified") is True,
        name=_clean(claims.get("name"), 120),
        organization_name=_clean(claims.get("organization_name"), 120),
        aal=aal if isinstance(aal, int) and not isinstance(aal, bool) and aal in (1, 2) else 1,
    )


def _clean(value: Any, max_length: int) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = validators.clean_text(value[: max_length * 2], max_length=max_length * 2)
    return " ".join(cleaned.split())[:max_length]


def default_role_key() -> str:
    key = settings.WORKEASY360_DEFAULT_ROLE
    if key not in SYSTEM_ROLES or key == OWNER:
        # Fail closed: a typo must not hand out a role nobody chose, and owner is reserved for the
        # person whose sign-in created the organization.
        raise SSOError("provider_misconfigured", f"WORKEASY360_DEFAULT_ROLE {key!r} is not an assignable role")
    return key


def provision(claims: SignInClaims, *, issuer: str, request=None) -> Provisioned:
    """Resolve (creating where needed) the user, organization and membership for a sign-in. Atomic."""
    with transaction.atomic():
        user, created_user, linked_user = _resolve_user(claims, issuer=issuer, request=request)
        organization, owner_membership = _resolve_organization(user, claims, request=request)
        if owner_membership is not None:
            membership = owner_membership
        else:
            membership = _resolve_membership(user, organization, request=request)
        now = timezone.now()
        with tenant_context(organization.pk, user_id=user.pk, reason="workeasy360.sign_in"):
            # The most recently active membership is the one the login signal activates.
            Membership.objects.filter(pk=membership.pk).update(last_active_at=now)
        membership.organization = organization  # outside a context RLS hides the row; keep the relation
        membership.last_active_at = now
        return Provisioned(
            user=user,
            membership=membership,
            created_user=created_user,
            linked_user=linked_user,
            created_organization=owner_membership is not None,
        )


# ----------------------------------------------------------------------------- user


def _resolve_user(claims: SignInClaims, *, issuer: str, request) -> tuple[User, bool, bool]:
    now = timezone.now()
    identity = ExternalIdentity.objects.select_related("user").filter(issuer=issuer, subject=claims.subject).first()
    if identity is not None:
        _require_active(identity.user)
        ExternalIdentity.objects.filter(pk=identity.pk).update(last_login_at=now)
        return identity.user, False, False

    existing = _user_for_email(claims.email)
    if existing is not None:
        return _link(existing, claims, issuer=issuer, request=request), False, True

    if not claims.email_verified:
        # Keel accounts are keyed by verified addresses only; an unverified one could squat the address
        # its real owner later signs in with.
        raise SSOError("email_unverified", "provider has not verified the address")
    try:
        with transaction.atomic():
            first_name, last_name = split_name(claims.name) if claims.name else ("", "")
            user = User.objects.create_user(
                email=claims.email, password=None, first_name=first_name, last_name=last_name
            )
            EmailAddress.objects.create(user=user, email=user.email, primary=True, verified=True)
            ExternalIdentity.objects.create(user=user, issuer=issuer, subject=claims.subject, last_login_at=now)
    except IntegrityError:
        # A concurrent first sign-in of the same person committed first: use what it created.
        identity = ExternalIdentity.objects.select_related("user").filter(issuer=issuer, subject=claims.subject).first()
        if identity is None:
            raise SSOError("account_conflict", "concurrent account creation for the same address") from None
        _require_active(identity.user)
        return identity.user, False, False
    audit.record(
        actions.AUTH_SSO_ACCOUNT_CREATED,
        request=request,
        user=user,
        organization_id=None,
        metadata={"method": "workeasy360", "issuer": issuer},
    )
    return user, True, False


def _user_for_email(email: str) -> User | None:
    user = User.objects.filter(email__iexact=email).first()
    if user is not None:
        return user
    address = EmailAddress.objects.filter(email__iexact=email, verified=True).select_related("user").first()
    return address.user if address is not None else None


def _link(user: User, claims: SignInClaims, *, issuer: str, request) -> User:
    """Attach a Workeasy360 identity to an existing Keel account that has the same address."""
    if not claims.email_verified:
        raise SSOError("email_unverified", "refusing to link an existing account on an unverified address")
    _require_active(user)
    if ExternalIdentity.objects.filter(user=user, issuer=issuer).exists():
        # This Keel account already belongs to a different Workeasy360 account.
        raise SSOError("account_conflict", "account is linked to another Workeasy360 identity")
    keel_verified = EmailAddress.objects.filter(user=user, email__iexact=claims.email, verified=True).exists()
    try:
        with transaction.atomic():
            ExternalIdentity.objects.create(
                user=user, issuer=issuer, subject=claims.subject, last_login_at=timezone.now()
            )
            if not keel_verified:
                # Nobody ever proved to Keel that they own this address, so whoever chose this account's
                # password may not be the person Workeasy360 just verified (a pre-registered account).
                # The password goes, and with it every session it opened; the address is now verified.
                user.set_unusable_password()
                user.save(update_fields=["password"])
                user.rotate_session_salt()
                EmailAddress.objects.filter(user=user, email__iexact=claims.email).update(verified=True)
    except IntegrityError:
        raise SSOError("account_conflict", "identity already linked concurrently") from None
    audit.record(
        actions.AUTH_SSO_IDENTITY_LINKED,
        request=request,
        user=user,
        organization_id=None,
        metadata={"method": "workeasy360", "issuer": issuer, "password_removed": not keel_verified},
    )
    return user


def _require_active(user: User) -> None:
    if not user.is_active:
        raise SSOError("account_disabled", "Keel account is deactivated")


# ----------------------------------------------------------------------------- organization


def _resolve_organization(user: User, claims: SignInClaims, *, request) -> tuple[Organization, Membership | None]:
    """The Keel counterpart of the token's organization, and the owner membership if this created it."""
    from apps.accounts.services import create_organization

    organization = _organization_for(claims.organization_id)
    if organization is not None:
        return _require_usable(organization), None
    try:
        with transaction.atomic():
            membership = create_organization(
                user,
                name=claims.organization_name or FALLBACK_ORGANIZATION_NAME,
                base_currency=settings.DEFAULT_ORGANIZATION_CURRENCY,
                timezone_name=settings.DEFAULT_ORGANIZATION_TIMEZONE,
                request=None,  # the session is rotated by the sign-in itself
                source="workeasy360",
                workeasy360_organization_id=claims.organization_id,
            )
    except IntegrityError:
        # Two people of the same new organization signed in at once; the other one created it.
        organization = _organization_for(claims.organization_id)
        if organization is None:
            raise SSOError("organization_unavailable", "organization creation race lost but no row") from None
        return _require_usable(organization), None
    return membership.organization, membership


def _organization_for(workeasy360_organization_id: uuid.UUID) -> Organization | None:
    with system_context(reason="workeasy360.sign_in.organization"):
        return Organization.objects.filter(workeasy360_organization_id=workeasy360_organization_id).first()


def _require_usable(organization: Organization) -> Organization:
    if organization.status != Organization.Status.ACTIVE:
        raise SSOError("organization_unavailable", f"organization status {organization.status}")
    return organization


# ----------------------------------------------------------------------------- membership


def _resolve_membership(user: User, organization: Organization, *, request) -> Membership:
    role_key = default_role_key()
    with tenant_context(organization.pk, user_id=user.pk, reason="workeasy360.sign_in.membership"):
        existing = Membership.objects.select_related("role").filter(user=user).first()
        if existing is not None:
            if existing.status != Membership.Status.ACTIVE:
                raise SSOError("membership_inactive", f"Keel membership is {existing.status}")
            return existing
        try:
            limits.assert_seat_available(organization)
        except DomainError as exc:
            raise SSOError("seat_limit", str(exc)) from None
        role = Role.objects.get(key=role_key, is_system=True, organization__isnull=True)
        try:
            with transaction.atomic():
                membership = Membership.objects.create(user=user, role=role, joined_at=timezone.now())
        except IntegrityError:
            # The same person's concurrent sign-in created it first.
            existing = Membership.objects.select_related("role").filter(user=user).first()
            if existing is None or existing.status != Membership.Status.ACTIVE:
                raise SSOError("membership_inactive", "membership race") from None
            return existing
        membership.organization = organization
        audit.record(
            actions.MEMBER_JOINED,
            request=request,
            user=user,
            resource=membership,
            metadata={"source": "workeasy360", "role": role.key},
        )
        return membership
