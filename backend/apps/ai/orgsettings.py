"""Per-workspace AI policy, stored on ``Organization.settings``.

Two things an administrator controls that the server environment cannot:

``ai_enabled``
    Off means *no text from this workspace is sent to an external model*, for any feature. Ask Keel
    keeps working: it answers from structured CRM data and the knowledge index, and says plainly
    that generative answers are switched off. This is the privacy/cost mode from
    docs -- a workspace that cannot send customer text to a vendor still gets a useful assistant.

``monthly_budget_usd``
    A ceiling on estimated spend, checked against the durable usage ledger rather than a cache
    counter so it survives a Redis restart. Reaching it degrades the assistant to retrieval-only
    for the rest of the month instead of failing requests.

Both are read on every AI call, so a change takes effect immediately with no deploy.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from django.conf import settings

from apps.authz.actor import Actor

AI_ENABLED_KEY = "ai_enabled"
BUDGET_KEY = "ai_monthly_budget_usd"
USER_LIMIT_KEY = "ai_user_requests_per_hour"


@dataclass(frozen=True)
class AIPolicy:
    enabled: bool
    monthly_budget_usd: Decimal
    user_requests_per_hour: int

    @property
    def has_budget_limit(self) -> bool:
        return self.monthly_budget_usd > 0


def policy_for(organization: Any) -> AIPolicy:
    raw = organization.settings or {}
    return AIPolicy(
        enabled=bool(raw.get(AI_ENABLED_KEY, True)),
        monthly_budget_usd=_decimal(raw.get(BUDGET_KEY), settings.AI_ORG_MONTHLY_BUDGET_USD),
        user_requests_per_hour=int(raw.get(USER_LIMIT_KEY) or settings.AI_USER_REQUESTS_PER_HOUR),
    )


def policy(actor: Actor) -> AIPolicy:
    return policy_for(actor.organization)


def update(
    actor: Actor, *, enabled: bool | None = None, monthly_budget_usd=None, user_requests_per_hour=None
) -> AIPolicy:
    """Apply an administrator's change. The caller has already checked ``ai.settings.manage``."""
    organization = actor.organization
    raw = dict(organization.settings or {})
    if enabled is not None:
        raw[AI_ENABLED_KEY] = bool(enabled)
    if monthly_budget_usd is not None:
        raw[BUDGET_KEY] = str(max(Decimal("0"), _decimal(monthly_budget_usd, 0)))
    if user_requests_per_hour is not None:
        raw[USER_LIMIT_KEY] = max(0, int(user_requests_per_hour))
    organization.settings = raw
    organization.save(update_fields=["settings", "updated_at"])
    return policy_for(organization)


def _decimal(value: Any, default: Any) -> Decimal:
    try:
        return Decimal(str(value if value not in (None, "") else default))
    except (ArithmeticError, ValueError):
        return Decimal(str(default))
