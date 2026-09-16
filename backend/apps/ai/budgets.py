"""AI budgets and metering: per-user request rate, per-organization daily token quota, a usage ledger.

Counters live in Redis (cheap, fail-open under CACHE_FAIL_OPEN); the ledger row per (org, member,
day, feature) is the durable record admins see. Estimated cost uses the configured per-model rates.
"""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.ai.models import AIUsage
from apps.authz.actor import Actor
from apps.core.exceptions import DomainError

HOUR = 3600
DAY = 24 * 3600


def _user_key(actor: Actor) -> str:
    hour = timezone.now().strftime("%Y%m%d%H")
    return f"ai:req:{actor.organization.pk}:{actor.membership.pk}:{hour}"


def _org_key(actor: Actor) -> str:
    day = timezone.now().strftime("%Y%m%d")
    return f"ai:tok:{actor.organization.pk}:{day}"


def _incr(key: str, amount: int, ttl: int) -> int:
    try:
        try:
            return int(cache.incr(key, amount))
        except ValueError:
            cache.add(key, 0, ttl)
            return int(cache.incr(key, amount))
    except Exception:
        return 0


def check_quota(actor: Actor) -> None:
    """Raise a friendly 429 when the member or organization is over budget."""
    requests_this_hour = _incr(_user_key(actor), 1, HOUR)
    if requests_this_hour > settings.AI_USER_REQUESTS_PER_HOUR:
        raise DomainError(
            "You have reached the AI request limit for this hour. Try again a little later.",
            code="ai_quota_user",
            status_code=429,
        )
    try:
        tokens_today = int(cache.get(_org_key(actor)) or 0)
    except Exception:
        tokens_today = 0
    if tokens_today >= settings.AI_ORG_TOKENS_PER_DAY:
        raise DomainError(
            "Your workspace has used its AI budget for today. An administrator can review usage in Settings.",
            code="ai_quota_org",
            status_code=429,
        )


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    rates = settings.AI_MODEL_RATES_USD_PER_MTOK.get(model) or settings.AI_MODEL_RATES_USD_PER_MTOK.get(
        "default", (0, 0)
    )
    cost = (Decimal(input_tokens) * Decimal(str(rates[0])) + Decimal(output_tokens) * Decimal(str(rates[1]))) / Decimal(
        1_000_000
    )
    return cost.quantize(Decimal("0.000001"))


@transaction.atomic
def record_usage(
    actor: Actor,
    *,
    feature: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    flagged: bool = False,
) -> None:
    total = input_tokens + output_tokens
    _incr(_org_key(actor), total, DAY)
    cost = estimate_cost(model, input_tokens, output_tokens)
    row, created = AIUsage.objects.get_or_create(
        membership=actor.membership,
        day=timezone.now().date(),
        feature=feature[:32],
        model=model[:64],
        defaults={
            "requests": 1,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read_tokens,
            "estimated_cost_usd": cost,
            "flagged_inputs": 1 if flagged else 0,
        },
    )
    if not created:
        AIUsage.objects.filter(pk=row.pk).update(
            requests=F("requests") + 1,
            input_tokens=F("input_tokens") + input_tokens,
            output_tokens=F("output_tokens") + output_tokens,
            cache_read_tokens=F("cache_read_tokens") + cache_read_tokens,
            estimated_cost_usd=F("estimated_cost_usd") + cost,
            flagged_inputs=F("flagged_inputs") + (1 if flagged else 0),
            updated_at=timezone.now(),
        )


