"""Integration identities: the Actor an integration acts as.

An integration never gets its own role. It acts through a real membership (the member who created the
API credential or connected the integration) with the *intersection* of that member's current grants
and the permissions the integration is configured for. Consequences:

- it can never do more than the member could, and never more than its scopes / sharing policy allow;
- record-level scopes (own / team / all) apply exactly as they do to the member;
- when the member is suspended, removed, deactivated or loses the permission, the integration stops
  (every request and every job rebuilds the actor from the database).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from types import MappingProxyType

from apps.authz.actor import Actor, resolve_grants


@dataclass(frozen=True)
class IntegrationActor(Actor):
    credential_id: uuid.UUID | None = None
    connection_id: uuid.UUID | None = None

    @property
    def mfa_required(self) -> bool:
        # A second factor is a property of an interactive sign-in; machine credentials are separate secrets.
        return False

    @property
    def is_integration(self) -> bool:
        return True


def build_integration_actor(
    membership,
    allowed_permissions: frozenset[str],
    *,
    credential_id: uuid.UUID | None = None,
    connection_id: uuid.UUID | None = None,
    require: str | None = None,
) -> IntegrationActor | None:
    """Return the actor, or None when the acting membership can no longer act (fail closed).

    ``require``: a permission the *member* must still hold for the integration to be usable at all
    (``integrations.manage`` for connections), independent of ``allowed_permissions``.
    """
    from apps.accounts.models import Membership, Organization

    if membership is None or membership.status != Membership.Status.ACTIVE:
        return None
    if not membership.user.is_active or membership.organization.status != Organization.Status.ACTIVE:
        return None
    member_grants = resolve_grants(membership.role)
    if require is not None and require not in member_grants:
        return None
    grants = MappingProxyType({p: s for p, s in member_grants.items() if p in allowed_permissions})
    return IntegrationActor(
        user=membership.user,
        membership=membership,
        organization=membership.organization,
        role_key=membership.role.key,
        grants=grants,
        credential_id=credential_id,
        connection_id=connection_id,
    )
