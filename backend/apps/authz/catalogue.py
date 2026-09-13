"""The permission catalogue. Permissions are code-defined strings; roles reference them.

Adding a permission here is a reviewed change. Unknown permission strings are rejected at import
time by ``apps.authz.roles`` and at runtime by ``apps.authz.service``.
"""

from __future__ import annotations

SCOPE_OWN = "own"
SCOPE_TEAM = "team"
SCOPE_ALL = "all"
SCOPES: tuple[str, ...] = (SCOPE_OWN, SCOPE_TEAM, SCOPE_ALL)
SCOPE_RANK = {SCOPE_OWN: 0, SCOPE_TEAM: 1, SCOPE_ALL: 2}


def _crud(module: str, *extra: str) -> list[str]:
    base = [f"{module}.view", f"{module}.create", f"{module}.update", f"{module}.delete"]
    return base + [f"{module}.{e}" for e in extra]


PERMISSIONS: frozenset[str] = frozenset(
    [
        # organization & administration
        "org.view",
        "org.update",
        "org.delete",
        "org.billing",
        "members.view",
        "members.invite",
        "members.update_role",
        "members.disable",
        "members.remove",
        "teams.view",
        "teams.manage",
        "roles.view",
        "roles.manage",
        "audit.view",
        "settings.manage",
        # CRM core (Phase 2)
        *_crud("contacts", "export", "import", "bulk_update"),
        *_crud("companies", "export", "import", "bulk_update"),
        *_crud("products", "export", "import"),
        *_crud("deals", "change_stage", "reassign", "export", "import", "bulk_update"),
        "pipelines.view",
        "pipelines.manage",
        "customfields.view",
        "customfields.manage",
        "tags.view",
        "tags.manage",
        "notes.view",
        # sales operations (Phase 3)
        *_crud("activities"),
        "notes.create",
        "notes.update",
        "notes.delete",
        "dashboards.view",
        "dashboards.manage_own",
        "dashboards.manage_shared",
        "reports.view",
        "reports.export",
        "search.use",
        # AI (Phase 4)
        "ai.copilot.use",
        "ai.actions.confirm",
        "ai.scores.view",
        "ai.settings.manage",
        # integrations (Phase 5)
        "integrations.view",
        "integrations.manage",
        "webhooks.manage",
        # privacy
        "privacy.export_all",
        "privacy.delete_data",
    ]
)


def validate_permission(permission: str) -> str:
    if permission not in PERMISSIONS:
        raise ValueError(f"Unknown permission: {permission!r}")
    return permission


def validate_scope(scope: str) -> str:
    if scope not in SCOPES:
        raise ValueError(f"Unknown scope: {scope!r}")
    return scope
