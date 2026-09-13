from __future__ import annotations

from allauth.account.adapter import DefaultAccountAdapter
from allauth.headless.adapter import DefaultHeadlessAdapter
from django.http import HttpRequest


class AccountAdapter(DefaultAccountAdapter):
    def is_open_for_signup(self, request: HttpRequest) -> bool:
        return True  # D8: self-service sign-up with mandatory email verification


class HeadlessAdapter(DefaultHeadlessAdapter):
    def serialize_user(self, user) -> dict:
        return {
            "id": str(user.pk),
            "email": user.email,
            "display_name": user.display_name,
            "has_usable_password": user.has_usable_password(),
        }
