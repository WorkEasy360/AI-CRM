"""The dependency direction, enforced.

The audit found one strongly connected component containing thirteen apps, held together by a handful
of edges and papered over with function-level imports. A lazy import is not a decoupling: it is the
same dependency, hidden from every tool that would have told you about it. So this file parses the
source (including imports inside functions) rather than watching what happens to import cleanly.

The direction being enforced:

    apps.core.*  primitives        models, tenancy, concurrency, crypto, validators,
       ^                           exceptions, rls, search, health, domain_events, checks
       |                           -> import NO other app, ever
    platform services             apps.audit, apps.authz, apps.accounts, apps.teams
       ^
    business services             apps.crm.records, apps.<module>.services
       ^
    application layer             apps.*.api, middleware, management commands

Only the first rule is asserted absolutely, because it is the one that pays for itself: with the
primitives as a genuine sink, no module below can ever be dragged into a cycle by something above it,
and ``apps.core.domain_events`` can be the place where a write announces itself without core needing
to know who is listening.

The rest is asserted as specific, named prohibitions rather than a total order, which would demand
exactly the abstraction-heavy rewrite this codebase does not need.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

pytestmark = pytest.mark.security

APPS = pathlib.Path(__file__).resolve().parents[2] / "apps"

# The core primitives: the sink. Everything here must be importable without pulling in any other app.
CORE_PRIMITIVES = {
    "apps/core/models.py",
    "apps/core/exceptions.py",
    "apps/core/crypto.py",
    "apps/core/validators.py",
    "apps/core/concurrency.py",
    "apps/core/rls.py",
    "apps/core/search.py",
    "apps/core/health.py",
    "apps/core/domain_events.py",
    "apps/core/checks.py",
    "apps/core/apps.py",
    "apps/core/__init__.py",
    "apps/core/tenancy/context.py",
    "apps/core/tenancy/tasks.py",
    "apps/core/tenancy/__init__.py",
}

# Application-layer modules that happen to live under apps/core. They sit ABOVE the platform services
# and may import them; they are listed so the exception is deliberate and visible, not accidental.
CORE_APPLICATION_LAYER = {
    "apps/core/api/",
    "apps/core/tenancy/middleware.py",
    "apps/core/management/",
}

PLATFORM_APPS = {"audit", "authz", "accounts", "teams"}
# Business/domain apps: a platform service must never depend on one of these.
DOMAIN_APPS = {
    "activities",
    "ai",
    "assistant",
    "companies",
    "contacts",
    "crm",
    "customfields",
    "dashboards",
    "deals",
    "files",
    "forecasting",
    "importexport",
    "integrations",
    "lifecycle",
    "notes",
    "notifications",
    "pipelines",
    "products",
    "rag",
    "search",
    "tagging",
}


def _imports(path: pathlib.Path) -> list[tuple[str, int, bool]]:
    """Every ``apps.*`` import in one file: (module, line, is_lazy). TYPE_CHECKING blocks excluded --
    those never execute, so they cannot create a runtime cycle."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    lazy: set[int] = set()
    typing_only: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            lazy.update(id(sub) for sub in ast.walk(node))
        if isinstance(node, ast.If):
            name = getattr(node.test, "id", None) or getattr(node.test, "attr", None)
            if name == "TYPE_CHECKING":
                typing_only.update(id(sub) for sub in ast.walk(node))

    found: list[tuple[str, int, bool]] = []
    for node in ast.walk(tree):
        if id(node) in typing_only or not isinstance(node, ast.Import | ast.ImportFrom):
            continue
        if isinstance(node, ast.Import):
            modules = [n.name for n in node.names]
        elif node.module and node.level == 0:
            modules = [node.module]
        else:
            continue
        for module in modules:
            if module.startswith("apps."):
                found.append((module, node.lineno, id(node) in lazy))
    return found


def _rel(path: pathlib.Path) -> str:
    return str(path.relative_to(APPS.parent)).replace("\\", "/")


def _python_files():
    for path in APPS.rglob("*.py"):
        rel = _rel(path)
        if "__pycache__" in rel or "/migrations/" in rel:
            continue
        yield path, rel


def _app_of(module: str) -> str:
    return module.split(".")[1]


# --------------------------------------------------------------------------- the sink


def test_core_primitives_import_no_other_app():
    """The rule the whole direction rests on.

    A lazy import counts as a violation here. ``apps.core.records`` used to import accounts, audit,
    authz and dashboards at module level, which is what put core inside a thirteen-app cycle; it now
    lives in ``apps.crm``. If a primitive ever needs something from a service again, the answer is an
    event or a setting, not an import -- see apps/core/domain_events.py.
    """
    violations = []
    for path, rel in _python_files():
        if rel not in CORE_PRIMITIVES:
            continue
        for module, line, lazy in _imports(path):
            if _app_of(module) != "core":
                violations.append(f"{rel}:{line} imports {module}{' (lazy)' if lazy else ''}")
    assert violations == [], "core primitives must not depend on any other app:\n  " + "\n  ".join(violations)


def test_the_core_primitive_list_is_complete():
    """Every module under apps/core is classified, so a new one cannot quietly skip the rule."""
    unclassified = []
    for _path, rel in _python_files():
        if not rel.startswith("apps/core/"):
            continue
        if rel in CORE_PRIMITIVES or any(rel.startswith(prefix) for prefix in CORE_APPLICATION_LAYER):
            continue
        unclassified.append(rel)
    assert unclassified == [], (
        "new apps/core modules must be classified in CORE_PRIMITIVES (a sink) or "
        "CORE_APPLICATION_LAYER (may import services):\n  " + "\n  ".join(unclassified)
    )


def test_records_service_no_longer_lives_in_core():
    assert not (APPS / "core" / "records.py").exists()
    assert (APPS / "crm" / "records.py").exists()


# --------------------------------------------------------------------------- platform services


def test_platform_services_do_not_depend_on_domain_apps():
    """audit / authz / accounts / teams sit below the CRM modules and must stay there.

    Without this, 'who may do what' starts depending on 'what a deal is', and the authorization layer
    can no longer be reasoned about on its own.
    """
    violations = []
    for path, rel in _python_files():
        app = rel.split("/")[1]
        if app not in PLATFORM_APPS:
            continue
        for module, line, lazy in _imports(path):
            target = _app_of(module)
            if target in DOMAIN_APPS:
                violations.append(f"{rel}:{line} imports {module}{' (lazy)' if lazy else ''}")
    assert violations == [], "platform services must not depend on domain apps:\n  " + "\n  ".join(violations)


def test_domain_events_has_no_subscribers_compiled_in():
    """The spine must not know its listeners: that is the whole reason it can sit at the bottom."""
    imported = [module for module, _line, _lazy in _imports(APPS / "core" / "domain_events.py")]
    assert imported == [], f"domain_events must import no app module, found: {imported}"


def test_bulk_write_paths_announce_their_changes():
    """A guard against the regression this all exists to prevent: a QuerySet.update() in the shared
    record service that does not publish a domain event would silently stop feeding the outboxes."""
    source = (APPS / "crm" / "records.py").read_text(encoding="utf-8")
    bulk = source[source.index("def bulk(") :]
    assert bulk.count(".update(") <= bulk.count("_announce("), (
        "every bulk QuerySet.update() in records.bulk() must be paired with an _announce() call"
    )
