"""Delivering outbox events: fan-out to destinations, then one attempt per ``OutboundDelivery`` row.

Retry policy: at most ``INTEGRATIONS_MAX_DELIVERY_ATTEMPTS`` attempts with exponential backoff and full
jitter (30 s base, 6 h cap), and never sooner than a provider's ``Retry-After``. Permanent failures
(4xx other than 408/425/429, blocked destinations, lost access) stop at once. The sweeper
(``tasks.drain``) re-enqueues due rows, so a lost task only delays a delivery.
"""

from __future__ import annotations

import datetime as dt
import json
import secrets
import time
import uuid
from typing import Any

import structlog
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.authz.service import scope
from apps.core import crypto
from apps.integrations import alerts, fields, net, signing
from apps.integrations.events import SYNC_EVENT_SUFFIXES
from apps.integrations.identity import build_integration_actor
from apps.integrations.models import (
    ConnectionStatus,
    Direction,
    IntegrationConnection,
    IntegrationEvent,
    OutboundDelivery,
    SharingPolicy,
    WebhookSubscription,
)
from apps.integrations.providers.base import ProviderError

log = structlog.get_logger(__name__)

BACKOFF_BASE_SECONDS = 30
BACKOFF_CAP_SECONDS = 6 * 3600
WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024
WEBHOOK_DISABLE_AFTER_FAILURES = 15


def backoff_seconds(attempt: int, retry_after: int | None = None) -> int:
    """Exponential backoff with full jitter; ``attempt`` starts at 1."""
    ceiling = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2 ** max(0, attempt - 1)))
    delay = BACKOFF_BASE_SECONDS + secrets.randbelow(max(1, ceiling))
    if retry_after is not None:
        delay = max(delay, retry_after)
    return min(delay, BACKOFF_CAP_SECONDS)


# ----------------------------------------------------------------------------- fan-out


def dispatch(event: IntegrationEvent) -> list[OutboundDelivery]:
    """Create one delivery per destination that wants this event. Idempotent (unique per destination)."""
    created: list[OutboundDelivery] = []
    now = timezone.now()
    for subscription in WebhookSubscription.objects.filter(status=WebhookSubscription.Status.ACTIVE):
        if event.event_type in (subscription.event_types or []):
            created += _create_delivery(event, now, subscription=subscription)
    if event.event_type.endswith(SYNC_EVENT_SUFFIXES):
        policies = SharingPolicy.objects.filter(
            entity_type=event.entity_type,
            direction__in=[Direction.OUTBOUND, Direction.TWO_WAY],
            connection__status__in=[ConnectionStatus.CONNECTED, ConnectionStatus.SYNCING, ConnectionStatus.ERROR],
        ).select_related("connection")
        for policy in policies:
            if event.origin_connection_id == policy.connection_id:
                continue  # written by this connection's inbound sync: do not echo it back
            created += _create_delivery(event, now, connection=policy.connection)
    event.status = IntegrationEvent.Status.DISPATCHED
    event.dispatched_at = now
    event.attempts += 1
    event.save(update_fields=["status", "dispatched_at", "attempts", "updated_at"])
    return created


def _create_delivery(event: IntegrationEvent, now: dt.datetime, **target: Any) -> list[OutboundDelivery]:
    try:
        with transaction.atomic():
            return [
                OutboundDelivery.objects.create(
                    source_event=event,
                    event_id=event.pk,
                    event_type=event.event_type,
                    entity_type=event.entity_type,
                    entity_id=event.entity_id,
                    next_attempt_at=now,
                    **target,
                )
            ]
    except IntegrityError:
        return []  # already dispatched to this destination


# ----------------------------------------------------------------------------- one attempt


