"""API scopes for machine credentials. Deny by default: there is no catch-all scope.

A scope expands to a fixed set of CRM permissions. A machine request is allowed only when the
permission is both in the expansion of the credential's scopes *and* granted to the member who
created the credential (``identity.build_integration_actor``).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ApiScope:
    key: str
    label: str
    permissions: frozenset[str]


API_SCOPES: dict[str, ApiScope] = {
    s.key: s
    for s in (
        ApiScope("contacts:read", "Read contacts", frozenset({"contacts.view"})),
        ApiScope(
            "contacts:write",
            "Create and update contacts",
            frozenset({"contacts.view", "contacts.create", "contacts.update"}),
        ),
        ApiScope("companies:read", "Read companies", frozenset({"companies.view"})),
        ApiScope(
            "companies:write",
            "Create and update companies",
            frozenset({"companies.view", "companies.create", "companies.update"}),
        ),
        ApiScope("deals:read", "Read deals", frozenset({"deals.view", "pipelines.view"})),
        ApiScope(
            "deals:write",
            "Create and update deals",
            frozenset({"deals.view", "deals.create", "deals.update", "deals.change_stage", "pipelines.view"}),
        ),
        ApiScope("activities:read", "Read activities", frozenset({"activities.view"})),
        ApiScope(
            "activities:write",
            "Create and update activities",
            frozenset({"activities.view", "activities.create", "activities.update"}),
        ),
    )
}

# URL prefixes a machine credential may call at all. Everything else (session, members, settings,
# integrations, AI, exports, allauth) refuses machine credentials before any view runs.
MACHINE_PATH_PREFIXES: tuple[str, ...] = (
    "/api/v1/contacts/",
    "/api/v1/companies/",
    "/api/v1/deals/",
    "/api/v1/activities/",
)


def validate_scopes(scopes: list[str]) -> list[str]:
    from rest_framework.exceptions import ValidationError

    cleaned = sorted({str(s) for s in scopes})
    unknown = [s for s in cleaned if s not in API_SCOPES]
    if unknown:
        raise ValidationError({"scopes": [f"Unknown scope: {s}" for s in unknown[:10]]})
    if not cleaned:
        raise ValidationError({"scopes": ["Choose at least one scope."]})
    return cleaned


def permissions_for(scopes: list[str]) -> frozenset[str]:
    permissions: set[str] = set()
    for key in scopes:
        scope = API_SCOPES.get(key)
        if scope is not None:
            permissions |= scope.permissions
    return frozenset(permissions)
