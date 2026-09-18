"""Integration background jobs, all on the dedicated ``integrations`` queue.

External APIs are slow and fail in bursts; keeping this work on its own queue means a stuck provider
never delays notifications, email, RAG indexing, imports or exports. Every task is tenant-bound
(``tenant_task``) except the sweeper, which only reads ids across tenants and re-enqueues per tenant.
"""

from __future__ import annotations

import functools
import uuid
from datetime import timedelta

import structlog
from celery import shared_task
from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from apps.core.exceptions import DomainError
from apps.core.tenancy.context import system_context
from apps.core.tenancy.tasks import tenant_task

log = structlog.get_logger(__name__)

SWEEP_LIMIT = 500


@tenant_task(name="integrations.dispatch_event", ignore_result=True, soft_time_limit=60, time_limit=90)
def dispatch_event(*, event_id: str, organization_id, **kwargs) -> int:
    from django.db import transaction

    from apps.integrations import delivery
    from apps.integrations.models import IntegrationEvent

    event = (
        IntegrationEvent.objects.select_for_update(skip_locked=True)
        .filter(pk=uuid.UUID(event_id), status=IntegrationEvent.Status.PENDING)
        .first()
    )
    if event is None:
        return 0
    created = delivery.dispatch(event)
    org = str(organization_id)
    for item in created:
        transaction.on_commit(functools.partial(_enqueue_delivery, str(item.pk), org))
    return len(created)


def _enqueue_delivery(delivery_id: str, organization_id: str) -> None:
    deliver.delay(delivery_id=delivery_id, organization_id=organization_id)


@tenant_task(name="integrations.deliver", ignore_result=True, soft_time_limit=60, time_limit=90)
def deliver(*, delivery_id: str, organization_id, **kwargs) -> str:
    from apps.integrations import delivery
    from apps.integrations.models import OutboundDelivery

    row = (
        OutboundDelivery.objects.select_for_update(skip_locked=True, of=("self",))
        .filter(pk=uuid.UUID(delivery_id), status=OutboundDelivery.Status.PENDING)
        .first()
    )
    if row is None:
        return "skipped"
    if row.next_attempt_at and row.next_attempt_at > timezone.now():
        return "not_due"
    return delivery.attempt(row)


@tenant_task(name="integrations.run_sync_job", ignore_result=True, soft_time_limit=240, time_limit=300)
def run_sync_job(*, job_id: str, organization_id, **kwargs) -> str:
    """One batch per invocation; re-enqueues itself until the job is done."""
    from django.db import transaction

    from apps.integrations import sync
    from apps.integrations.models import ConnectionStatus, IntegrationConnection, SyncJob
    from apps.integrations.providers.base import ProviderError

    job = (
        SyncJob.objects.select_for_update(skip_locked=True, of=("self",))
        .select_related("connection")
        .filter(pk=uuid.UUID(job_id), status__in=[SyncJob.Status.PENDING, SyncJob.Status.PROCESSING])
        .first()
    )
    if job is None:
        return "skipped"
    if job.next_attempt_at and job.next_attempt_at > timezone.now():
        return "not_due"
    connection = job.connection
    if connection.status == ConnectionStatus.DISABLED or connection.status == ConnectionStatus.DISCONNECTED:
        job.status, job.error_code, job.finished_at = SyncJob.Status.FAILED, "connection_inactive", timezone.now()
        job.save()
        return "cancelled"
    if job.status == SyncJob.Status.PENDING:
        job.status, job.started_at = SyncJob.Status.PROCESSING, job.started_at or timezone.now()
        job.next_attempt_at = None
        IntegrationConnection.objects.filter(pk=connection.pk).update(status=ConnectionStatus.SYNCING)
        connection.status = ConnectionStatus.SYNCING
    try:
        more = sync.run_job_batch(job)
    except ProviderError as exc:
        retries = int((job.state or {}).get("retries", 0))
        if exc.retryable and retries < settings.INTEGRATIONS_MAX_DELIVERY_ATTEMPTS:
            from apps.integrations.delivery import backoff_seconds

            delay = backoff_seconds(retries + 1, exc.retry_after)
            # The wait is recorded on the row, not parked in the broker. A backoff can reach hours;
            # a Celery countdown that long exceeds the Redis visibility timeout, at which point the
            # broker hands the same message to a second worker while the first still owns it.
            job.state = {**(job.state or {}), "retries": retries + 1}
            job.status = SyncJob.Status.PENDING
            job.next_attempt_at = timezone.now() + timedelta(seconds=delay)
            job.save()
            return "retry_scheduled"
        sync.finish_job(job, error=exc)
        return "failed"
    if more:
        job.save()
        org = str(organization_id)
        transaction.on_commit(lambda: run_sync_job.delay(job_id=job_id, organization_id=org))
        return "continuing"
    sync.finish_job(job)
    return "completed"


