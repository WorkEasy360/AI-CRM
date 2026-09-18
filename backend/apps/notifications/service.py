"""``notify()`` is the only way a notification is created. It respects preferences and de-duplicates."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone

from apps.accounts.models import Membership
from apps.notifications.models import NOTIFICATION_KINDS, Notification, NotificationPreference

DEDUPE_WINDOW = timedelta(hours=24)
EMAIL_DEFAULT_ON = frozenset({"deal_assigned", "customer_replied"})


def preferences_for(membership_id: uuid.UUID) -> NotificationPreference | None:
    return NotificationPreference.objects.filter(membership_id=membership_id).first()


def wants(pref: NotificationPreference | None, channel: str, kind: str) -> bool:
    if pref is None:
        return True if channel == "in_app" else kind in EMAIL_DEFAULT_ON
    table = pref.in_app if channel == "in_app" else pref.email
    default = True if channel == "in_app" else kind in EMAIL_DEFAULT_ON
    value = table.get(kind, default)
    return bool(value)


def notify(
    membership_id: uuid.UUID,
    *,
    kind: str,
    title: str,
    body: str = "",
    entity_type: str = "",
    entity_id: Any = None,
) -> Notification | None:
    """Create a notification for one member inside the current tenant context.

    Returns None when the member opted out or an identical unread notification already exists within
    the de-duplication window (so a reminder that fires twice never shows twice).
    """
    if kind not in NOTIFICATION_KINDS:
        raise ValueError(f"Unknown notification kind: {kind!r}")
    pref = preferences_for(membership_id)
    if not wants(pref, "in_app", kind) and not wants(pref, "email", kind):
        return None
    since = timezone.now() - DEDUPE_WINDOW
    if entity_id is not None:
        duplicate = Notification.objects.filter(
            recipient_id=membership_id, kind=kind, entity_id=entity_id, created_at__gte=since, read_at__isnull=True
        ).exists()
        if duplicate:
            return None
    notification = None
    if wants(pref, "in_app", kind):
        notification = Notification.objects.create(
            recipient_id=membership_id,
            kind=kind,
            title=title[:200],
            body=body[:500],
            entity_type=entity_type[:16],
            entity_id=entity_id,
        )
    if wants(pref, "email", kind):
        _send_email(membership_id, title=title, body=body, entity_type=entity_type, entity_id=entity_id)
    return notification


def _send_email(membership_id: uuid.UUID, *, title: str, body: str, entity_type: str, entity_id: Any) -> None:
    from apps.accounts.tasks import queue_email

    membership = Membership.objects.select_related("user").filter(pk=membership_id).first()
    if membership is None or not membership.user.is_active:
        return
    link = ""
    if entity_type and entity_id:
        path = {
            "deal": "/deals/",
            "contact": "/contacts/",
            "company": "/companies/",
            "activity": "/activities?open=",
            "integration": "/settings/integrations/",
        }.get(entity_type, "")
        if path:
            link = f"\n\nOpen in {settings.SITE_NAME}: {settings.FRONTEND_ORIGIN}{path}{entity_id}"
    queue_email(
        subject=f"{settings.ACCOUNT_EMAIL_SUBJECT_PREFIX}{title}"[:200],
        body=f"{body}{link}\n\nYou can change notification emails in Settings > Notifications.\n",
        to=[membership.user.email],
        from_email=settings.DEFAULT_FROM_EMAIL,
    )


def unread_count(membership_id: uuid.UUID) -> int:
    return Notification.objects.filter(recipient_id=membership_id, read_at__isnull=True).count()


def mark_read(membership_id: uuid.UUID, ids: list[uuid.UUID] | None = None) -> int:
    qs = Notification.objects.filter(recipient_id=membership_id, read_at__isnull=True)
    if ids is not None:
        qs = qs.filter(pk__in=ids)
    return qs.update(read_at=timezone.now(), updated_at=timezone.now())
