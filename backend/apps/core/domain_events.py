"""Domain events: how a business change announces itself when ``Model.save()`` did not.

``apps.rag.signals`` and ``apps.integrations.signals`` hang off ``post_save``, which covers every
path that writes through an instance. Bulk paths do not write through an instance: ``QuerySet.update()``
is one statement and Django emits no signal for it, so archiving 200 contacts, reassigning a deal in
bulk or moving a deal's stage used to change the database without ever telling the outboxes about it.

This module is the explicit spine for those paths::

    service (bulk archive / stage move / lifecycle promotion)
        |  publish(RecordChanged(...)) inside the caller's transaction
        v
    subscribers  ->  integrations outbox row, RAG index outbox row, dashboard cache bump
        |  all written in that same transaction
        v
    COMMIT   (the row change and its events commit together, or neither does)

``orm_signals_fired`` says whether ``post_save`` already ran for this change. Publishers that went
through ``Model.save()`` set it so the outbox subscribers do not write a second, duplicate event;
subscribers that are cheap and idempotent (the dashboard cache counter) ignore the flag.

Layering: this module is a core primitive and imports no other app. Subscribers register themselves
from their own ``AppConfig.ready()``, which is what lets ``apps.core`` stay below them.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal

import structlog

log = structlog.get_logger(__name__)

Change = Literal[
    "created",
    "updated",
    "archived",
    "restored",
    "reassigned",
    "stage_changed",
    "lifecycle_changed",
    "tagged",
    "untagged",
]

# Changes that must reach the integrations outbox as a plain "the record was updated" event.
UPDATE_CHANGES: frozenset[str] = frozenset(
    {"updated", "archived", "restored", "reassigned", "lifecycle_changed", "tagged", "untagged"}
)


@dataclass(frozen=True, slots=True)
class RecordChanged:
    """One CRM record changed. ``entity_ids`` carries a bulk action's whole batch in one event."""

    organization_id: uuid.UUID
    entity_type: str  # "contact" | "company" | "deal" | "product"
    entity_ids: tuple[uuid.UUID, ...]
    change: str
    owner_id: uuid.UUID | None = None
    owner_changed: bool = False
    orm_signals_fired: bool = False
    fields: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def one(cls, *, entity_id: uuid.UUID, **kwargs) -> RecordChanged:
        return cls(entity_ids=(entity_id,), **kwargs)


@dataclass(frozen=True, slots=True)
class OrganizationCreated:
    """A new organization exists and needs its starting state.

    Modules that require per-tenant seed data (a default sales pipeline today) subscribe to this
    instead of ``apps.accounts`` calling them. Without it, creating an account depends on what a
    pipeline is -- a platform service reaching up into a domain module -- and every future module
    with its own bootstrap would have to edit ``accounts.services`` to get one.
    """

    organization_id: uuid.UUID


Subscriber = Callable[[RecordChanged], None]
BootstrapSubscriber = Callable[[OrganizationCreated], None]
_critical: list[Subscriber] = []
_best_effort: list[Subscriber] = []
_bootstrap: list[BootstrapSubscriber] = []


def subscribe(fn: Subscriber, *, critical: bool) -> None:
    """Register a subscriber. Called once per process from an ``AppConfig.ready()``.

    ``critical=True``  the subscriber writes durable state that must commit with the change
                       (an outbox row). A failure propagates and rolls the whole write back:
                       losing the event silently would leave an external system permanently stale.
    ``critical=False`` best effort (cache invalidation). A failure is logged and swallowed, because
                       a cache that could not be bumped must never fail a customer's save.
    """
    bucket = _critical if critical else _best_effort
    if fn not in bucket:
        bucket.append(fn)


def subscribe_bootstrap(fn: BootstrapSubscriber) -> None:
    """Register per-organization seed work, run inside the transaction that creates the organization.

    Always critical: an organization created without its starting state is broken, so a failure here
    must roll the whole sign-up back rather than leave a half-built tenant.
    """
    if fn not in _bootstrap:
        _bootstrap.append(fn)


def publish_bootstrap(event: OrganizationCreated) -> None:
    for fn in _bootstrap:
        fn(event)


def reset() -> None:
    """Drop every subscriber. Tests only."""
    _critical.clear()
    _best_effort.clear()
    _bootstrap.clear()


def publish(event: RecordChanged) -> None:
    """Deliver ``event`` to every subscriber, inside the caller's transaction."""
    if not event.entity_ids or event.organization_id is None:
        return
    for fn in _critical:
        fn(event)
    for fn in _best_effort:
        try:
            fn(event)
        except Exception as exc:  # pragma: no cover - a best-effort subscriber must never fail a write
            log.warning(
                "domain_events.subscriber_failed",
                subscriber=getattr(fn, "__name__", "?"),
                error=str(exc)[:200],
            )


def publish_many(events: Iterable[RecordChanged]) -> None:
    for event in events:
        publish(event)
