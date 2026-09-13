"""Base models and managers that make tenant scoping the default, not an afterthought."""

from __future__ import annotations

import uuid
from typing import Any, ClassVar

from django.db import models

from apps.core.exceptions import (
    CrossTenantWriteError,
    ImmutableTenantError,
    TenantContextMissing,
    UnscopedAccessError,
)
from apps.core.tenancy.context import get_context


class TimestampedModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class TenantManager(models.Manager):
    """Default manager for tenant-owned models: always filtered by the bound organization.

    Without a bound context it raises instead of returning everything (fail closed).
    Subclasses may set ``_queryset_class`` to expose custom queryset helpers.
    """

    def get_queryset(self) -> models.QuerySet:
        ctx = get_context()
        if ctx is None:
            raise TenantContextMissing(f"{self.model.__name__}.objects used without a tenant context.")
        qs = super().get_queryset()
        if ctx.is_system:
            return qs
        if ctx.organization_id is None:
            raise TenantContextMissing(f"{self.model.__name__}.objects used without an organization.")
        return qs.filter(organization_id=ctx.organization_id)


class UnscopedManager(models.Manager):
    """Explicit cross-tenant access. Usable only inside ``system_context(reason=...)``."""

    def get_queryset(self) -> models.QuerySet:
        ctx = get_context()
        if ctx is None or not ctx.is_system:
            raise UnscopedAccessError(f"{self.model.__name__}.all_objects requires system_context(reason=...).")
        return super().get_queryset()


class TenantModel(TimestampedModel):
    """Every tenant-owned record inherits from this.

    - ``organization`` is set from the bound context on create and can never change.
    - ``objects`` is tenant-scoped; ``all_objects`` requires a system context.
    - Subclasses with an owner should set ``OWNER_FIELD`` so authorization scopes apply.
    """

    OWNER_FIELD: ClassVar[str | None] = None

    organization = models.ForeignKey(
        "accounts.Organization",
        on_delete=models.CASCADE,
        editable=False,
        related_name="+",
    )

    objects = TenantManager()
    all_objects = UnscopedManager()

    class Meta:
        abstract = True

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._original_organization_id = self.organization_id

    def save(self, *args: Any, **kwargs: Any) -> None:
        ctx = get_context()
        if ctx is None:
            raise TenantContextMissing(f"Cannot save {type(self).__name__} without a tenant context.")
        if self._state.adding:
            if self.organization_id is None:
                if ctx.organization_id is None:
                    raise TenantContextMissing(f"Cannot create {type(self).__name__}: no organization in context.")
                self.organization_id = ctx.organization_id
            elif not ctx.is_system and self.organization_id != ctx.organization_id:
                raise CrossTenantWriteError(f"Cannot create {type(self).__name__} for another organization.")
        else:
            if self._original_organization_id is not None and self.organization_id != self._original_organization_id:
                raise ImmutableTenantError("organization cannot be changed after creation.")
            if not ctx.is_system and self.organization_id != ctx.organization_id:
                raise CrossTenantWriteError(f"Cannot update {type(self).__name__} of another organization.")
        super().save(*args, **kwargs)
        self._original_organization_id = self.organization_id


class OwnedModel(models.Model):
    """Tenant record with an owner membership. ``owner`` drives the own/team scopes in ``authz.scope``."""

    OWNER_FIELD: ClassVar[str | None] = "owner"

    owner = models.ForeignKey("accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        abstract = True


class VersionedModel(models.Model):
    """Optimistic concurrency (ADR-0007): every update must match the version the client last saw."""

    version = models.PositiveIntegerField(default=1)

    class Meta:
        abstract = True


class ArchivableModel(models.Model):
    """Soft delete: ``archived_at`` hides the record from lists and search; restorable by owner/admin."""

    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        abstract = True

    @property
    def is_archived(self) -> bool:
        return self.archived_at is not None


class CrmRecord(TenantModel, OwnedModel, VersionedModel, ArchivableModel):
    """Base for customer-facing CRM records (contacts, companies, deals, products)."""

    # TenantModel declares OWNER_FIELD = None first in the MRO; restate it so own/team scopes apply.
    OWNER_FIELD: ClassVar[str | None] = "owner"

    custom_data = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+", editable=False
    )
    updated_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+", editable=False
    )

    class Meta:
        abstract = True
