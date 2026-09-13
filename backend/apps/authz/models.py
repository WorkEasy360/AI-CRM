from __future__ import annotations

import uuid

from django.db import models

from apps.authz.catalogue import SCOPES


class Role(models.Model):
    """A named permission set. System roles have organization NULL and resolve from code."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        "accounts.Organization", null=True, blank=True, on_delete=models.CASCADE, related_name="custom_roles"
    )
    key = models.SlugField(max_length=40)
    name = models.CharField(max_length=80)
    description = models.CharField(max_length=255, blank=True)
    is_system = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "key"], name="uniq_role_key_per_org", nulls_distinct=False),
        ]

    def __str__(self) -> str:
        return self.name


class RolePermission(models.Model):
    """Grants for custom roles only; system role grants live in apps.authz.roles."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name="grants")
    permission = models.CharField(max_length=64)
    scope = models.CharField(max_length=8, choices=[(s, s) for s in SCOPES])

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["role", "permission"], name="uniq_role_permission"),
        ]

    def __str__(self) -> str:
        return f"{self.permission}:{self.scope}"