def usage_summary(actor: Actor, *, days: int = 30) -> dict:
    """Organization-wide usage for the last ``days`` days (admin view)."""
    from django.db.models import Sum

    since = timezone.now().date() - dt.timedelta(days=days)
    rows = AIUsage.objects.filter(day__gte=since)
    totals = rows.aggregate(
        requests=Sum("requests"),
        input_tokens=Sum("input_tokens"),
        output_tokens=Sum("output_tokens"),
        cache_read_tokens=Sum("cache_read_tokens"),
        cost=Sum("estimated_cost_usd"),
        flagged=Sum("flagged_inputs"),
    )
    by_feature = list(
        rows.values("feature").annotate(requests=Sum("requests"), cost=Sum("estimated_cost_usd")).order_by("-requests")
    )
    by_member = list(
        rows.values(
            "membership_id", "membership__user__first_name", "membership__user__last_name", "membership__user__email"
        )
        .annotate(requests=Sum("requests"), cost=Sum("estimated_cost_usd"))
        .order_by("-requests")[:20]
    )
    return {
        "since": since,
        "requests": totals["requests"] or 0,
        "input_tokens": totals["input_tokens"] or 0,
        "output_tokens": totals["output_tokens"] or 0,
        "cache_read_tokens": totals["cache_read_tokens"] or 0,
        "estimated_cost_usd": str((totals["cost"] or Decimal("0")).quantize(Decimal("0.01"))),
        "flagged_inputs": totals["flagged"] or 0,
        "by_feature": [
            {"feature": r["feature"], "requests": r["requests"], "cost": str(r["cost"] or 0)} for r in by_feature
        ],
        "by_member": [
            {
                "membership_id": str(r["membership_id"]),
                "display_name": f"{r['membership__user__first_name']} {r['membership__user__last_name']}".strip()
                or (r["membership__user__email"] or "").split("@")[0],
                "requests": r["requests"],
                "cost": str(r["cost"] or 0),
            }
            for r in by_member
        ],
        "tokens_today": tokens_used_today(actor.organization.pk),
        "limits": {
            "user_requests_per_hour": settings.AI_USER_REQUESTS_PER_HOUR,
            "org_tokens_per_day": settings.AI_ORG_TOKENS_PER_DAY,
            "model_fast": settings.AI_MODEL_FAST,
            "model_strong": settings.AI_MODEL_STRONG,
        },
    }


def tokens_used_today(organization_id: uuid.UUID) -> int:
    try:
        return int(cache.get(f"ai:tok:{organization_id}:{timezone.now().strftime('%Y%m%d')}") or 0)
    except Exception:
        return 0


# --------------------------------------------------------------------------- assistant gating
#
# Ask Keel must never answer "you are over quota" and stop there: it degrades to CRM + RAG instead.
# So alongside ``check_quota`` (which raises, for the draft/summary features where refusing is the
# only sensible outcome) there is a non-raising check the assistant consults before reaching for a
# model. Same limits, different failure mode.

GENERATIVE_OK = ""
REASON_DISABLED = "ai_disabled"
REASON_USER_QUOTA = "user_quota"
REASON_ORG_QUOTA = "org_quota"
REASON_BUDGET = "monthly_budget"


def month_to_date_cost(actor: Actor) -> Decimal:
    """Estimated spend this calendar month, from the durable ledger (survives a cache restart)."""
    from django.db.models import Sum

    first = timezone.now().date().replace(day=1)
    total = AIUsage.objects.filter(day__gte=first).aggregate(cost=Sum("estimated_cost_usd"))["cost"]
    return total or Decimal("0")


def generative_reason(actor: Actor, *, consume: bool = True) -> str:
    """Empty string when a model call is allowed; otherwise why it is not.

    ``consume`` counts the request against the per-member hourly limit, exactly as ``check_quota``
    does, so an assistant question and a draft draw on the same budget.
    """
    from apps.ai import orgsettings

    policy = orgsettings.policy(actor)
    if not policy.enabled:
        return REASON_DISABLED
    if policy.has_budget_limit and month_to_date_cost(actor) >= policy.monthly_budget_usd:
        return REASON_BUDGET
    limit = policy.user_requests_per_hour
    if limit > 0:
        used = _incr(_user_key(actor), 1, HOUR) if consume else int(cache.get(_user_key(actor)) or 0)
        if used > limit:
            return REASON_USER_QUOTA
    try:
        tokens_today = int(cache.get(_org_key(actor)) or 0)
    except Exception:
        tokens_today = 0
    if settings.AI_ORG_TOKENS_PER_DAY > 0 and tokens_today >= settings.AI_ORG_TOKENS_PER_DAY:
        return REASON_ORG_QUOTA
    return GENERATIVE_OK
