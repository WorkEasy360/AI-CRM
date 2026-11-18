"""Turn the verified claims of a Workeasy360 ID token into a Keel user, organization and membership.

Nothing here reads the request: every input is a claim the provider signed, verified by the workeasy360-sso
connector (signature, issuer, audience, nonce, product, organization binding) before this module sees it.
The connector calls it through ``UserAdapter`` and ``OrganizationAdapter`` (named in
``settings.WORKEASY360_SSO``), both inside one database transaction: a refused membership leaves no new
account behind.

``ExternalIdentity`` stays the authoritative (issuer, sub) -> user link. The connector's own
``FederatedIdentity`` (which its back-channel session records point at) is kept a mirror of it on every
sign-in.

Who the user is:
1. (issuer, sub) already known            -> that user.
2. else a Keel account has the address    -> refused (``account_conflict``): the same address is not proof
                                             of the same person. An operator links the two with
                                             ``manage.py link_workeasy360_user`` (audited). Only with
                                             ``WORKEASY360_LINK_BY_VERIFIED_EMAIL`` on does the sign-in link
                                             it itself, under the rules of ``_link_by_email``.
3. else                                   -> a new account with no usable password, its address
                                             recorded as verified (the provider verified it).

A link never touches the account's password: password sign-in ends for everyone with
``WORKEASY360_SSO_ONLY`` (docs/workeasy360-sso.md, "Existing accounts").

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
from typing import Any, cast

from allauth.account.models import EmailAddress
from django.conf import settings
from django.contrib.auth.base_user import AbstractBaseUser
from django.db import IntegrityError, transaction
from django.http import HttpRequest
from django.utils import timezone
from workeasy360_sso.errors import SignInRefused
from workeasy360_sso.models import FederatedIdentity
from workeasy360_sso.organizations import DefaultOrganizationAdapter
from workeasy360_sso.provisioning import DefaultUserAdapter

from apps.accounts import limits
from apps.accounts.forms import split_name
from apps.accounts.models import ExternalIdentity, Membership, Organization, User
from apps.accounts.workeasy360 import config
from apps.audit import actions
from apps.audit import service as audit
from apps.authz.models import Role
from apps.authz.roles import OWNER, SYSTEM_ROLES
from apps.core import validators
from apps.core.exceptions import DomainError
from apps.core.tenancy.context import system_context, tenant_context

#: Display name of an organization created before Workeasy360 told us its name (no organization scope).
FALLBACK_ORGANIZATION_NAME = "My organization"


class LinkNotAuditedError(RuntimeError):
    """The audit record of a link could not be written; the link is undone with the transaction."""


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
        raise SignInRefused("refused", log_reason="sub missing or too long")
    try:
        organization_id = uuid.UUID(str(claims.get("organization_id")))
    except ValueError:
        raise SignInRefused("refused", log_reason="organization_id is not a UUID") from None
    expected_product = config.product_code()
    if not expected_product:
        # Refused at startup (config.settings.prod, workeasy360.E001); if it got here anyway, no check at all
        # would be worse than no sign-in.
        raise SignInRefused("unavailable", log_reason="WORKEASY360_PRODUCT_CODE is empty")
    product = claims.get("product_code")
    if product != expected_product:
        # Present and ours: a token that does not say which product it is for is no evidence it is for this one.
        detail = "token has no product_code" if product is None else "token is for another product"
        raise SignInRefused("wrong_product", log_reason=detail)
    email = claims.get("email")
    email = email.strip().lower() if isinstance(email, str) else ""
    if not email or "@" not in email or len(email) > 254:
        # The email scope is registered for this client; without the claim there is nothing to key a
        # Keel account on (the email is Keel's username).
        raise SignInRefused("email_missing", log_reason="no usable email claim")
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
        raise SignInRefused("unavailable", log_reason="WORKEASY360_DEFAULT_ROLE is not an assignable role")
    return key


def provision(claims: SignInClaims, *, issuer: str, request=None) -> Provisioned:
    """Resolve (creating where needed) the user, organization and membership for a sign-in. Atomic."""
    with transaction.atomic():
        user, created_user, linked_user = resolve_user(claims, issuer=issuer, request=request)
        membership, created_organization = resolve_membership(user, claims, request=request)
        return Provisioned(
            user=user,
            membership=membership,
            created_user=created_user,
            linked_user=linked_user,
            created_organization=created_organization,
        )


def resolve_user(claims: SignInClaims, *, issuer: str, request=None) -> tuple[User, bool, bool]:
    """(user, created, linked) for the sign-in, with the connector's identity mirror kept in step."""
    user, created_user, linked_user = _resolve_user(claims, issuer=issuer, request=request)
    sync_federated_identity(user, issuer=issuer, subject=claims.subject, email=claims.email)
    return user, created_user, linked_user


