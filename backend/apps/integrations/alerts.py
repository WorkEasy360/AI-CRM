"""Admin notifications for integration problems. ``notify()`` de-duplicates per recipient, kind and
entity for 24 hours, so a flapping connection produces one notification a day, not one per failure."""

from __future__ import annotations

import structlog
from django.db import transaction

from apps.integrations import errors

log = structlog.get_logger(__name__)


def _admin_membership_ids(permission: str) -> list:
    from apps.accounts.models import Membership
    from apps.authz.roles import SYSTEM_ROLES

    role_keys = [key for key, role in SYSTEM_ROLES.items() if permission in role.grants]
    return list(
        Membership.objects.active().filter(role__key__in=role_keys, role__is_system=True).values_list("pk", flat=True)
    )


def _notify(permission: str, *, title: str, body: str, entity_type: str, entity_id) -> None:
    from apps.notifications import service as notifications

    for membership_id in _admin_membership_ids(permission):
        try:
            with transaction.atomic():  # savepoint: a failed insert must not poison the caller's transaction
                notifications.notify(
                    membership_id,
                    kind="integration_alert",
                    title=title,
                    body=body,
                    entity_type=entity_type,
                    entity_id=entity_id,
                )
        except Exception:  # an alert must never break the job that raised it
            log.exception("integrations.alert_failed")


def connection_problem(connection, code: str) -> None:
    from apps.integrations.providers import get_provider

    try:
        provider_name = get_provider(connection.provider).name
    except Exception:
        provider_name = "The integration"
    _notify(
        "integrations.manage",
        title=f"{connection.name} needs attention",
        body=errors.message_for(code, provider_name),
        entity_type="integration",
        entity_id=connection.pk,
    )


def webhook_disabled(subscription, code: str) -> None:
    _notify(
        "webhooks.manage",
        title=f"Webhook {subscription.name} was turned off",
        body="Deliveries kept failing, so Keel stopped sending them. Check the endpoint and turn it back on.",
        entity_type="webhook",
        entity_id=subscription.pk,
    )
