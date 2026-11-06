"""The Actor: the authenticated principal inside a tenant, with resolved grants."""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cached_property
from types import MappingProxyType
from typing import TYPE_CHECKING

from apps.authz.catalogue import SCOPE_ALL, SCOPE_OWN, SCOPE_SUBORDINATES, SCOPE_TEAM
from apps.authz.roles import SYSTEM_ROLES

if TYPE_CHECKING:
    from apps.accounts.models import Membership, Organization, User

#: Session key holding the assurance level (the ``aal`` claim, 1 or 2) of the Workeasy360 sign-in that
#: established the session. Absent for password, passkey and auto-login sessions.
FEDERATED_AAL_SESSION_KEY = "workeasy360_aal"
#: Session key holding the ``sub`` of that sign-in, the person Workeasy360 is asked about while the session
#: lasts (``apps.accounts.workeasy360.entitlement``). "" once looked up and found none (a Keel-only account).
FEDERATED_SUBJECT_SESSION_KEY = "workeasy360_sub"


def federated_aal_from_session(session) -> int | None:
    """The federated assurance level stored in ``session``, or None when the session is not federated."""
    value = session.get(FEDERATED_AAL_SESSION_KEY) if session is not None else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


@dataclass(frozen=True)
class Actor:
    user: User
    membership: Membership
    organization: Organization
    role_key: str
    grants: Mapping[str, str]
    # Set when Workeasy360 signed the user in: its ``aal`` decides whether a second factor was presented.
    federated_aal: int | None = None
    # The Workeasy360 account behind this session ("" for a Keel-only account or an unlinked organization).
    federated_subject: str = ""

    def has(self, permission: str) -> bool:
        return permission in self.grants

    def scope_for(self, permission: str) -> str | None:
        return self.grants.get(permission)

    @cached_property
    def mfa_enabled(self) -> bool:
        from allauth.mfa.models import Authenticator

        return Authenticator.objects.filter(
            user_id=self.user.pk, type__in=[Authenticator.Type.TOTP, Authenticator.Type.WEBAUTHN]
        ).exists()

    @property
    def mfa_required(self) -> bool:
        """True when the organization enforces MFA and this session has not satisfied it.

        Password sessions: satisfied by an enrolled authenticator (allauth then demands it at every
        sign-in). Workeasy360 sessions: satisfied only when the provider vouched for a second factor
        (``aal`` >= 2); a Keel authenticator proves nothing about a sign-in Keel did not perform.
        """
        if not self.organization.require_mfa:
            return False
        if self.federated_aal is not None:
            return self.federated_aal < 2
        return not self.mfa_enabled

    @cached_property
    def team_ids(self) -> frozenset[uuid.UUID]:
        from apps.teams.models import TeamMembership

        return frozenset(
            TeamMembership.objects.filter(membership_id=self.membership.id).values_list("team_id", flat=True)
        )

    @cached_property
    def team_member_ids(self) -> frozenset[uuid.UUID]:
        """Membership ids of everyone sharing a team with the actor (including the actor)."""
        from apps.teams.models import TeamMembership

        if not self.team_ids:
            return frozenset({self.membership.id})
        ids = TeamMembership.objects.filter(team_id__in=self.team_ids).values_list("membership_id", flat=True)
        return frozenset(ids) | {self.membership.id}

    @cached_property
    def subordinate_member_ids(self) -> frozenset[uuid.UUID]:
        """Membership ids in hierarchy roles below the actor's (and peers when the role shares), plus the actor."""
        from apps.authz.hierarchy import subordinate_member_ids

        return subordinate_member_ids(self.membership)

    @cached_property
    def field_rules(self) -> Mapping[str, Mapping[str, str]]:
        """``{entity_type: {field: "hidden" | "read_only"}}`` for the actor's permission set."""
        from apps.authz.fields import rules_for_role

        return rules_for_role(self.membership.role, self.organization.pk)

    def owner_ids_for(self, scope: str | None) -> frozenset[uuid.UUID] | None:
        """Owners a scope reaches: ``None`` means every owner ("all"); empty means nobody."""
        if scope == SCOPE_ALL:
            return None
        if scope == SCOPE_OWN:
            return frozenset({self.membership.id})
        if scope == SCOPE_SUBORDINATES:
            return self.subordinate_member_ids
        if scope == SCOPE_TEAM:
            return self.team_member_ids
        return frozenset()

    def covers_owner(self, permission: str, owner_membership_id: uuid.UUID | None) -> bool:
        scope = self.scope_for(permission)
        if scope is None:
            return False
        owners = self.owner_ids_for(scope)
        if owners is None:
            return True
        return owner_membership_id is not None and owner_membership_id in owners


def resolve_grants(role) -> Mapping[str, str]:
    if role.is_system:
        return SYSTEM_ROLES[role.key].grants
    return MappingProxyType({g.permission: g.scope for g in role.grants.all()})


def build_actor(membership: Membership, *, federated_aal: int | None = None, federated_subject: str = "") -> Actor:
    from apps.core.tenancy.context import TenantContext, bind_context, get_context

    ctx = get_context()
    if ctx is not None and (ctx.is_system or ctx.organization_id == membership.organization_id):
        role, grants = membership.role, resolve_grants(membership.role)
    else:
        # A custom permission set's grants are tenant rows (RLS): read them inside the member's own
        # organization, whatever context the caller is in (the identity-level session middleware).
        org_ctx = TenantContext(
            organization_id=membership.organization_id, user_id=membership.user_id, membership_id=membership.pk
        )
        with bind_context(org_ctx):
            role, grants = membership.role, resolve_grants(membership.role)
    return Actor(
        user=membership.user,
        membership=membership,
        organization=membership.organization,
        role_key=role.key,
        grants=grants,
        federated_aal=federated_aal,
        federated_subject=federated_subject,
    )
