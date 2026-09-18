"""Transactional email delivery on the ``notifications`` queue.

Why a task: SMTP/SES latency and outages must not sit inside signup, invitation, password-reset or
login requests, and a mail provider incident must not take the API down with it.

Safety: the message is rendered *before* enqueueing (only strings cross the broker, never model
instances or request objects). Retries are limited with exponential backoff and jitter. Each message
carries a random id; a successful send stores a short-lived marker so a redelivered task (worker lost
after sending, ``acks_late``) does not send the same message twice.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import structlog
from celery import shared_task
from django.core.cache import cache
from django.core.mail import EmailMultiAlternatives

log = structlog.get_logger(__name__)

SENT_MARKER_TTL = 24 * 3600


def queue_email(
    *,
    subject: str,
    body: str,
    to: Sequence[str],
    from_email: str | None = None,
    alternatives: Sequence[tuple[str, str]] | None = None,
) -> str:
    """Enqueue (or send inline when EMAIL_ASYNC is off). Returns the message id."""
    from django.conf import settings

    message_id = uuid.uuid4().hex
    payload = {
        "message_id": message_id,
        "subject": subject,
        "body": body,
        "to": list(to),
        "from_email": from_email,
        "alternatives": [list(a) for a in (alternatives or [])],
    }
    if settings.EMAIL_ASYNC:
        send_email.apply_async(kwargs=payload)
    else:
        send_email.apply(kwargs=payload)
    return message_id


@shared_task(
    name="accounts.send_email",
    bind=True,
    ignore_result=True,
    autoretry_for=(Exception,),
    max_retries=3,
    retry_backoff=5,
    retry_backoff_max=300,
    retry_jitter=True,
    soft_time_limit=30,
    time_limit=45,
)
def send_email(
    self,
    *,
    message_id: str,
    subject: str,
    body: str,
    to: list[str],
    from_email: str | None = None,
    alternatives: list[list[str]] | None = None,
) -> str:
    marker = f"email:sent:{message_id}"
    added = cache.add(marker, "1", SENT_MARKER_TTL)
    if added is False:
        log.info("email.duplicate_skipped", message_id=message_id)
        return "duplicate"
    if added is None:
        # CACHE_FAIL_OPEN: django-redis answers None, not False, when Redis is unreachable. Treating that
        # as "already sent" silently dropped password resets, invitations and verification emails for the
        # length of a Redis incident; a rare duplicate on redelivery is the lesser harm.
        log.warning("email.dedupe_unavailable", message_id=message_id)
    message = EmailMultiAlternatives(subject=subject, body=body, from_email=from_email, to=to)
    for content, mimetype in alternatives or []:
        message.attach_alternative(content, mimetype)
    try:
        message.send(fail_silently=False)
    except Exception:
        # Release the marker so the retry may send; the marker only guards against *redelivery* of a
        # task that already succeeded.
        cache.delete(marker)
        raise
    log.info("email.sent", message_id=message_id, recipients=len(to))
    return "sent"
