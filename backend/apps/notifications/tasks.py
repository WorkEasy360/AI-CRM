"""Daily deal health sweep: inactivity warnings and high-risk alerts for deal owners."""

from __future__ import annotations

import uuid
from datetime import timedelta

import structlog
from celery import shared_task
from django.utils import timezone

from apps.core.tenancy.context import system_context, tenant_context
from apps.deals.models import Deal

log = structlog.get_logger(__name__)

DEALS_PER_ORG = 2000


@shared_task(name="notifications.deal_health_sweep", ignore_result=True, soft_time_limit=540, time_limit=600)
def deal_health_sweep() -> int:
    """Once a day: warn owners about stale open deals and deals that became high risk."""
    from apps.ai.risk import assess_deal
    from apps.notifications import service as notifications
    from apps.notifications.models import NotificationPreference

    now = timezone.now()
    with system_context("notifications.deal_health_sweep"):
        org_ids = list(
            Deal.all_objects.filter(status=Deal.Status.OPEN, archived_at__isnull=True)
            .values_list("organization_id", flat=True)
            .distinct()
        )
    created = 0
    for org_id in org_ids:
        with tenant_context(uuid.UUID(str(org_id)), reason="task:notifications.deal_health_sweep"):
            thresholds = {
                p.membership_id: p.deal_inactive_days
                for p in NotificationPreference.objects.all().only("membership_id", "deal_inactive_days")
            }
            deals = (
                Deal.objects.filter(status=Deal.Status.OPEN, archived_at__isnull=True, owner__isnull=False)
                .select_related("stage")
                .order_by("last_activity_at")[:DEALS_PER_ORG]
            )
            for deal in deals:
                owner_id = deal.owner_id
                if owner_id is None:
                    continue
                days = thresholds.get(owner_id, 14)
                last = deal.last_activity_at or deal.stage_entered_at or deal.created_at
                if days and last and last < now - timedelta(days=days):
                    idle = (now - last).days
                    if notifications.notify(
                        owner_id,
                        kind="deal_inactive",
                        title=f"{deal.name} has had no activity for {idle} days",
                        body="Schedule a follow-up or update the deal so it does not go cold.",
                        entity_type="deal",
                        entity_id=deal.pk,
                    ):
                        created += 1
                risk = assess_deal(deal)
                if risk.level == "high" and notifications.notify(
                    owner_id,
                    kind="ai_high_risk",
                    title=f"{deal.name} is at high risk",
                    body="; ".join(risk.reasons[:2])[:500],
                    entity_type="deal",
                    entity_id=deal.pk,
                ):
                    created += 1
    if created:
        log.info("notifications.deal_health_sweep", created=created)
    return created
