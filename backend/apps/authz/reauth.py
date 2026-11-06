"""Recent-authentication guard for sensitive actions (role changes, org settings, security settings)."""

from __future__ import annotations

import time

from allauth.account.authentication import get_authentication_records
from allauth.account.internal.flows.reauthentication import (
    did_recently_authenticate as allauth_did_recently_authenticate,
)
from django.conf import settings
from django.http import HttpRequest

from apps.core.exceptions import ReauthenticationRequired

#: The method name a Workeasy360 sign-in records in allauth's per-session authentication log.
WORKEASY360_METHOD = "workeasy360"


def did_recently_authenticate(request: HttpRequest) -> bool:
    """allauth's answer, except for sessions that Workeasy360 established.

    allauth treats an account with no usable password and no second factor as *always* recently
    authenticated, because it has nothing to re-prompt for. A Workeasy360 account is exactly that, yet
    it can be re-prompted: "Confirm with Workeasy360" asks Workeasy360 for a fresh sign-in
    (``prompt=login``) and appends a record. So for those sessions the newest authentication record (a
    Workeasy360 sign-in, or a Keel MFA re-authentication) must fall inside the re-authentication window
    - measured, for a Workeasy360 record, from when the person actually entered their password there
    (the ID token's ``auth_time``), not from when Keel happened to receive the token: a silent sign-in
    on a Workeasy360 session opened hours ago is not a recent authentication.
    """
    if request.user.is_anonymous:
        return False
    records = get_authentication_records(request)
    if any(record.get("method") == WORKEASY360_METHOD for record in records):
        newest = records[-1]
        if newest.get("method") == WORKEASY360_METHOD:
            moment = newest.get("auth_time")
            if not isinstance(moment, int | float) or isinstance(moment, bool):
                # No auth_time: Workeasy360 did not say when the password was entered, so nothing proves it
                # was recent - certainly not the moment Keel received the token.
                return False
            at = float(moment)
        else:
            at = float(newest["at"])
        return time.time() - at < settings.ACCOUNT_REAUTHENTICATION_TIMEOUT
    return allauth_did_recently_authenticate(request)


def require_recent_auth(request: HttpRequest) -> None:
    if not did_recently_authenticate(request):
        raise ReauthenticationRequired()