def resolve_membership(user: User, claims: SignInClaims, *, request=None) -> tuple[Membership, bool]:
    """(membership, whether the sign-in created the organization) in the organization the token names."""
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
    return membership, owner_membership is not None


def sync_federated_identity(user: User, *, issuer: str, subject: str, email: str = "") -> FederatedIdentity:
    """The connector's ``FederatedIdentity`` for (issuer, subject), pointing at ``user``.

    ``ExternalIdentity`` decides who the person is; this mirror exists because the connector's back-channel
    session records point at it. A mirror row that disagrees (a link made by the previous release, or by
    the previous image after a rollback) is corrected here, never the other way round.
    """
    now = timezone.now()
    # This user's mirror for another subject at the same issuer can only be stale: Keel allows one identity
    # per issuer and user, and ExternalIdentity has just said which one it is.
    FederatedIdentity.objects.filter(user=user, issuer=issuer).exclude(subject=subject).delete()
    identity, created = FederatedIdentity.objects.get_or_create(
        issuer=issuer,
        subject=subject,
        defaults={"user": user, "email_at_link": email[:254], "last_sign_in_at": now},
    )
    if not created:
        fields = ["last_sign_in_at"]
        if identity.user_id != user.pk:
            identity.user = user
            fields.append("user")
        identity.last_sign_in_at = now
        identity.save(update_fields=fields)
    return identity


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
        return _link_by_email(existing, claims, issuer=issuer, request=request), False, True

    if not claims.email_verified:
        # Keel accounts are keyed by verified addresses only; an unverified one could squat the address
        # its real owner later signs in with.
        raise SignInRefused("email_unverified", log_reason="provider has not verified the address")
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
            raise SignInRefused(
                "account_conflict", log_reason="concurrent account creation for the same address"
            ) from None
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


def _link_by_email(user: User, claims: SignInClaims, *, issuer: str, request) -> User:
    """A sign-in whose address belongs to an existing Keel account: refused, unless automatic linking is on and
    every rule below holds. Each refusal is ``account_conflict`` (the person is told to ask their administrator,
    who can link the account with ``link_workeasy360_user``); the log reason says which rule."""
    if not claims.email_verified:
        raise SignInRefused(
            "email_unverified", log_reason="refusing to link an existing account on an unverified address"
        )
    _require_active(user)
    if ExternalIdentity.objects.filter(user=user).exists():
        # This Keel account already belongs to a Workeasy360 account (another one: the subject was not found).
        raise SignInRefused("account_conflict", log_reason="account is linked to another Workeasy360 identity")
    if not config.link_by_verified_email():
        raise SignInRefused(
            "account_conflict",
            log_reason="a Keel account has this address; linking by email is off (link_workeasy360_user)",
        )
    if user.is_staff or user.is_superuser:
        raise SignInRefused("account_conflict", log_reason="never links a staff account by email")
    if not EmailAddress.objects.filter(user=user, email__iexact=claims.email, verified=True).exists():
        # Nobody proved to Keel that they own the address, so whoever chose this account's password may not be
        # the person Workeasy360 verified (a pre-registered account). Linking it would keep that password.
        raise SignInRefused("account_conflict", log_reason="Keel never verified this account's address")
    organization = _organization_for(claims.organization_id)
    if organization is None:
        raise SignInRefused("account_conflict", log_reason="the token's organization is linked to no Keel organization")
    with system_context(reason="workeasy360.sign_in.link_by_email"):
        memberships = list(Membership.identity.for_user(user).values_list("organization_id", "status"))
    if (organization.pk, Membership.Status.ACTIVE) not in memberships:
        raise SignInRefused(
            "account_conflict", log_reason="account is not an active member of the token's organization"
        )
    if any(org_id != organization.pk for org_id, _status in memberships):
        # The link would open every organization the account belongs to, and Keel-only ones are never checked
        # with Workeasy360: an account in another organization is linked only by an operator.
        raise SignInRefused("account_conflict", log_reason="account belongs to another organization too")
    try:
        link_identity(
            user,
            issuer=issuer,
            subject=claims.subject,
            organization=organization,
            request=request,
            metadata={"method": "workeasy360", "link": "automatic", "rule": "verified_email_same_organization"},
        )
    except IntegrityError:
        raise SignInRefused("account_conflict", log_reason="identity already linked concurrently") from None
    except LinkNotAuditedError:
        raise SignInRefused("unavailable", log_reason="the automatic link could not be audited") from None
    return user


