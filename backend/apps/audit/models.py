from __future__ import annotations

import uuid

from django.db import models

from apps.core.exceptions import TenantContextMissing
from apps.core.tenancy.context import get_context


class AuditEventManager(models.Manager):
    """Tenant-scoped reads. Events without an organization (e.g. failed logins) are system-only."""

    def get_queryset(self) -> models.QuerySet:
        ctx = get_context()
        if ctx is None:
            raise TenantContextMissing("AuditEvent.objects used without a tenant context.")
        qs = super().get_queryset()
        if ctx.is_system:
            return qs
        return qs.filter(organization_id=ctx.organization_id)


class AuditEvent(models.Model):
    class ActorType(models.TextChoices):
        USER = "user", "User"
        SYSTEM = "system", "System"
        AI = "ai", "AI"
        INTEGRATION = "integration", "Integration"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        "accounts.Organization", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    actor_user = models.ForeignKey("accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    actor_type = models.CharField(max_length=16, choices=ActorType.choices, default=ActorType.USER)
    action = models.CharField(max_length=64)
    resource_type = models.CharField(max_length=64, blank=True)
    resource_id = models.CharField(max_length=64, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent_hash = models.CharField(max_length=64, blank=True)
    request_id = models.CharField(max_length=64, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = AuditEventManager()

    class Meta:
        indexes = [
            models.Index(fields=["organization", "-created_at"], name="audit_org_created_idx"),
            models.Index(fields=["organization", "resource_type", "resource_id"], name="audit_org_resource_idx"),
            models.Index(fields=["organization", "action", "-created_at"], name="audit_org_action_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.action} ({self.created_at:%Y-%m-%d %H:%M:%S})"
