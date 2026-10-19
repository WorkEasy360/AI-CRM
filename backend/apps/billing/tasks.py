"""Periodic usage reconciliation: counters are re-derived from the modules that own the rows."""

from __future__ import annotations

import structlog
from celery import shared_task

from apps.core.tenancy.context import system_context, tenant_context

log = structlog.get_logger(__name__)


@shared_task(name="billing.reconcile_usage", ignore_result=True, soft_time_limit=1500, time_limit=1800)
def reconcile_usage() -> int:
    """Beat: correct running counters (records) that drifted through paths that skip the service layer
    (privacy erasure, purges). Returns the number of organizations corrected."""
    from apps.accounts.models import Organization
    from apps.billing import entitlements

    with system_context("billing.reconcile_usage"):
        orgs = list(Organization.objects.values_list("pk", flat=True))
    corrected = 0
    for org_id in orgs:
        with tenant_context(org_id, reason="task:billing.reconcile_usage"):
            org = Organization.objects.get(pk=org_id)
            changes = entitlements.reconcile(org)
        if changes:
            corrected += 1
            log.info("billing.usage_reconciled", organization_id=str(org_id), changes=changes)
    return corrected