def attempt(delivery: OutboundDelivery) -> str:
    """Run one attempt and record the outcome on the row. Returns the resulting status."""
    if delivery.status != OutboundDelivery.Status.PENDING:
        return delivery.status
    delivery.attempts += 1
    try:
        status_code = _send_webhook(delivery) if delivery.subscription_id else _push(delivery)
    except ProviderError as exc:
        return _failed(delivery, exc)
    delivery.status = OutboundDelivery.Status.SKIPPED if status_code is None else OutboundDelivery.Status.SUCCEEDED
    delivery.response_status = status_code
    delivery.error_code = ""
    delivery.delivered_at = timezone.now()
    delivery.next_attempt_at = None
    delivery.save(
        update_fields=[
            "status",
            "attempts",
            "response_status",
            "error_code",
            "delivered_at",
            "next_attempt_at",
            "updated_at",
        ]
    )
    return delivery.status


def _failed(delivery: OutboundDelivery, exc: ProviderError) -> str:
    delivery.error_code = exc.code[:64]
    delivery.response_status = exc.status
    if exc.retryable and delivery.attempts < settings.INTEGRATIONS_MAX_DELIVERY_ATTEMPTS:
        delivery.next_attempt_at = timezone.now() + dt.timedelta(
            seconds=backoff_seconds(delivery.attempts, exc.retry_after)
        )
    else:
        delivery.status = OutboundDelivery.Status.DEAD if exc.retryable else OutboundDelivery.Status.FAILED
        delivery.next_attempt_at = None
    delivery.save(
        update_fields=["status", "attempts", "response_status", "error_code", "next_attempt_at", "updated_at"]
    )
    log.info(
        "integrations.delivery_failed",
        delivery_id=str(delivery.pk),
        code=exc.code,
        attempts=delivery.attempts,
        final=delivery.status != OutboundDelivery.Status.PENDING,
    )
    return delivery.status


# ----------------------------------------------------------------------------- connection pushes


def _push(delivery: OutboundDelivery) -> int | None:
    from apps.integrations import sync

    if delivery.connection_id is None or delivery.entity_id is None:
        return None
    connection = IntegrationConnection.objects.filter(pk=delivery.connection_id).first()
    if connection is None:
        return None
    try:
        outcome = sync.push_record(connection, delivery.entity_type, delivery.entity_id)
    except ProviderError as exc:
        if exc.action_required or not exc.retryable:
            sync.record_failure(connection, exc)
        raise
    if outcome == "pushed":
        sync.record_success(connection)
        return 200
    return None


# ----------------------------------------------------------------------------- webhooks


def signing_secrets(subscription: WebhookSubscription) -> list[str]:
    try:
        current = [crypto.decrypt(subscription.secret_enc)]
        if (
            subscription.previous_secret_enc
            and subscription.previous_secret_expires_at
            and subscription.previous_secret_expires_at > timezone.now()
        ):
            current.append(crypto.decrypt(subscription.previous_secret_enc))
    except crypto.DecryptionError as exc:
        raise ProviderError("decrypt_failed") from exc
    return current


def build_payload(delivery: OutboundDelivery, subscription: WebhookSubscription) -> dict[str, Any]:
    source = delivery.source_event
    occurred = source.created_at if source is not None else delivery.created_at
    data: dict[str, Any] = {
        "object": delivery.entity_type or None,
        "id": str(delivery.entity_id) if delivery.entity_id else None,
    }
    if subscription.include_data and delivery.entity_id:
        data["attributes"] = _attributes(delivery, subscription)
    return {
        "id": str(delivery.event_id),
        "type": delivery.event_type,
        "created_at": occurred.isoformat(),
        "data": data,
    }


def _attributes(delivery: OutboundDelivery, subscription: WebhookSubscription) -> dict[str, Any] | None:
    """Allowlisted fields, read through the subscription creator's current authorization."""
    from apps.accounts.models import Membership

    permission = fields.WEBHOOK_ENTITY_PERMISSIONS.get(delivery.entity_type)
    if permission is None:
        return None
    membership = (
        Membership.objects.select_related("user", "role", "organization").filter(pk=subscription.created_by_id).first()
        if subscription.created_by_id
        else None
    )
    actor = build_integration_actor(membership, frozenset({permission}), require="webhooks.manage")
    if actor is None:
        raise ProviderError("member_lost_access", action_required=True)
    model = _model_for(delivery.entity_type)
    related = {"contact": ("company",), "deal": ("stage", "pipeline")}.get(delivery.entity_type, ())
    record = scope(actor, permission, model.objects.filter(pk=delivery.entity_id)).select_related(*related).first()
    return fields.snapshot(delivery.entity_type, record) if record is not None else None


