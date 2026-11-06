"""EntitlementService: the one place that answers "may this organization do that on its plan?".

Every gated action calls one of three functions, inside the tenant context of the organization:

- ``check_feature(org, "whatsapp")``            boolean gates (Express unlocks WhatsApp ...)
- ``check_capacity(org, "pipelines")``          live totals owned by another module (pipelines, fields)
- ``consume(org, "records")`` / ``release(...)`` atomic counters (records, AI credits, mass emails)

Each raises ``LimitReached`` / ``FeatureNotInPlan``: a 403 problem response whose ``upgrade`` member
tells the client which edition or add-on lifts the block, so the UI can show the upgrade path inline.

Layering: billing never reads another module's tables. Modules register how to count their own rows
with ``register_counter`` from their ``AppConfig.ready()``, the same pattern as ``domain_events``.

Concurrency:
- counters move with one conditional ``UPDATE ... WHERE used + n <= limit``: two concurrent creates at
  the boundary cannot both pass, and no lock is held beyond that row;
- live totals are checked while holding the organization's subscription row ``FOR UPDATE``, which
  serializes the (rare) creates of pipelines and fields per organization.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import F, Sum
from django.db.models.functions import Greatest
from django.utils import timezone

from apps.billing.editions import (
    ADDONS,
    EDITION_360,
    EDITIONS,
    FEATURES,
    FREE,
    METRICS,
    Edition,
    lowest_edition_above,
    lowest_edition_with_feature,
)
from apps.core.exceptions import DomainError

#: Metrics kept in ``UsageCounter`` rows. Everything else is counted live from its owning module.
COUNTER_METRICS = frozenset({"records", "ai_credits", "mass_emails"})
BILLING_URL = "/settings/billing"

# ----------------------------------------------------------------------------- errors


class EntitlementError(DomainError):
    status_code = 403

    def __init__(self, message: str, *, code: str, upgrade: dict[str, Any]):
        super().__init__(message, code=code, status_code=403)
        self.extra = {"upgrade": upgrade}


class LimitReached(EntitlementError):  # noqa: N818 - reads better at call sites
    pass


class FeatureNotInPlan(EntitlementError):  # noqa: N818
    pass


# ----------------------------------------------------------------------------- counter registry

Counter = Callable[[str | None], int]
_counters: dict[str, list[Counter]] = {}


def register_counter(metric: str, fn: Counter) -> None:
    """Register how a module counts its share of ``metric``. ``fn(module)`` runs in the tenant context.

    Several modules may contribute to one metric (contacts, companies, deals and products all count as
    records); their answers are summed.
    """
    if metric not in METRICS:
        raise ValueError(f"Unknown metric: {metric!r}")
    bucket = _counters.setdefault(metric, [])
    if fn not in bucket:
        bucket.append(fn)


def live_usage(metric: str, module: str | None = None) -> int:
    return sum(int(fn(module)) for fn in _counters.get(metric, ()))


# ----------------------------------------------------------------------------- resolution


@dataclass(frozen=True)
class Entitlements:
    edition: Edition  # the edition in force now (a lapsed trial resolves to Free)
    subscription: Any | None
    limits: dict[str, int | None]  # edition limits plus active add-ons
    addon_amounts: dict[str, int]
    features: frozenset[str]
    seat_limit: int | None

    def limit(self, metric: str) -> int | None:
        return self.limits[metric]

    def has(self, feature: str) -> bool:
        return feature in self.features


def period_key(metric: str, now: datetime | None = None) -> str:
    period = METRICS[metric].period
    today = timezone.localdate(now or timezone.now())
    if period == "monthly":
        return today.strftime("%Y-%m")
    if period == "daily":
        return today.strftime("%Y-%m-%d")
    return ""


def effective_edition_key(subscription, now: datetime | None = None) -> str:
    if subscription is None:
        # An organization created outside ``create_organization`` (fixtures, legacy rows the backfill
        # missed). Configurable so a deployment can choose to fail towards the free tier instead.
        return getattr(settings, "BILLING_DEFAULT_EDITION", EDITION_360)
    now = now or timezone.now()
    status = subscription.status
    if status == "trialing" and subscription.trial_ends_at and subscription.trial_ends_at <= now:
        return FREE
    if status == "cancelled" and (subscription.current_period_end is None or subscription.current_period_end <= now):
        return FREE
    return subscription.edition


def resolve(organization, *, now: datetime | None = None) -> Entitlements:
    from apps.billing.models import AddonPurchase, Subscription

    _assert_bound(organization)
    subscription = Subscription.objects.filter(organization_id=organization.pk).first()
    edition = EDITIONS[effective_edition_key(subscription, now)]
    limits: dict[str, int | None] = dict(edition.limits)
    features = set(edition.features)
    addon_amounts: dict[str, int] = {}
    if edition.key != FREE:
        current_month = period_key("ai_credits", now)
        for row in AddonPurchase.objects.filter(status=AddonPurchase.Status.ACTIVE):
            addon = ADDONS.get(row.addon)
            if addon is None or (not addon.recurring and row.period_key != current_month):
                continue
            if addon.feature:
                features.add(addon.feature)
            if addon.metric:
                addon_amounts[addon.metric] = addon_amounts.get(addon.metric, 0) + addon.unit_amount * row.quantity
        for metric, amount in addon_amounts.items():
            base = limits[metric]
            if base is not None:
                limits[metric] = base + amount
    seat_limit = limits["users"]
    if (
        subscription is not None
        and not subscription.grandfathered
        and edition.key != FREE
        and subscription.edition == edition.key
        and subscription.status in {"active", "past_due"}
        and subscription.seats > 0
    ):
        seat_limit = subscription.seats
    if subscription is not None and subscription.grandfathered:
        seat_limit = None
    return Entitlements(
        edition=edition,
        subscription=subscription,
        limits=limits,
        addon_amounts=addon_amounts,
        features=frozenset(features),
        seat_limit=seat_limit,
    )


def _assert_bound(organization) -> None:
    from apps.core.tenancy.context import get_context

    ctx = get_context()
    if ctx is None or (not ctx.is_system and ctx.organization_id != organization.pk):
        raise DomainError("Entitlements resolved outside the organization's context.", code="tenant_mismatch")


# ----------------------------------------------------------------------------- upgrade payloads


def _limit_upgrade(ent: Entitlements, metric: str, *, used: int, amount: int) -> dict[str, Any]:
    target = lowest_edition_above(metric, used + amount)
    if target is not None and target.rank <= ent.edition.rank:
        target = None
    addon = next((a.key for a in ADDONS.values() if a.metric == metric), None)
    return {
        "kind": "limit",
        "metric": metric,
        "label": METRICS[metric].label,
        "limit": ent.limit(metric),
        "used": used,
        "current_edition": {"key": ent.edition.key, "name": ent.edition.name},
        "required_edition": {"key": target.key, "name": target.name} if target else None,
        "addon": addon if ent.edition.key != FREE else None,
        "url": BILLING_URL,
    }


def _feature_upgrade(ent: Entitlements, feature: str) -> dict[str, Any]:
    target = lowest_edition_with_feature(feature)
    addon = next((a.key for a in ADDONS.values() if a.feature == feature), None)
    return {
        "kind": "feature",
        "feature": feature,
        "label": FEATURES[feature],
        "current_edition": {"key": ent.edition.key, "name": ent.edition.name},
        "required_edition": {"key": target.key, "name": target.name} if target else None,
        "addon": addon,
        "url": BILLING_URL,
    }


# ----------------------------------------------------------------------------- checks


def has_feature(organization, feature: str) -> bool:
    if feature not in FEATURES:
        raise ValueError(f"Unknown feature: {feature!r}")
    return resolve(organization).has(feature)


def check_feature(organization, feature: str) -> None:
    if feature not in FEATURES:
        raise ValueError(f"Unknown feature: {feature!r}")
    ent = resolve(organization)
    if ent.has(feature):
        return
    upgrade = _feature_upgrade(ent, feature)
    where = f" Upgrade to {upgrade['required_edition']['name']} to use it." if upgrade["required_edition"] else ""
    raise FeatureNotInPlan(
        f"{FEATURES[feature]} is not included in your {ent.edition.name} plan.{where}",
        code="feature_not_in_plan",
        upgrade=upgrade,
    )


def check_capacity(organization, metric: str, *, amount: int = 1, module: str | None = None) -> None:
    """Raise when adding ``amount`` more of a live-counted ``metric`` would exceed the plan."""
    if metric not in METRICS or metric in COUNTER_METRICS:
        raise ValueError(f"{metric!r} is not a live-counted metric.")
    with transaction.atomic():
        _lock_subscription(organization)
        ent = resolve(organization)
        limit = ent.limit(metric)
        if limit is None:
            return
        used = live_usage(metric, module)
        if used + amount > limit:
            raise _limit_error(ent, metric, used=used, amount=amount)


def _lock_subscription(organization) -> None:
    from apps.billing.models import Subscription

    list(Subscription.objects.select_for_update().filter(organization_id=organization.pk).values_list("pk"))


def _limit_error(ent: Entitlements, metric: str, *, used: int, amount: int) -> LimitReached:
    label = METRICS[metric].label
    upgrade = _limit_upgrade(ent, metric, used=used, amount=amount)
    hint = (
        f" Upgrade to {upgrade['required_edition']['name']} or buy an add-on."
        if upgrade["required_edition"]
        else " Buy an add-on to raise it."
    )
    return LimitReached(
        f"Your {ent.edition.name} plan allows {ent.limit(metric):,} {label.lower()}.{hint}",
        code="plan_limit_reached",
        upgrade=upgrade,
    )


def _counter(metric: str, key: str):
    from apps.billing.models import UsageCounter

    row = UsageCounter.objects.filter(metric=metric, period_key=key).first()
    if row is not None:
        return row
    initial = live_usage(metric) if key == "" else 0
    try:
        with transaction.atomic():
            return UsageCounter.objects.create(
                metric=metric, period_key=key, used=initial, reconciled_at=timezone.now()
            )
    except IntegrityError:
        return UsageCounter.objects.get(metric=metric, period_key=key)


def consume(organization, metric: str, amount: int = 1) -> int:
    """Atomically take ``amount`` of a counter-backed metric. Returns the new usage."""
    from apps.billing.models import UsageCounter

    if metric not in COUNTER_METRICS:
        raise ValueError(f"{metric!r} is not a counter-backed metric.")
    if amount <= 0:
        return usage(organization, metric)
    ent = resolve(organization)
    row = _counter(metric, period_key(metric))
    limit = ent.limit(metric)
    qs = UsageCounter.objects.filter(pk=row.pk)
    if limit is not None:
        qs = qs.filter(used__lte=limit - amount)
    if qs.update(used=F("used") + amount) == 0:
        row.refresh_from_db(fields=["used"])
        raise _limit_error(ent, metric, used=row.used, amount=amount)
    row.refresh_from_db(fields=["used"])
    return row.used


def release(organization, metric: str, amount: int = 1) -> None:
    """Give back ``amount`` (a record archived, a send that never left). Never drops below zero."""
    from apps.billing.models import UsageCounter

    if metric not in COUNTER_METRICS:
        raise ValueError(f"{metric!r} is not a counter-backed metric.")
    if amount <= 0:
        return
    _assert_bound(organization)
    UsageCounter.objects.filter(metric=metric, period_key=period_key(metric)).update(
        used=Greatest(F("used") - amount, 0)
    )


def usage(organization, metric: str, module: str | None = None) -> int:
    _assert_bound(organization)
    if metric in COUNTER_METRICS:
        from apps.billing.models import UsageCounter

        value = (
            UsageCounter.objects.filter(metric=metric, period_key=period_key(metric))
            .aggregate(total=Sum("used"))
            .get("total")
        )
        if value is None and METRICS[metric].period == "count":
            return live_usage(metric)
        return int(value or 0)
    return live_usage(metric, module)


def reconcile(organization) -> dict[str, int]:
    """Re-derive running totals from the owning modules. Returns the corrections made."""
    from apps.billing.models import UsageCounter

    _assert_bound(organization)
    corrections: dict[str, int] = {}
    for metric in COUNTER_METRICS:
        if METRICS[metric].period != "count" or metric not in _counters:
            continue
        actual = live_usage(metric)
        row = _counter(metric, "")
        if row.used != actual:
            corrections[metric] = actual - row.used
        UsageCounter.objects.filter(pk=row.pk).update(used=actual, reconciled_at=timezone.now())
    return corrections


# ----------------------------------------------------------------------------- reporting

CRM_MODULES = ("contact", "company", "deal", "product")
# What the record limit counts (DECISIONS M1.4 / M2.1). Shown on Settings > Plan & usage.
RECORD_DEFINITION = (
    "Records are the contacts, companies, deals and products in your workspace that are not in the recycle "
    "bin. Activities (tasks, events, calls), notes, files, tags, price books and saved views do not count. "
    "Deleting a record frees its slot; restoring it from the recycle bin takes the slot again; rolling back "
    "an import gives back the slots of the records it removes."
)


def usage_report(organization) -> dict[str, Any]:
    """Every metered counter against its limit, with the upgrade path for each."""
    ent = resolve(organization)
    metrics: list[dict[str, Any]] = []
    for key, metric in METRICS.items():
        limit = ent.seat_limit if key == "users" else ent.limit(key)
        modules: list[dict[str, Any]] | None
        if metric.per_module:
            per_module = {m: usage(organization, key, m) for m in CRM_MODULES}
            modules = [{"module": m, "used": n} for m, n in per_module.items()]
            used = max(per_module.values(), default=0)
        elif key == "records":
            # One limit across modules: show what makes up the total, from the same counters that enforce it.
            modules = [{"module": m, "used": live_usage("records", m)} for m in CRM_MODULES]
            used = usage(organization, key)
        else:
            modules = None
            used = usage(organization, key)
        target = None if limit is None else lowest_edition_above(key, max(used, limit) + 1)
        if target is not None and target.rank <= ent.edition.rank:
            target = None
        metrics.append(
            {
                "key": key,
                "label": metric.label,
                "period": metric.period,
                "unit": metric.unit,
                "used": used,
                "limit": limit,
                "addon_amount": ent.addon_amounts.get(key, 0),
                "modules": modules,
                "state": _state(used, limit),
                "upgrade_edition": {"key": target.key, "name": target.name} if target else None,
                "addon": next((a.key for a in ADDONS.values() if a.metric == key), None),
            }
        )
    return {
        "edition": {"key": ent.edition.key, "name": ent.edition.name},
        "features": sorted(ent.features),
        "metrics": metrics,
        "record_definition": RECORD_DEFINITION,
    }


def _state(used: int, limit: int | None) -> str:
    if limit is None:
        return "unlimited"
    if limit == 0:
        return "not_included"
    if used >= limit:
        return "at_limit"
    if used >= limit * 0.8:
        return "warning"
    return "ok"
