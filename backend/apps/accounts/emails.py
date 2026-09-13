"""Plain-text transactional emails. Templates contain no user-controlled HTML."""

from __future__ import annotations

from django.conf import settings
from django.core.mail import send_mail


def send_invitation_email(
    *, to_email: str, organization_name: str, inviter_name: str, accept_url: str, expires_days: int
) -> None:
    subject = f"{settings.ACCOUNT_EMAIL_SUBJECT_PREFIX}You're invited to join {organization_name}"
    body = (
        f"{inviter_name} has invited you to join {organization_name} on {settings.SITE_NAME}.\n\n"
        f"Accept the invitation:\n{accept_url}\n\n"
        f"This link expires in {expires_days} days. If you weren't expecting this, you can ignore this email.\n"
    )
    send_mail(subject, body, settings.DEFAULT_FROM_EMAIL, [to_email])


def send_new_device_notice(*, to_email: str, ip: str | None, when: str) -> None:
    subject = f"{settings.ACCOUNT_EMAIL_SUBJECT_PREFIX}New sign-in to your account"
    body = (
        f"A new sign-in to your {settings.SITE_NAME} account was detected.\n\n"
        f"Time: {when}\nIP address: {ip or 'unknown'}\n\n"
        "If this was you, no action is needed. If not, change your password and review your active sessions.\n"
    )
    send_mail(subject, body, settings.DEFAULT_FROM_EMAIL, [to_email])
