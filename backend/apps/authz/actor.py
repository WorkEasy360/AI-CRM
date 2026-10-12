"""The Actor: the authenticated principal inside a tenant, with resolved grants."""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cached_property
from types import MappingProxyType
from typing import TYPE_CHECKING

from apps.authz.catalogue import SCOPE_ALL, SCOPE_OWN, SCOPE_TEAM
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

    def covers_owner(self, permission: str, owner_membership_id: uuid.UUID | None) -> bool:
        scope = self.scope_for(permission)
        if scope is None:
            return False
        if scope == SCOPE_ALL:
            return True
        if owner_membership_id is None:
            return False
        if scope == SCOPE_OWN:
            return owner_membership_id == self.membership.id
        if scope == SCOPE_TEAM:
            return owner_membership_id in self.team_member_ids
        return False


def resolve_grants(role) -> Mapping[str, str]:
    if role.is_system:
        return SYSTEM_ROLES[role.key].grants
    return MappingProxyType({g.permission: g.scope for g in role.grants.all()})


def build_actor(membership: Membership, *, federated_aal: int | None = None, federated_subject: str = "") -> Actor:
    return Actor(
        user=membership.user,
        membership=membership,
        organization=membership.organization,
        role_key=membership.role.key,
        grants=resolve_grants(membership.role),
        federated_aal=federated_aal,
        federated_subject=federated_subject,
    )
