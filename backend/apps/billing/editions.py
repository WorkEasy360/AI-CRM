"""The edition catalogue: what each plan includes. The single source of truth for limits and gates.

Code-defined on purpose (like ``apps.authz.roles``): a limit is a reviewed change, and the database can
never drift from what the pricing page promises. ``EntitlementService`` (``apps.billing.entitlements``)
is the only reader; no other module looks at edition keys.

``None`` in a limit means unlimited. Prices are USD cents per user per month.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType

FREE = "free"
EXPRESS = "express"
PREMIER = "premier"
EDITION_360 = "edition_360"

GB = 1024**3

# ----------------------------------------------------------------------------- metrics


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    # "count": live total (records, pipelines ...); "monthly"/"daily": consumed per calendar period.
    period: str = "count"
    unit: str = "count"
    # Limit applies per CRM module (custom fields): usage is reported per module.
    per_module: bool = False


METRICS: Mapping[str, Metric] = MappingProxyType(
    {
        m.key: m
        for m in (
            Metric("users", "Users"),
            Metric("records", "Records"),
            Metric("pipelines", "Team pipelines"),
            Metric("automation_rules", "Automation rules"),
            Metric("custom_fields", "Custom fields per module", per_module=True),
            Metric("booking_pages", "Booking pages"),
            Metric("ai_credits", "AI credits", period="monthly", unit="credits"),
            Metric("mass_emails", "Mass emails", period="daily", unit="emails"),
            Metric("file_storage", "File Cabinet storage", unit="bytes"),
            Metric("email_in_aliases", "Email-In aliases"),
        )
    }
)

# ----------------------------------------------------------------------------- features

FEATURES: Mapping[str, str] = MappingProxyType(
    {
        # Express
        "email_integration": "Email integration",
        "whatsapp": "WhatsApp integration",
        "mass_email": "Mass email with insights",
        "custom_dashboards": "Customizable dashboards",
        "accounting_integration": "Accounting integration",
        "meeting_integration": "Meeting integrations",
        "social_lead_ads": "Social lead-ads integration",
        "esign": "E-signature",
        "payment_links": "Payment links",
        # Premier
        "advanced_fields": "Lookup, formula and user fields",
        "stage_transition_rules": "Stage transition rules",
        "multi_currency": "Multi-currency",
        "target_meter": "Target Meter",
        "duplicate_cleanup": "Duplicate cleanup",
        "data_enrichment": "Data enrichment",
        "ai_suite": "AI suite",
        "advanced_automation": "Advanced automation",
        # 360
        "email_in": "Email-In",
        "file_cabinet": "File Cabinet",
        # Add-on only
        "data_backup": "Scheduled data backup",
    }
)

_EXPRESS_FEATURES = frozenset(
    {
        "email_integration",
        "whatsapp",
        "mass_email",
        "custom_dashboards",
        "accounting_integration",
        "meeting_integration",
        "social_lead_ads",
        "esign",
        "payment_links",
    }
)
_PREMIER_FEATURES = _EXPRESS_FEATURES | {
    "advanced_fields",
    "stage_transition_rules",
    "multi_currency",
    "target_meter",
    "duplicate_cleanup",
    "data_enrichment",
    "ai_suite",
    "advanced_automation",
}
_360_FEATURES = _PREMIER_FEATURES | {"email_in", "file_cabinet"}

# ----------------------------------------------------------------------------- editions


@dataclass(frozen=True)
class Edition:
    key: str
    name: str
    rank: int
    tagline: str
    price_monthly_cents: int
    price_annual_cents: int  # per user per month when billed annually
    limits: Mapping[str, int | None] = field(default_factory=dict)
    features: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        unknown = set(self.limits) - set(METRICS)
        if unknown or set(METRICS) - set(self.limits):
            raise ValueError(f"Edition {self.key!r} must define exactly the known metrics (bad: {unknown}).")
        if self.features - set(FEATURES):
            raise ValueError(f"Edition {self.key!r} has unknown features.")
        object.__setattr__(self, "limits", MappingProxyType(dict(self.limits)))


EDITIONS: Mapping[str, Edition] = MappingProxyType(
    {
        FREE: Edition(
            key=FREE,
            name="Free",
            rank=0,
            tagline="For a single person getting started.",
            price_monthly_cents=0,
            price_annual_cents=0,
            limits={
                "users": 1,
                "records": 500,
                "pipelines": 1,
                "automation_rules": 3,
                "custom_fields": 0,
                "booking_pages": 1,
                "ai_credits": 0,
                "mass_emails": 0,
                "file_storage": 0,
                "email_in_aliases": 0,
            },
            features=frozenset(),
        ),
        EXPRESS: Edition(
            key=EXPRESS,
            name="Express",
            rank=1,
            tagline="Email, WhatsApp and mass email for growing teams.",
            price_monthly_cents=900,
            price_annual_cents=700,
            limits={
                "users": None,
                "records": 50_000,
                "pipelines": 3,
                "automation_rules": 30,
                "custom_fields": 10,
                "booking_pages": 1,
                "ai_credits": 0,
                "mass_emails": 250,
                "file_storage": 0,
                "email_in_aliases": 0,
            },
            features=_EXPRESS_FEATURES,
        ),
        PREMIER: Edition(
            key=PREMIER,
            name="Premier",
            rank=2,
            tagline="Advanced automation, rules and the full AI suite.",
            price_monthly_cents=1500,
            price_annual_cents=1200,
            limits={
                "users": None,
                "records": 100_000,
                "pipelines": 5,
                "automation_rules": 50,
                "custom_fields": 25,
                "booking_pages": 1,
                "ai_credits": 1_000,
                "mass_emails": 500,
                "file_storage": 0,
                "email_in_aliases": 0,
            },
            features=_PREMIER_FEATURES,
        ),
        EDITION_360: Edition(
            key=EDITION_360,
            name="360",
            rank=3,
            tagline="Everything, with Email-In, File Cabinet and higher limits.",
            price_monthly_cents=2100,
            price_annual_cents=1800,
            limits={
                "users": None,
                "records": 1_000_000,
                "pipelines": 15,
                "automation_rules": 100,
                "custom_fields": 50,
                "booking_pages": 100,
                "ai_credits": 3_000,
                "mass_emails": 1_000,
                "file_storage": 5 * GB,
                "email_in_aliases": 5,
            },
            features=_360_FEATURES,
        ),
    }
)

EDITION_ORDER: tuple[str, ...] = (FREE, EXPRESS, PREMIER, EDITION_360)
TRIAL_EDITION = PREMIER
TRIAL_DAYS = 15


def get_edition(key: str) -> Edition:
    try:
        return EDITIONS[key]
    except KeyError as exc:
        raise ValueError(f"Unknown edition: {key!r}") from exc


def lowest_edition_with_feature(feature: str) -> Edition | None:
    for key in EDITION_ORDER:
        if feature in EDITIONS[key].features:
            return EDITIONS[key]
    return None


def lowest_edition_above(metric: str, amount: int) -> Edition | None:
    """The cheapest edition whose limit for ``metric`` admits ``amount``."""
    for key in EDITION_ORDER:
        limit = EDITIONS[key].limits[metric]
        if limit is None or limit >= amount:
            return EDITIONS[key]
    return None


# ----------------------------------------------------------------------------- add-ons


@dataclass(frozen=True)
class Addon:
    key: str
    label: str
    metric: str | None  # raises this metric's limit by ``unit_amount`` per unit
    unit_amount: int
    price_cents: int  # per unit per month (recurring) or per pack (one-off)
    recurring: bool = True
    feature: str | None = None  # grants a feature instead of raising a limit


ADDONS: Mapping[str, Addon] = MappingProxyType(
    {
        a.key: a
        for a in (
            Addon("extra_records", "5,000 extra records", "records", 5_000, 500),
            Addon("extra_automations", "10 extra automation rules", "automation_rules", 10, 500),
            Addon("extra_pipelines", "1 extra team pipeline", "pipelines", 1, 500),
            Addon("extra_booking_pages", "1 extra booking page", "booking_pages", 1, 200),
            Addon("extra_mass_emails", "500 extra mass emails per day", "mass_emails", 500, 500),
            Addon("ai_credits", "1,000 AI credits (this month)", "ai_credits", 1_000, 1000, recurring=False),
            Addon("extra_storage", "5 GB extra File Cabinet storage", "file_storage", 5 * GB, 400),
            Addon("data_backup", "Scheduled data backup", None, 0, 300, feature="data_backup"),
        )
    }
)


def get_addon(key: str) -> Addon:
    try:
        return ADDONS[key]
    except KeyError as exc:
        raise ValueError(f"Unknown add-on: {key!r}") from exc
