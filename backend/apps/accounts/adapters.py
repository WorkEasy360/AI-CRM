from __future__ import annotations

from allauth.account.adapter import DefaultAccountAdapter
from allauth.headless.adapter import DefaultHeadlessAdapter
from django.http import HttpRequest

from apps.accounts.tasks import queue_email


class AccountAdapter(DefaultAccountAdapter):
    def is_open_for_signup(self, request: HttpRequest) -> bool:
        return True  # D8: self-service sign-up with mandatory email verification

    def send_mail(self, template_prefix: str, email: str, context: dict) -> None:
        """Render inside the request (templates need the request/user), deliver from the notifications queue."""
        message = self.render_mail(template_prefix, email, context)
        queue_email(
            subject=message.subject,
            body=message.body,
            to=message.to,
            from_email=message.from_email,
            alternatives=[(content, mimetype) for content, mimetype in getattr(message, "alternatives", [])],
        )


class HeadlessAdapter(DefaultHeadlessAdapter):
    def serialize_user(self, user) -> dict:
        return {
            "id": str(user.pk),
            "email": user.email,
            "display_name": user.display_name,
            "has_usable_password": user.has_usable_password(),
        }
