"""System role definitions. These are the single source of truth for built-in roles.

Custom roles (future) are stored in ``RolePermission`` rows; system roles are resolved from here so
the database can never drift from the reviewed definitions.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType

from apps.authz.catalogue import PERMISSIONS, SCOPE_ALL, SCOPE_OWN, SCOPE_TEAM, validate_permission, validate_scope

OWNER = "owner"
ADMIN = "admin"
SALES_MANAGER = "sales_manager"
SALES_REP = "sales_rep"
VIEWER = "viewer"


@dataclass(frozen=True)
class RoleDefinition:
    key: str
    name: str
    description: str
    grants: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for permission, scope in self.grants.items():
            validate_permission(permission)
            validate_scope(scope)
        object.__setattr__(self, "grants", MappingProxyType(dict(self.grants)))


def _all(scope: str = SCOPE_ALL, exclude: set[str] | None = None) -> dict[str, str]:
    exclude = exclude or set()
    return {p: scope for p in sorted(PERMISSIONS) if p not in exclude}


_COMMON_READ = {
    "org.view": SCOPE_ALL,
    "members.view": SCOPE_ALL,
    "teams.view": SCOPE_ALL,
    "roles.view": SCOPE_ALL,
    "products.view": SCOPE_ALL,
    "search.use": SCOPE_ALL,
    "ai.scores.view": SCOPE_ALL,
    "dashboards.view": SCOPE_ALL,
}

SYSTEM_ROLES: dict[str, RoleDefinition] = {
    OWNER: RoleDefinition(
        key=OWNER,
        name="Owner",
        description="Full control including billing and organization deletion.",
        grants=_all(),
    ),
    ADMIN: RoleDefinition(
        key=ADMIN,
        name="Admin",
        description="Full data and user management. Cannot delete the organization or manage billing.",
        grants=_all(exclude={"org.delete", "org.billing", "privacy.delete_data"}),
    ),
    SALES_MANAGER: RoleDefinition(
        key=SALES_MANAGER,
        name="Sales Manager",
        description="Manages all sales records, pipelines' deals, reports and exports.",
        grants={
            **_COMMON_READ,
            **{
                p: SCOPE_ALL
                for p in PERMISSIONS
                if p.split(".")[0] in {"contacts", "companies", "deals", "activities", "notes"}
            },
            "dashboards.manage_own": SCOPE_ALL,
            "dashboards.manage_shared": SCOPE_ALL,
            "reports.view": SCOPE_ALL,
            "reports.export": SCOPE_ALL,
            "ai.copilot.use": SCOPE_ALL,
            "ai.actions.confirm": SCOPE_ALL,
        },
    ),
    SALES_REP: RoleDefinition(
        key=SALES_REP,
        name="Sales Representative",
        description="Works own and team records.",
        grants={
            **_COMMON_READ,
            "contacts.view": SCOPE_TEAM,
            "contacts.create": SCOPE_ALL,
            "contacts.update": SCOPE_OWN,
            "contacts.delete": SCOPE_OWN,
            "companies.view": SCOPE_TEAM,
            "companies.create": SCOPE_ALL,
            "companies.update": SCOPE_OWN,
            "companies.delete": SCOPE_OWN,
            "deals.view": SCOPE_TEAM,
            "deals.create": SCOPE_ALL,
            "deals.update": SCOPE_OWN,
            "deals.delete": SCOPE_OWN,
            "deals.change_stage": SCOPE_OWN,
            "activities.view": SCOPE_TEAM,
            "activities.create": SCOPE_ALL,
            "activities.update": SCOPE_OWN,
            "activities.delete": SCOPE_OWN,
            "notes.create": SCOPE_ALL,
            "notes.update": SCOPE_OWN,
            "notes.delete": SCOPE_OWN,
            "dashboards.manage_own": SCOPE_ALL,
            "reports.view": SCOPE_TEAM,
            "ai.copilot.use": SCOPE_ALL,
            "ai.actions.confirm": SCOPE_OWN,
        },
    ),
    VIEWER: RoleDefinition(
        key=VIEWER,
        name="Viewer",
        description="Read-only access to CRM records and reports.",
        grants={
            **_COMMON_READ,
            "contacts.view": SCOPE_ALL,
            "companies.view": SCOPE_ALL,
            "deals.view": SCOPE_ALL,
            "activities.view": SCOPE_ALL,
            "reports.view": SCOPE_ALL,
        },
    ),
}

ROLE_ORDER = (OWNER, ADMIN, SALES_MANAGER, SALES_REP, VIEWER)
ASSIGNABLE_BY_ADMIN = frozenset({ADMIN, SALES_MANAGER, SALES_REP, VIEWER})


def get_role_definition(key: str) -> RoleDefinition:
    try:
        return SYSTEM_ROLES[key]
    except KeyError as exc:
        raise ValueError(f"Unknown system role: {key!r}") from exc
