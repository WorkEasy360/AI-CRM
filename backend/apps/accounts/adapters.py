from __future__ import annotations

from typing import Any

import structlog
from allauth.account.adapter import DefaultAccountAdapter
from allauth.core.exceptions import ImmediateHttpResponse
from allauth.headless.adapter import DefaultHeadlessAdapter
from allauth.headless.base.response import ForbiddenResponse
from django.http import HttpRequest, HttpResponse

from apps.accounts.models import ExternalIdentity
from apps.accounts.tasks import queue_email
from apps.accounts.workeasy360 import config as workeasy360
from apps.authz.actor import FEDERATED_AAL_SESSION_KEY, FEDERATED_SUBJECT_SESSION_KEY

log = structlog.get_logger(__name__)


class AccountAdapter(DefaultAccountAdapter):
    """allauth hooks. With ``WORKEASY360_SSO_ONLY`` on, every allauth way in is closed here: Workeasy360
    (apps.accounts.workeasy360.views) is then the only sign-in, and it does not pass through allauth's
    login flow. Sessions, MFA management and logout stay with allauth."""

    error_messages = {
        **DefaultAccountAdapter.error_messages,
        "password_login_disabled": "Password sign-in is turned off. Continue with Workeasy360.",  # nosec B105
        "password_managed_by_workeasy360": (  # nosec B105 - a message key, not a secret
            "This account signs in with Workeasy360. Its password is managed in Workeasy360."
        ),
    }

    def clean_password(self, password: str, user=None) -> str:
        # Every way of setting a password (set, change, reset) validates the new one here. An account
        # linked to Workeasy360 gets none: a local password would be a second way in that skips Workeasy360's
        # MFA, access policy and membership checks - and for an account Workeasy360 created, allauth would
        # not even ask for a current password. Also with password sign-in on (hybrid mode).
        if user is not None and user.pk and ExternalIdentity.objects.filter(user_id=user.pk).exists():
            raise self.validation_error("password_managed_by_workeasy360")
        return super().clean_password(password, user=user)

    def is_open_for_signup(self, request: HttpRequest) -> bool:
        # D8: self-service sign-up with mandatory email verification, unless Workeasy360 owns accounts.
        return workeasy360.password_sign_in_enabled()

    def pre_authenticate(self, request: HttpRequest, **credentials: Any) -> None:
        # Password sign-in and password re-authentication both authenticate through here. Refusing
        # before the password is checked means the answer says nothing about the password.
        if workeasy360.sso_only():
            raise self.validation_error("password_login_disabled")
        super().pre_authenticate(request, **credentials)

    def pre_login(self, request: HttpRequest, user, **kwargs: Any) -> HttpResponse | None:
        # Every allauth sign-in (password, passkey, code) ends here; a backstop for the ones that do not
        # authenticate with a password.
        if workeasy360.sso_only():
            raise ImmediateHttpResponse(ForbiddenResponse(request))
        return super().pre_login(request, user, **kwargs)

    def login(self, request: HttpRequest, user) -> None:
        # A sign-in through allauth is not a Workeasy360 session, even in a browser that had one.
        request.session.pop(FEDERATED_AAL_SESSION_KEY, None)
        request.session.pop(FEDERATED_SUBJECT_SESSION_KEY, None)
        super().login(request, user)

    def send_password_reset_mail(self, user, email: str, context: dict) -> None:
        # The endpoint keeps answering as usual (no account enumeration), but no reset link is issued
        # while passwords cannot be used to sign in.
        if workeasy360.sso_only():
            log.info("accounts.password_reset_suppressed", reason="workeasy360_sso_only")
            return
        if ExternalIdentity.objects.filter(user_id=user.pk).exists():
            # A Workeasy360 account's password lives in Workeasy360 (clean_password); a link here could only fail.
            log.info("accounts.password_reset_suppressed", reason="workeasy360_account")
            return
        super().send_password_reset_mail(user, email, context)

    def send_mail(self, template_prefix: str, email: str, context: dict) -> None:
        """Render inside the request (templates need the request/user), deliver from the notifications queue."""
        if template_prefix == "account/email/unknown_account" and workeasy360.sso_only():
            # The other half of a password reset request (no account for the address): equally pointless,
            # and suppressing both keeps known and unknown addresses indistinguishable.
            return
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
