"""Audit and security hooks for authentication events raised by Django and allauth."""

from __future__ import annotations

import hashlib

import structlog
from allauth.account import signals as account_signals
from allauth.mfa import signals as mfa_signals
from allauth.usersessions.models import UserSession
from django.contrib.auth.signals import user_login_failed
from django.dispatch import receiver
from django.utils import timezone

from apps.accounts import emails
from apps.accounts.session import pick_default_membership, set_active_membership
from apps.audit import actions
from apps.audit import service as audit
from apps.core.tenancy.context import set_db_user

log = structlog.get_logger(__name__)


def _ua_hash(request) -> str:
    ua = request.META.get("HTTP_USER_AGENT", "") if request is not None else ""
    return hashlib.sha256(ua.encode("utf-8", "ignore")).hexdigest() if ua else ""


@receiver(account_signals.user_logged_in)
def on_user_logged_in(sender, request, user, **kwargs):
    set_db_user(user.pk)
    membership = pick_default_membership(user)
    set_active_membership(request, membership)
    org_id = membership.organization_id if membership else None
    audit.record(actions.AUTH_LOGIN, request=request, user=user, organization_id=org_id)
    _check_new_device(request, user)


def _check_new_device(request, user) -> None:
    """Notify on a sign-in from an IP/user-agent pair not seen before (skipped on first ever login)."""
    if request is None:
        return
    ip = request.META.get("REMOTE_ADDR")
    ua = request.META.get("HTTP_USER_AGENT", "")[:512]
    current_key = request.session.session_key
    prior = UserSession.objects.filter(user=user).exclude(session_key=current_key or "")
    if not prior.exists():
        return
    if ip and prior.filter(ip=ip, user_agent=ua).exists():
        return
    audit.record(
        actions.AUTH_SUSPICIOUS_LOGIN,
        request=request,
        user=user,
        organization_id=None,
        metadata={"reason": "new_device_or_ip"},
    )
    try:
        emails.send_new_device_notice(to_email=user.email, ip=ip, when=timezone.now().isoformat(timespec="seconds"))
    except Exception:
        log.exception("accounts.new_device_notice_failed")


@receiver(user_login_failed)
def on_login_failed(sender, credentials, request=None, **kwargs):
    email = (credentials or {}).get("email") or (credentials or {}).get("username") or ""
    audit.record(
        actions.AUTH_LOGIN_FAILED,
        request=request,
        organization_id=None,
        actor_type="system",
        metadata={"email": str(email)[:254]},
    )


@receiver(account_signals.user_logged_out)
def on_user_logged_out(sender, request, user, **kwargs):
    audit.record(actions.AUTH_LOGOUT, request=request, user=user)


@receiver(account_signals.password_changed)
def on_password_changed(sender, request, user, **kwargs):
    _after_password_change(request, user, actions.AUTH_PASSWORD_CHANGED)


@receiver(account_signals.password_reset)
def on_password_reset(sender, request, user, **kwargs):
    _after_password_change(request, user, actions.AUTH_PASSWORD_RESET)


def _after_password_change(request, user, action: str) -> None:
    from apps.accounts.models import User
    from apps.accounts.services import revoke_user_sessions

    user = User.objects.get(pk=user.pk)  # unwrap lazy request.user and get fresh state
    User.objects.filter(pk=user.pk).update(password_changed_at=timezone.now())
    revoked = revoke_user_sessions(user)
    audit.record(action, request=request, user=user, organization_id=None, metadata={"sessions_revoked": revoked})


@receiver(account_signals.email_confirmed)
def on_email_confirmed(sender, request, email_address, **kwargs):
    audit.record(actions.AUTH_EMAIL_VERIFIED, request=request, user=email_address.user, organization_id=None)


@receiver(mfa_signals.authenticator_added)
def on_authenticator_added(sender, request, user, authenticator, **kwargs):
    audit.record(
        actions.AUTH_MFA_ENABLED,
        request=request,
        user=user,
        organization_id=None,
        metadata={"type": str(authenticator.type)},
    )


@receiver(mfa_signals.authenticator_removed)
def on_authenticator_removed(sender, request, user, authenticator, **kwargs):
    audit.record(
        actions.AUTH_MFA_DISABLED,
        request=request,
        user=user,
        organization_id=None,
        metadata={"type": str(authenticator.type)},
    )
