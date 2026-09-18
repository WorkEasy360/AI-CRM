"""Webhooks: outbound subscriptions (organization → external URL) and the inbound receiver.

Inbound requests are machine-to-machine and unauthenticated by session. A request is accepted only if,
in order: the body is within the size limit; the URL key matches an enabled connection; the per-
connection rate limit allows it; the ``Keel-Signature`` HMAC over timestamp + body verifies with the
connection's secret (or the previous one during rotation) and the timestamp is within five minutes;
the event id is present; the JSON matches the provider's schema. A repeated event id is acknowledged
and ignored. Accepted events are processed asynchronously through ``sync.apply_inbound``.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import timedelta
from typing import Any

import structlog
from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import actions
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.reauth import require_recent_auth
from apps.authz.service import check
from apps.core import crypto, validators
from apps.core.exceptions import DomainError
from apps.core.tenancy.context import system_context, tenant_context
from apps.integrations import events, fields, net, signing
from apps.integrations.models import ConnectionStatus, InboundEvent, IntegrationConnection, WebhookSubscription
from apps.integrations.providers import get_provider
from apps.integrations.providers.base import ProviderError
from apps.integrations.sync import provider_context

log = structlog.get_logger(__name__)

MAX_SUBSCRIPTIONS_PER_ORG = 20
MAX_INBOUND_BODY_BYTES = 256 * 1024
SECRET_ROTATION_OVERLAP = timedelta(hours=24)
_KEY_RE = re.compile(r"^[A-Za-z0-9_\-]{20,128}$")
_EVENT_ID_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,128}$")


# ----------------------------------------------------------------------------- outbound subscriptions


def _clean_destination(url: str) -> str:
    url = (url or "").strip()
    try:
        target = net.validate_url(url)
        net.resolve(target.host, target.port)
    except net.UnsafeDestination as exc:
        raise ValidationError({"url": exc.message}) from exc
    except net.TransportError as exc:
        raise ValidationError({"url": "This address could not be found."}) from exc
    if "#" in url:
        raise ValidationError({"url": "Remove the #fragment from the URL."})
    return url


def _clean_event_types(actor: Actor, event_types: list[str], include_data: bool) -> list[str]:
    cleaned = sorted({str(e) for e in (event_types or [])})
    unknown = [e for e in cleaned if e not in events.WEBHOOK_EVENT_TYPES]
    if unknown or not cleaned:
        raise ValidationError({"event_types": "Choose one or more of the available events."})
    if include_data:
        # Payloads carry record fields: the creator must be able to see all such records themselves.
        for event_type in cleaned:
            entity = "activity" if event_type == "task.completed" else event_type.split(".", 1)[0]
            permission = fields.WEBHOOK_ENTITY_PERMISSIONS[entity]
            if actor.scope_for(permission) != "all":
                raise PermissionDenied(
                    detail="Only members who can see every record may send record data in webhooks.",
                    code="include_data_denied",
                )
    return cleaned


@transaction.atomic
def create_subscription(
    actor: Actor, *, name: str, url: str, event_types: list[str], include_data: bool, request: Any = None
) -> tuple[WebhookSubscription, str]:
    check(actor, "webhooks.manage")
    require_recent_auth(request)
    name = validators.clean_text(name, max_length=80)
    if not name:
        raise ValidationError({"name": "Name is required."})
    if WebhookSubscription.objects.count() >= MAX_SUBSCRIPTIONS_PER_ORG:
        raise DomainError("Webhook limit reached.", code="webhook_limit", status_code=429)
    destination = _clean_destination(url)
    cleaned_events = _clean_event_types(actor, event_types, include_data)
    secret = signing.generate_secret()
    subscription = WebhookSubscription.objects.create(
        name=name,
        url=destination,
        event_types=cleaned_events,
        include_data=bool(include_data),
        secret_enc=crypto.encrypt(secret),
        created_by=actor.membership,
    )
    audit.record(
        actions.WEBHOOK_CREATED,
        request=request,
        user=actor.user,
        resource=subscription,
        resource_type="webhook",
        metadata={
            "name": name,
            "host": net.validate_url(destination).host,
            "events": cleaned_events,
            "include_data": bool(include_data),
        },
    )
    events.invalidate_targets(actor.organization.pk)
    return subscription, secret


@transaction.atomic
def update_subscription(actor: Actor, subscription: WebhookSubscription, *, request: Any = None, **changes: Any):
    check(actor, "webhooks.manage")
    update_fields: list[str] = []
    if changes.get("name") is not None:
        subscription.name = validators.clean_text(changes["name"], max_length=80) or subscription.name
        update_fields.append("name")
    if changes.get("url") is not None and changes["url"] != subscription.url:
        require_recent_auth(request)
        subscription.url = _clean_destination(changes["url"])
        update_fields.append("url")
    include_data = changes.get("include_data")
    if changes.get("event_types") is not None or include_data is not None:
        if include_data is not None and include_data and not subscription.include_data:
            require_recent_auth(request)
        subscription.include_data = subscription.include_data if include_data is None else bool(include_data)
        subscription.event_types = _clean_event_types(
            actor, changes.get("event_types") or subscription.event_types, subscription.include_data
        )
        update_fields += ["event_types", "include_data"]
    if not update_fields:
        return subscription
    subscription.save(update_fields=[*sorted(set(update_fields)), "updated_at"])
    audit.record(
        actions.WEBHOOK_UPDATED,
        request=request,
        user=actor.user,
        resource=subscription,
        resource_type="webhook",
        metadata={"fields": sorted(set(update_fields))},
    )
    events.invalidate_targets(actor.organization.pk)
    return subscription


@transaction.atomic
def set_subscription_status(actor: Actor, subscription: WebhookSubscription, *, active: bool, request: Any = None):
    check(actor, "webhooks.manage")
    subscription.status = WebhookSubscription.Status.ACTIVE if active else WebhookSubscription.Status.PAUSED
    if active:
        subscription.consecutive_failures = 0
    subscription.save(update_fields=["status", "consecutive_failures", "updated_at"])
    audit.record(
        actions.WEBHOOK_UPDATED,
        request=request,
        user=actor.user,
        resource=subscription,
        resource_type="webhook",
        metadata={"status": subscription.status},
    )
    events.invalidate_targets(actor.organization.pk)
    return subscription


@transaction.atomic
def rotate_subscription_secret(actor: Actor, subscription: WebhookSubscription, *, request: Any = None) -> str:
    check(actor, "webhooks.manage")
    require_recent_auth(request)
    secret = signing.generate_secret()
    subscription.previous_secret_enc = subscription.secret_enc
    subscription.previous_secret_expires_at = timezone.now() + SECRET_ROTATION_OVERLAP
    subscription.secret_enc = crypto.encrypt(secret)
    subscription.save(update_fields=["secret_enc", "previous_secret_enc", "previous_secret_expires_at", "updated_at"])
    audit.record(
        actions.WEBHOOK_SECRET_ROTATED, request=request, user=actor.user, resource=subscription, resource_type="webhook"
    )
    return secret


@transaction.atomic
def delete_subscription(actor: Actor, subscription: WebhookSubscription, *, request: Any = None) -> None:
    check(actor, "webhooks.manage")
    require_recent_auth(request)
    subscription_id, name = subscription.pk, subscription.name
    subscription.delete()
    audit.record(
        actions.WEBHOOK_DELETED,
        request=request,
        user=actor.user,
        resource_type="webhook",
        resource_id=subscription_id,
        metadata={"name": name},
    )
    events.invalidate_targets(actor.organization.pk)


# ----------------------------------------------------------------------------- inbound receiver


class InboundRejected(Exception):  # noqa: N818
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def _rate_limited(connection_id) -> bool:
    window = int(timezone.now().timestamp() // 60)
    key = f"integrations:inbound:{connection_id}:{window}"
    added = cache.add(key, 1, 120)
    count = 1 if added else cache.incr(key)
    return count > settings.INTEGRATIONS_INBOUND_PER_MINUTE


def _inbound_secrets(connection: IntegrationConnection) -> list[str]:
    values = [crypto.decrypt(connection.inbound_secret_enc)] if connection.inbound_secret_enc else []
    if (
        connection.inbound_previous_secret_enc
        and connection.inbound_previous_secret_expires_at
        and connection.inbound_previous_secret_expires_at > timezone.now()
    ):
        values.append(crypto.decrypt(connection.inbound_previous_secret_enc))
    return values


def receive(key: str, *, body: bytes, headers: dict[str, str], request: Any = None) -> tuple[int, dict[str, str]]:
    """Authenticate, validate and store one inbound webhook call. Returns (HTTP status, response body)."""
    if len(body) > MAX_INBOUND_BODY_BYTES:
        raise InboundRejected(413, "payload_too_large")
    if not _KEY_RE.match(key or ""):
        raise InboundRejected(404, "not_found")
    key_hash = hashlib.sha256(key.encode("ascii")).hexdigest()
    # Cross-tenant on purpose: the URL key is the only thing identifying the connection. Only ids are read;
    # authentication and all processing happen afterwards inside that connection's tenant context.
    with system_context("integrations.inbound.locate_connection"):
        connections = IntegrationConnection.all_objects  # nosemgrep: keel-unscoped-manager-outside-system-code
        row = (
            connections.filter(inbound_key_hash=key_hash, inbound_enabled=True)
            .values_list("organization_id", "id")
            .first()
        )
    if row is None:
        raise InboundRejected(404, "not_found")
    organization_id, connection_id = row
    if _rate_limited(connection_id):
        raise InboundRejected(429, "rate_limited")

    with tenant_context(organization_id, reason="integrations.inbound"):
        connection = IntegrationConnection.objects.filter(pk=connection_id).first()
        if connection is None or connection.status in (ConnectionStatus.DISCONNECTED, ConnectionStatus.DISABLED):
            raise InboundRejected(404, "not_found")
        try:
            secrets_ = _inbound_secrets(connection)
        except crypto.DecryptionError as exc:
            raise InboundRejected(503, "decrypt_failed") from exc
        valid, reason = signing.verify(headers.get("keel-signature"), body, secrets_)
        if not valid:
            log.warning("integrations.inbound_rejected", connection_id=str(connection_id), reason=reason)
            audit.record(
                actions.WEBHOOK_REJECTED,
                request=request,
                organization_id=organization_id,
                actor_type="system",
                resource=connection,
                resource_type="integration",
                metadata={"reason": reason},
            )
            raise InboundRejected(401, "invalid_signature")
        event_id = headers.get("keel-event-id", "")
        if not _EVENT_ID_RE.match(event_id):
            raise InboundRejected(400, "missing_event_id")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise InboundRejected(400, "invalid_json") from exc
        if not isinstance(payload, dict):
            raise InboundRejected(400, "invalid_json")
        provider = get_provider(connection.provider)
        try:
            parsed = provider.handle_webhook(provider_context(connection), payload)
        except ProviderError as exc:
            raise InboundRejected(422, exc.code) from exc
        event_type = str(payload.get("type", ""))[:40]
        try:
            with transaction.atomic():
                event = InboundEvent.objects.create(
                    connection=connection,
                    event_id=event_id,
                    event_type=event_type,
                    payload=payload,
                    payload_sha256=hashlib.sha256(body).hexdigest(),
                )
        except IntegrityError:
            return 200, {"status": "duplicate"}
        if not parsed:
            return 202, {"status": "accepted"}
        event_pk = event.pk
        transaction.on_commit(lambda: _enqueue_inbound(event_pk, organization_id))
    return 202, {"status": "accepted"}


def _enqueue_inbound(event_id, organization_id) -> None:
    from apps.integrations import tasks

    tasks.process_inbound_event.delay(event_id=str(event_id), organization_id=str(organization_id))


def process_inbound(event: InboundEvent) -> str:
    """Apply a stored inbound event through the sync layer, then drop the payload."""
    from apps.integrations import sync

    connection = event.connection
    provider = get_provider(connection.provider)
    outcome = "processed"
    try:
        records = provider.handle_webhook(sync.provider_context(connection), event.payload)
        results = [sync.apply_inbound(connection, entity_type, record) for entity_type, record in records]
        bad = [r for r in results if r not in ("created", "updated", "unchanged", "kept_crm", "conflict")]
        event.status = InboundEvent.Status.FAILED if bad else InboundEvent.Status.PROCESSED
        event.error_code = bad[0][:64] if bad else ""
    except ProviderError as exc:
        event.status = InboundEvent.Status.FAILED
        event.error_code = exc.code[:64]
        if exc.action_required:
            sync.record_failure(connection, exc)
    outcome = event.status
    event.payload = {}
    event.processed_at = timezone.now()
    event.save(update_fields=["status", "error_code", "payload", "processed_at", "updated_at"])
    return outcome