def _model_for(entity_type: str):
    from django.apps import apps as django_apps

    label = {
        "contact": "contacts.Contact",
        "company": "companies.Company",
        "deal": "deals.Deal",
        "activity": "activities.Activity",
    }[entity_type]
    return django_apps.get_model(label)


def _send_webhook(delivery: OutboundDelivery) -> int:
    subscription = (
        WebhookSubscription.objects.filter(pk=delivery.subscription_id).first() if delivery.subscription_id else None
    )
    if subscription is None or subscription.status != WebhookSubscription.Status.ACTIVE:
        raise ProviderError("subscription_inactive")
    try:
        payload = build_payload(delivery, subscription)
    except ProviderError as exc:
        _subscription_failure(subscription, exc.code, disable=exc.action_required)
        raise
    body = json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8")
    timestamp = int(time.time())
    headers = {
        "Content-Type": "application/json",
        "Keel-Event-Id": str(delivery.event_id),
        "Keel-Event-Type": delivery.event_type,
        "Keel-Timestamp": str(timestamp),
        signing.SIGNATURE_HEADER: signing.header_value(signing_secrets(subscription), timestamp, body),
    }
    try:
        response = net.safe_request(
            "POST", subscription.url, content=body, headers=headers, max_bytes=WEBHOOK_MAX_RESPONSE_BYTES
        )
    except net.UnsafeDestination as exc:
        _subscription_failure(subscription, exc.code)
        raise ProviderError(exc.code) from exc
    except net.TransportError as exc:
        _subscription_failure(subscription, exc.code)
        raise ProviderError(exc.code, retryable=exc.code != "response_too_large") from exc
    status = response.status_code
    if 200 <= status < 300:
        WebhookSubscription.objects.filter(pk=subscription.pk).update(
            consecutive_failures=0, last_success_at=timezone.now(), last_error_code="", updated_at=timezone.now()
        )
        return status
    retryable = status in (408, 425, 429) or status >= 500
    code = f"http_{status}"
    _subscription_failure(subscription, code)
    raise ProviderError(code, retryable=retryable, retry_after=net.retry_after_seconds(response), status=status)


def _subscription_failure(subscription: WebhookSubscription, code: str, *, disable: bool = False) -> None:
    now = timezone.now()
    failures = subscription.consecutive_failures + 1
    updates: dict[str, Any] = {
        "consecutive_failures": failures,
        "last_failure_at": now,
        "last_error_code": code[:64],
        "updated_at": now,
    }
    should_disable = disable or failures >= WEBHOOK_DISABLE_AFTER_FAILURES
    if should_disable and subscription.status == WebhookSubscription.Status.ACTIVE:
        updates["status"] = WebhookSubscription.Status.DISABLED
    WebhookSubscription.objects.filter(pk=subscription.pk).update(**updates)
    subscription.consecutive_failures = failures
    if updates.get("status") == WebhookSubscription.Status.DISABLED:
        from apps.integrations.events import invalidate_targets

        invalidate_targets(subscription.organization_id)
        alerts.webhook_disabled(subscription, code)


def send_test(subscription: WebhookSubscription) -> OutboundDelivery:
    """A signed ``ping`` delivered right away (one attempt, no retries)."""
    delivery = OutboundDelivery.objects.create(
        subscription=subscription, event_id=uuid.uuid4(), event_type="ping", next_attempt_at=timezone.now()
    )
    delivery.attempts = settings.INTEGRATIONS_MAX_DELIVERY_ATTEMPTS - 1  # a test is never retried
    delivery.save(update_fields=["attempts"])
    attempt(delivery)
    return delivery
