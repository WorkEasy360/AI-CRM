from __future__ import annotations

import uuid

from django.db import models

from apps.authz.catalogue import SCOPES
from apps.core.models import TenantModel


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
    scope = models.CharField(max_length=16, choices=[(s, s) for s in SCOPES])

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["role", "permission"], name="uniq_role_permission"),
        ]

    def __str__(self) -> str:
        return f"{self.permission}:{self.scope}"


class HierarchyRole(TenantModel):
    """A position in the organization's reporting hierarchy (what decides "role and subordinates").

    Separate from ``Role``, which is the permission set (a "profile"): a person has one of each. Members
    see records owned by members in roles below theirs when a permission is granted at the
    ``subordinates`` scope; ``share_with_peers`` widens that to members in the same role.
    """

    name = models.CharField(max_length=80)
    description = models.CharField(max_length=255, blank=True)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    share_with_peers = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_hierarchy_role_name")]
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class FieldPermission(TenantModel):
    """Field-level restriction of a permission set: a field hidden from, or read-only for, a role.

    No row means read/write. ``field`` is an API field name (``email``) or ``custom_data.<key>``.
    """

    class Access(models.TextChoices):
        HIDDEN = "hidden", "Hidden"
        READ_ONLY = "read_only", "Read only"

    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name="field_permissions")
    entity_type = models.CharField(max_length=32)
    field = models.CharField(max_length=80)
    access = models.CharField(max_length=16, choices=Access.choices)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "role", "entity_type", "field"], name="uniq_field_permission"
            )
        ]
        indexes = [models.Index(fields=["organization", "role"], name="fieldperm_org_role_idx")]

    def __str__(self) -> str:
        return f"{self.role_id}:{self.entity_type}.{self.field}={self.access}"
