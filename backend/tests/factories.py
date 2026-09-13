"""Test data helpers plus the registry the generated cross-tenant tests use.

Every tenant-owned model exposed through the API must have a factory here; the generated test
fails otherwise, which forces new resources to be covered by isolation tests.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from allauth.account.models import EmailAddress

from apps.accounts import services as account_services
from apps.accounts.models import Invitation, Membership, Organization, User
from apps.audit import service as audit
from apps.audit.models import AuditEvent
from apps.authz.models import Role
from apps.core.tenancy.context import tenant_context
from apps.teams.models import Team
from tests.testapp.models import Widget

DEFAULT_PASSWORD = "Str0ng-Passw0rd-123!"


@dataclass
class OrgBundle:
    org: Organization
    owner: User
    owner_membership: Membership


def make_user(
    email: str | None = None, *, password: str = DEFAULT_PASSWORD, verified: bool = True, first_name: str = "Test"
) -> User:
    email = email or f"user-{uuid.uuid4().hex[:10]}@example.com"
    user = User.objects.create_user(email=email, password=password, first_name=first_name)
    EmailAddress.objects.create(user=user, email=user.email, verified=verified, primary=True)
    return user


def make_org(name: str | None = None, *, owner: User | None = None) -> OrgBundle:
    owner = owner or make_user()
    membership = account_services.create_organization(owner, name=name or f"Org {uuid.uuid4().hex[:6]}")
    return OrgBundle(org=membership.organization, owner=owner, owner_membership=membership)


def make_member(bundle: OrgBundle, role_key: str = "sales_rep", *, user: User | None = None) -> Membership:
    user = user or make_user()
    with tenant_context(bundle.org.pk, user_id=bundle.owner.pk, reason="test.make_member"):
        role = Role.objects.get(key=role_key, is_system=True, organization__isnull=True)
        return Membership.objects.create(user=user, role=role)


def make_widget(bundle: OrgBundle, *, owner: Membership | None = None, name: str = "widget") -> Widget:
    with tenant_context(bundle.org.pk, reason="test.make_widget"):
        return Widget.objects.create(name=name, owner=owner or bundle.owner_membership)


def make_team(bundle: OrgBundle, name: str = "Team A") -> Team:
    with tenant_context(bundle.org.pk, reason="test.make_team"):
        return Team.objects.create(name=name)


def make_invitation(bundle: OrgBundle, email: str | None = None, role_key: str = "sales_rep") -> Invitation:
    from apps.authz.actor import build_actor

    with tenant_context(
        bundle.org.pk, user_id=bundle.owner.pk, membership_id=bundle.owner_membership.pk, reason="test.make_invitation"
    ):
        membership = Membership.objects.select_related("user", "role", "organization").get(
            pk=bundle.owner_membership.pk
        )
        return account_services.invite_member(
            build_actor(membership), email=email or f"inv-{uuid.uuid4().hex[:8]}@example.com", role_key=role_key
        )


def make_audit_event(bundle: OrgBundle) -> AuditEvent:
    with tenant_context(bundle.org.pk, reason="test.make_audit_event"):
        event = audit.record("test.event", organization_id=bundle.org.pk, metadata={"k": "v"})
    assert event is not None
    return event


# model -> callable(bundle) -> instance, used by tests/tenant_isolation/test_generated.py
CROSS_TENANT_FACTORIES = {
    Membership: lambda bundle: make_member(bundle),
    Invitation: lambda bundle: make_invitation(bundle),
    Team: lambda bundle: make_team(bundle),
    AuditEvent: lambda bundle: make_audit_event(bundle),
    Widget: lambda bundle: make_widget(bundle),
}
