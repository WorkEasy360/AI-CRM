"""Every API route must declare how it is protected. A new endpoint without a permission fails CI."""

from __future__ import annotations

from django.urls import get_resolver
from rest_framework.permissions import AllowAny

from apps.authz.permissions import DenyAll, IsAuthenticatedUser, RequirePermissions

# Routes that are deliberately reachable without an organization (reviewed list).
ALLOWED_WITHOUT_ORG = {
    "session": IsAuthenticatedUser,
    "session-switch": IsAuthenticatedUser,
    "organization-create": IsAuthenticatedUser,
}
ALLOWED_SCHEMA_ROUTES = {"schema", "docs"}
HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def _walk(patterns, prefix=""):
    for p in patterns:
        if hasattr(p, "url_patterns"):
            yield from _walk(p.url_patterns, prefix + str(p.pattern))
        else:
            yield prefix + str(p.pattern), p


def test_every_api_route_declares_protection():
    problems = []
    for full, pattern in _walk(get_resolver().url_patterns):
        if not full.startswith("api/v1/"):
            continue
        callback = pattern.callback
        cls = getattr(callback, "cls", None)
        name = pattern.name
        if cls is None:
            problems.append(f"{full}: not a DRF view")
            continue
        if name in ALLOWED_SCHEMA_ROUTES:
            continue
        perm_classes = list(getattr(cls, "permission_classes", []))
        actions = getattr(callback, "actions", None)
        if actions:  # viewset
            if RequirePermissions not in perm_classes:
                problems.append(f"{full}: viewset {cls.__name__} lacks RequirePermissions")
            public = getattr(cls, "public_actions", {})
            for action in actions.values():
                if action in public:
                    allowed = public[action]
                    if any(c is AllowAny for c in allowed) and action not in {"preview"}:
                        problems.append(f"{full}: unexpected AllowAny action {action}")
                elif action not in getattr(cls, "permission_map", {}):
                    problems.append(f"{full}: action {action!r} missing from {cls.__name__}.permission_map")
            continue
        if RequirePermissions in perm_classes:
            mapping = getattr(cls, "permission_map", {})
            for method in HTTP_METHODS:
                if hasattr(cls, method) and method.upper() not in mapping:
                    problems.append(f"{full}: method {method.upper()} missing from {cls.__name__}.permission_map")
        elif name in ALLOWED_WITHOUT_ORG:
            if perm_classes != [ALLOWED_WITHOUT_ORG[name]]:
                problems.append(f"{full}: expected {ALLOWED_WITHOUT_ORG[name].__name__}")
        elif DenyAll in perm_classes or not perm_classes:
            problems.append(f"{full}: view {cls.__name__} is unreachable (DenyAll); declare permissions")
        else:
            problems.append(f"{full}: view {cls.__name__} uses unreviewed permission classes {perm_classes}")
    assert not problems, "\n".join(problems)
