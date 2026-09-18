"""Transactional outbox for integrations.

    CRM transaction (contact saved, deal moved, task completed)
        |  IntegrationEvent row written here, in the same transaction
        v
    COMMIT  ->  integrations.dispatch_event (integrations queue)
        |  one OutboundDelivery per matching webhook subscription / outbound connection
        v
    integrations.deliver  ->  policy + record authorization + field allowlist  ->  external system

A rollback removes the event with the CRM change. A lost enqueue leaves the event ``pending`` for
the sweeper. A slow or failing external system never blocks or fails the CRM write: nothing here
calls out over the network.

Only organizations that actually have an active subscription or outbound sharing policy pay for an
outbox row; that answer is cached per organization and invalidated whenever the configuration changes.
"""

from __future__ import annotations

import contextlib
import uuid
from collections.abc import Iterator
from contextvars import ContextVar

import structlog
from django.core.cache import cache
from django.db import transaction

from apps.core.tenancy.context import get_context

log = structlog.get_logger(__name__)

WEBHOOK_EVENT_TYPES: tuple[str, ...] = (
    "contact.created",
    "contact.updated",
    "company.created",
    "company.updated",
    "deal.created",
    "deal.updated",
    "deal.stage_changed",
    "task.completed",
)
SYNC_EVENT_SUFFIXES = (".created", ".updated")
_TARGETS_TTL = 300

# The connection whose inbound data is being written right now: its own changes are not echoed back to it.
_origin: ContextVar[uuid.UUID | None] = ContextVar("integration_origin", default=None)


@contextlib.contextmanager
def inbound_origin(connection_id: uuid.UUID) -> Iterator[None]:
    token = _origin.set(connection_id)
    try:
        yield
    finally:
        _origin.reset(token)


def _targets_key(organization_id: uuid.UUID) -> str:
    return f"integrations:targets:{organization_id}"


def invalidate_targets(organization_id: uuid.UUID) -> None:
    cache.delete(_targets_key(organization_id))


def targets(organization_id: uuid.UUID) -> dict[str, list[str]]:
    """Event types with an active webhook subscription and entity types with outbound sharing."""
    key = _targets_key(organization_id)
    cached = cache.get(key)
    if cached is not None:
        return cached
    from apps.integrations.models import ConnectionStatus, Direction, SharingPolicy, WebhookSubscription

    events: set[str] = set()
    for event_types in WebhookSubscription.objects.filter(
        organization_id=organization_id, status=WebhookSubscription.Status.ACTIVE
    ).values_list("event_types", flat=True):
        events.update(t for t in (event_types or []) if t in WEBHOOK_EVENT_TYPES)
    entities = set(
        SharingPolicy.objects.filter(
            organization_id=organization_id,
            direction__in=[Direction.OUTBOUND, Direction.TWO_WAY],
            connection__status__in=[ConnectionStatus.CONNECTED, ConnectionStatus.SYNCING, ConnectionStatus.ERROR],
        ).values_list("entity_type", flat=True)
    )
    value = {"events": sorted(events), "entities": sorted(entities)}
    cache.set(key, value, _TARGETS_TTL)
    return value


def emit(*, organization_id: uuid.UUID, event_type: str, entity_type: str, entity_id: uuid.UUID) -> None:
    """Record a CRM change for integrations, inside the caller's transaction."""
    ctx = get_context()
    if ctx is None or (not ctx.is_system and ctx.organization_id != organization_id):
        # Writes always run in their tenant context; anything else is a bug elsewhere, not a reason to
        # fail the CRM write. Logged so it is visible.
        log.warning("integrations.emit_without_context", event_type=event_type)
        return
    wanted = targets(organization_id)
    is_sync = entity_type in wanted["entities"] and event_type.endswith(SYNC_EVENT_SUFFIXES)
    if event_type not in wanted["events"] and not is_sync:
        return
    from apps.integrations.models import IntegrationEvent

    event = IntegrationEvent.objects.create(
        organization_id=organization_id,
        event_type=event_type,
        entity_type=entity_type,
        entity_id=entity_id,
        origin_connection_id=_origin.get(),
    )
    event_pk = event.pk
    transaction.on_commit(lambda: _schedule_dispatch(event_pk, organization_id))


def _schedule_dispatch(event_id: uuid.UUID, organization_id: uuid.UUID) -> None:
    from apps.integrations import tasks

    try:
        tasks.dispatch_event.delay(event_id=str(event_id), organization_id=str(organization_id))
    except Exception as exc:  # pragma: no cover - broker down: the sweeper retries
        log.warning("integrations.enqueue_failed", error=type(exc).__name__)
