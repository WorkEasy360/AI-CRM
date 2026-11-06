"""Subscription and add-on changes. Every change is audited with its before/after state.

There is no payment provider yet: ``BILLING_SELF_SERVICE`` decides whether an owner may change the plan
directly. Deployments that charge real money keep it off until the PaymentProvider adapter takes over
checkout, so nobody can upgrade themselves for free.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.billing import entitlements
from apps.billing.editions import EDITIONS, FREE, TRIAL_DAYS, TRIAL_EDITION, get_addon, get_edition
from apps.billing.models import AddonPurchase, Subscription
from apps.core.exceptions import ConflictError, DomainError

MAX_SEATS = 10_000
MAX_ADDON_QUANTITY = 1_000


def start_subscription() -> Subscription:
    """The subscription a brand-new organization starts with (called from the bootstrap event)."""
    if Subscription.objects.exists():
        return Subscription.objects.get()
    if not getattr(settings, "BILLING_ENABLED", True):
        # Billing switched off for this deployment: every tenant keeps the full product, as before editions.
        return Subscription.objects.create(edition="edition_360", status=Subscription.Status.ACTIVE, grandfathered=True)
    return Subscription.objects.create(
        edition=TRIAL_EDITION,
        status=Subscription.Status.TRIALING,
        trial_ends_at=timezone.now() + timedelta(days=TRIAL_DAYS),
    )


def _snapshot(sub: Subscription) -> dict[str, Any]:
    return {
        "edition": sub.edition,
        "status": sub.status,
        "billing_cycle": sub.billing_cycle,
        "seats": sub.seats,
        "grandfathered": sub.grandfathered,
    }


def _assert_self_service() -> None:
    if not getattr(settings, "BILLING_SELF_SERVICE", False):
        raise DomainError(
            "Plan changes are handled by our billing team for this workspace. Contact support to change plan.",
            code="billing_self_service_disabled",
            status_code=409,
        )


def _locked_subscription() -> Subscription:
    sub = Subscription.objects.select_for_update().first()
    if sub is None:
        sub = start_subscription()
    return sub


@transaction.atomic
def change_plan(
    actor: Actor,
    *,
    edition: str,
    billing_cycle: str | None = None,
    seats: int | None = None,
    request: Any = None,
) -> Subscription:
    check(actor, "org.billing")
    _assert_self_service()
    try:
        target = get_edition(edition)
    except ValueError as exc:
        raise DomainError("Unknown edition.", code="invalid_edition") from exc
    sub = _locked_subscription()
    before = _snapshot(sub)
    users = entitlements.live_usage("users")
    if billing_cycle is not None and billing_cycle not in Subscription.Cycle.values:
        raise DomainError("billing_cycle must be monthly or annual.", code="invalid_billing_cycle")
    if target.key == FREE:
        if users > 1:
            raise ConflictError(
                "The Free plan is for one user. Remove other users and pending invitations first.",
                code="downgrade_blocked",
            )
        seats = 0
    else:
        seats = users if seats is None else seats
        if not isinstance(seats, int) or seats < 1 or seats > MAX_SEATS:
            raise DomainError("seats must be between 1 and 10,000.", code="invalid_seats")
        if seats < users:
            raise ConflictError(
                f"You have {users} users. Buy at least that many licences or remove users first.",
                code="seats_below_users",
            )
    now = timezone.now()
    cycle = billing_cycle or sub.billing_cycle
    sub.edition = target.key
    sub.billing_cycle = cycle
    sub.seats = seats
    sub.status = Subscription.Status.ACTIVE
    sub.trial_ends_at = None
    sub.grandfathered = False
    sub.cancel_at_period_end = False
    if before["edition"] != target.key or before["billing_cycle"] != cycle or sub.current_period_start is None:
        sub.current_period_start = now
        sub.current_period_end = now + (
            timedelta(days=365) if cycle == Subscription.Cycle.ANNUAL else timedelta(days=30)
        )
    sub.save()
    audit.record(
        "billing.plan_changed",
        request=request,
        user=actor.user,
        resource=sub,
        metadata={"before": before, "after": _snapshot(sub)},
    )
    return sub


@transaction.atomic
def purchase_addon(actor: Actor, *, addon: str, quantity: int = 1, request: Any = None) -> AddonPurchase:
    check(actor, "org.billing")
    _assert_self_service()
    try:
        definition = get_addon(addon)
    except ValueError as exc:
        raise DomainError("Unknown add-on.", code="invalid_addon") from exc
    if not isinstance(quantity, int) or quantity < 1 or quantity > MAX_ADDON_QUANTITY:
        raise DomainError("quantity must be between 1 and 1,000.", code="invalid_quantity")
    _locked_subscription()
    ent = entitlements.resolve(actor.organization)
    if ent.edition.key == FREE:
        raise DomainError("Add-ons are available on paid plans.", code="addon_requires_paid_plan", status_code=403)
    purchase = AddonPurchase.objects.create(
        addon=definition.key,
        quantity=quantity,
        period_key="" if definition.recurring else entitlements.period_key("ai_credits"),
        purchased_by=actor.membership,
    )
    audit.record(
        "billing.addon_purchased",
        request=request,
        user=actor.user,
        resource=purchase,
        metadata={"addon": definition.key, "quantity": quantity},
    )
    return purchase


@transaction.atomic
def cancel_addon(actor: Actor, purchase: AddonPurchase, *, request: Any = None) -> AddonPurchase:
    check(actor, "org.billing")
    _assert_self_service()
    if purchase.status != AddonPurchase.Status.ACTIVE:
        raise ConflictError("This add-on is already cancelled.", code="addon_not_active")
    purchase.status = AddonPurchase.Status.CANCELLED
    purchase.cancelled_at = timezone.now()
    purchase.save(update_fields=["status", "cancelled_at", "updated_at"])
    audit.record(
        "billing.addon_cancelled",
        request=request,
        user=actor.user,
        resource=purchase,
        metadata={"addon": purchase.addon, "quantity": purchase.quantity},
    )
    return purchase


def edition_catalogue() -> list[dict[str, Any]]:
    return [
        {
            "key": e.key,
            "name": e.name,
            "rank": e.rank,
            "tagline": e.tagline,
            "price_monthly_cents": e.price_monthly_cents,
            "price_annual_cents": e.price_annual_cents,
            "limits": dict(e.limits),
            "features": sorted(e.features),
        }
        for e in sorted(EDITIONS.values(), key=lambda e: e.rank)
    ]
