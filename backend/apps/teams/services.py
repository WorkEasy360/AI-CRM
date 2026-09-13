from __future__ import annotations

from django.db import transaction

from apps.accounts.models import Membership
from apps.audit import actions
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.core.exceptions import ConflictError, DomainError
from apps.teams.models import Team, TeamMembership


@transaction.atomic
def create_team(actor: Actor, *, name: str, manager: Membership | None = None, request=None) -> Team:
    check(actor, "teams.manage")
    if Team.objects.filter(name__iexact=name).exists():
        raise ConflictError("A team with this name already exists.", code="team_name_taken")
    team = Team.objects.create(name=name, manager=manager)
    audit.record(actions.TEAM_CREATED, request=request, user=actor.user, resource=team, metadata={"name": name})
    return team


@transaction.atomic
def update_team(
    actor: Actor,
    team: Team,
    *,
    name: str | None = None,
    manager: Membership | None = None,
    clear_manager: bool = False,
    request=None,
) -> Team:
    check(actor, "teams.manage", team)
    if name is not None and name.lower() != team.name.lower() and Team.objects.filter(name__iexact=name).exists():
        raise ConflictError("A team with this name already exists.", code="team_name_taken")
    if name is not None:
        team.name = name
    if clear_manager:
        team.manager = None
    elif manager is not None:
        team.manager = manager
    team.save(update_fields=["name", "manager", "updated_at"])
    audit.record(actions.TEAM_UPDATED, request=request, user=actor.user, resource=team)
    return team


@transaction.atomic
def delete_team(actor: Actor, team: Team, *, request=None) -> None:
    check(actor, "teams.manage", team)
    team_id = team.pk
    team.delete()
    audit.record(actions.TEAM_DELETED, request=request, user=actor.user, resource_type="team", resource_id=team_id)


@transaction.atomic
def add_member(actor: Actor, team: Team, membership: Membership, *, request=None) -> TeamMembership:
    check(actor, "teams.manage", team)
    if membership.status != Membership.Status.ACTIVE:
        raise DomainError("Only active members can join a team.", code="member_not_active")
    tm, created = TeamMembership.objects.get_or_create(team=team, membership=membership)
    if created:
        audit.record(
            actions.TEAM_MEMBER_ADDED,
            request=request,
            user=actor.user,
            resource=team,
            metadata={"membership_id": str(membership.pk)},
        )
    return tm


@transaction.atomic
def remove_member(actor: Actor, team: Team, membership: Membership, *, request=None) -> None:
    check(actor, "teams.manage", team)
    deleted, _ = TeamMembership.objects.filter(team=team, membership=membership).delete()
    if deleted:
        audit.record(
            actions.TEAM_MEMBER_REMOVED,
            request=request,
            user=actor.user,
            resource=team,
            metadata={"membership_id": str(membership.pk)},
        )