def link_identity(
    user: User,
    *,
    issuer: str,
    subject: str,
    organization: Organization,
    metadata: dict[str, Any],
    request=None,
    by_operator: bool = False,
) -> ExternalIdentity:
    """Bind ``user`` to the Workeasy360 identity (issuer, subject) and audit it, as the person signing in or (with
    ``by_operator``) as the system, the operator named in ``metadata``. The password and the address are left as
    they are. Raises ``IntegrityError`` when either side is linked already (both are unique), and
    ``LinkNotAuditedError`` when the audit record could not be written (no link without its record: the caller's
    transaction undoes it)."""
    with transaction.atomic():
        identity = ExternalIdentity.objects.create(
            user=user, issuer=issuer, subject=subject, last_login_at=timezone.now() if not by_operator else None
        )
    extra: dict[str, Any] = {"actor_type": "system"} if by_operator else {"user": user}
    event = audit.record(
        actions.AUTH_SSO_IDENTITY_LINKED,
        request=request,
        organization_id=organization.pk,
        resource=identity,
        metadata={
            **metadata,
            "issuer": issuer,
            "subject": subject,
            "user_id": str(user.pk),
            "organization_id": str(organization.pk),
            "workeasy360_organization_id": str(organization.workeasy360_organization_id),
            "password_kept": user.has_usable_password(),
        },
        **extra,
    )
    if event is None:
        raise LinkNotAuditedError(str(identity.pk))
    return identity


def _require_active(user: User) -> None:
    if not user.is_active:
        raise SignInRefused("account_disabled", log_reason="WorkEasyCRM account is deactivated")


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
            raise SignInRefused(
                "organization_unavailable", log_reason="organization creation race lost but no row"
            ) from None
        return _require_usable(organization), None
    return membership.organization, membership


def _organization_for(workeasy360_organization_id: uuid.UUID) -> Organization | None:
    with system_context(reason="workeasy360.sign_in.organization"):
        return Organization.objects.filter(workeasy360_organization_id=workeasy360_organization_id).first()


def _require_usable(organization: Organization) -> Organization:
    if organization.status != Organization.Status.ACTIVE:
        raise SignInRefused("organization_unavailable", log_reason=f"organization status {organization.status}")
    return organization


# ----------------------------------------------------------------------------- membership


def _resolve_membership(user: User, organization: Organization, *, request) -> Membership:
    role_key = default_role_key()
    with tenant_context(organization.pk, user_id=user.pk, reason="workeasy360.sign_in.membership"):
        existing = Membership.objects.select_related("role").filter(user=user).first()
        if existing is not None:
            if existing.status != Membership.Status.ACTIVE:
                raise SignInRefused("membership_inactive", log_reason=f"WorkEasyCRM membership is {existing.status}")
            return existing
        try:
            limits.assert_seat_available(organization)
        except DomainError as exc:
            raise SignInRefused("seat_limit", log_reason=str(exc)) from None
        role = Role.objects.get(key=role_key, is_system=True, organization__isnull=True)
        try:
            with transaction.atomic():
                membership = Membership.objects.create(user=user, role=role, joined_at=timezone.now())
        except IntegrityError:
            # The same person's concurrent sign-in created it first.
            existing = Membership.objects.select_related("role").filter(user=user).first()
            if existing is None or existing.status != Membership.Status.ACTIVE:
                raise SignInRefused("membership_inactive", log_reason="membership race") from None
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


# ----------------------------------------------------------------------------- the connector's adapters


class UserAdapter(DefaultUserAdapter):
    """Keel's rules for who signs in (above), in place of the connector's default (issuer, sub) linking."""

    def resolve(self, request: HttpRequest, *, claims: dict[str, Any]) -> tuple[User, FederatedIdentity]:
        signin = read_claims(claims)
        user, _created, _linked = resolve_user(signin, issuer=self.config.issuer, request=request)
        identity = FederatedIdentity.objects.get(issuer=self.config.issuer, subject=signin.subject)
        return user, identity


class OrganizationAdapter(DefaultOrganizationAdapter):
    """The Keel organization and membership for the token's organization. Returns the membership, which the
    callback activates (``SignInResult.binding``)."""

    def bind(
        self, request: HttpRequest, *, user: AbstractBaseUser, organization_id: uuid.UUID, claims: dict[str, Any]
    ) -> Membership:
        membership, _created = resolve_membership(cast(User, user), read_claims(claims), request=request)
        return membership