@tenant_task(name="integrations.process_inbound_event", ignore_result=True, soft_time_limit=120, time_limit=150)
def process_inbound_event(*, event_id: str, organization_id, **kwargs) -> str:
    from apps.integrations import webhooks
    from apps.integrations.models import InboundEvent

    event = (
        InboundEvent.objects.select_for_update(skip_locked=True, of=("self",))
        .select_related("connection")
        .filter(pk=uuid.UUID(event_id), status=InboundEvent.Status.RECEIVED)
        .first()
    )
    if event is None:
        return "skipped"
    return webhooks.process_inbound(event)


@shared_task(name="integrations.drain", ignore_result=True, soft_time_limit=50, time_limit=55)
def drain() -> dict[str, int]:
    """Beat safety net: re-enqueue lost dispatches, due retries, stale jobs and scheduled syncs."""
    from apps.integrations.models import (
        ConnectionStatus,
        IntegrationConnection,
        IntegrationEvent,
        OutboundDelivery,
        SyncJob,
    )

    now = timezone.now()
    # Cross-tenant on purpose: a system sweep that reads only ids and organization ids and hands each row
    # to a tenant-bound task; no CRM data or credentials are read here.
    with system_context("integrations.drain"):
        pending_events = list(
            IntegrationEvent.all_objects.filter(  # nosemgrep: keel-unscoped-manager-outside-system-code
                status=IntegrationEvent.Status.PENDING, created_at__lt=now - timedelta(seconds=30)
            ).values_list("pk", "organization_id")[:SWEEP_LIMIT]
        )
        due_deliveries = list(
            OutboundDelivery.all_objects.filter(  # nosemgrep: keel-unscoped-manager-outside-system-code
                status=OutboundDelivery.Status.PENDING, next_attempt_at__lte=now
            )
            .order_by("next_attempt_at")
            .values_list("pk", "organization_id")[:SWEEP_LIMIT]
        )
        # Stale jobs *and* jobs whose backoff has come due. Q(next_attempt_at__gt=now) is excluded so
        # a job deliberately waiting out a provider outage is not dragged back in after ten minutes.
        stale_jobs = list(
            SyncJob.all_objects.filter(  # nosemgrep: keel-unscoped-manager-outside-system-code
                status__in=[SyncJob.Status.PENDING, SyncJob.Status.PROCESSING],
                updated_at__lt=now - timedelta(minutes=10),
            )
            .filter(Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now))
            .values_list("pk", "organization_id")[:100]
        )
        due_retries = list(
            SyncJob.all_objects.filter(  # nosemgrep: keel-unscoped-manager-outside-system-code
                status=SyncJob.Status.PENDING, next_attempt_at__lte=now
            )
            .order_by("next_attempt_at")
            .values_list("pk", "organization_id")[:100]
        )
        due_connections = list(
            IntegrationConnection.all_objects.filter(  # nosemgrep: keel-unscoped-manager-outside-system-code
                status__in=[ConnectionStatus.CONNECTED, ConnectionStatus.ERROR],
                sync_interval_minutes__gt=0,
                next_sync_at__lte=now,
            ).values_list("pk", "organization_id")[:100]
        )
    for pk, org in pending_events:
        dispatch_event.delay(event_id=str(pk), organization_id=str(org))
    for pk, org in due_deliveries:
        deliver.delay(delivery_id=str(pk), organization_id=str(org))
    for pk, org in {*stale_jobs, *due_retries}:
        run_sync_job.delay(job_id=str(pk), organization_id=str(org))
    for pk, org in due_connections:
        schedule_sync.delay(connection_id=str(pk), organization_id=str(org))
    return {
        "events": len(pending_events),
        "deliveries": len(due_deliveries),
        "jobs": len(stale_jobs),
        "scheduled": len(due_connections),
    }


@tenant_task(name="integrations.schedule_sync", ignore_result=True, soft_time_limit=30, time_limit=45)
def schedule_sync(*, connection_id: str, organization_id, **kwargs) -> str:
    from apps.integrations import services
    from apps.integrations.models import IntegrationConnection, SyncJob

    connection = (
        IntegrationConnection.objects.select_for_update(skip_locked=True).filter(pk=uuid.UUID(connection_id)).first()
    )
    if connection is None or not connection.sync_interval_minutes:
        return "skipped"
    IntegrationConnection.objects.filter(pk=connection.pk).update(
        next_sync_at=timezone.now() + timedelta(minutes=connection.sync_interval_minutes)
    )
    try:
        services.start_sync(None, connection, trigger=SyncJob.Trigger.SCHEDULED)
    except DomainError as exc:
        return exc.code
    return "started"
