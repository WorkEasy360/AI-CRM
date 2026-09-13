"""Recent-authentication guard for sensitive actions (role changes, org settings, security settings)."""

from __future__ import annotations

from allauth.account.internal.flows.reauthentication import did_recently_authenticate
from django.http import HttpRequest

from apps.core.exceptions import ReauthenticationRequired


def require_recent_auth(request: HttpRequest) -> None:
    if not did_recently_authenticate(request):
        raise ReauthenticationRequired()
