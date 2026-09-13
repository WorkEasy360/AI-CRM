from __future__ import annotations

from django.db import models

from apps.core.models import TenantModel


class Team(TenantModel):
    name = models.CharField(max_length=80)
    manager = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="managed_teams"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "name"], name="uniq_team_name_per_org"),
        ]
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class TeamMembership(TenantModel):
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="members")
    membership = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="team_memberships")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["team", "membership"], name="uniq_team_membership"),
        ]
        indexes = [models.Index(fields=["organization", "membership"], name="teammember_org_member_idx")]
