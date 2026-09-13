"""Router-driven cross-tenant tests: every tenant resource exposed by a viewset is probed from another org.

For each registered viewset whose serializer model is tenant-owned, a record is created in Org B and
requested by Org A's owner (the most privileged role). Every detail method must answer 404 and the
list must not include the foreign id. A viewset whose model has no factory fails loudly.
"""

from __future__ import annotations

import re

import pytest
from django.urls import get_resolver

from apps.core.models import TenantModel
from tests import factories

pytestmark = pytest.mark.django_db

_DETAIL_RE = re.compile(r"\(\?P<pk>")


def _collect_viewset_routes():
    """Yield (viewset_cls, path_template_without_pk, detail_methods, list_path)."""
    resolver = get_resolver()
    found: dict[type, dict] = {}

    def walk(patterns, prefix=""):
        for p in patterns:
            if hasattr(p, "url_patterns"):
                walk(p.url_patterns, prefix + str(p.pattern))
                continue
            callback = p.callback
            actions = getattr(callback, "actions", None)
            cls = getattr(callback, "cls", None)
            if not actions or cls is None:
                continue
            entry = found.setdefault(cls, {"detail": {}, "list": None})
            regex = p.pattern.regex.pattern
            full = prefix + str(p.pattern)
            if _DETAIL_RE.search(regex) or "<pk>" in full:
                if not any(a in {"preview", "accept"} for a in actions.values()):
                    entry["detail"][full] = actions
            elif set(actions.values()) & {"list"}:
                entry["list"] = full

    walk(resolver.url_patterns)
    return found


def _django_path(template: str, pk) -> str:
    path = re.sub(r"<pk>|\(\?P<pk>[^)]*\)", str(pk), template)
    path = path.replace("^", "").replace("$", "")
    return "/" + path.lstrip("/")


def _model_for(cls):
    ser = getattr(cls, "serializer_class", None)
    return getattr(getattr(ser, "Meta", None), "model", None)


def test_registry_covers_all_tenant_viewsets():
    missing = []
    for cls in _collect_viewset_routes():
        model = _model_for(cls)
        if model is None:
            continue
        is_tenant_model = issubclass(model, TenantModel) or model.__name__ == "AuditEvent"
        if is_tenant_model and model not in factories.CROSS_TENANT_FACTORIES:
            missing.append(f"{cls.__name__} -> {model.__name__}")
    assert not missing, f"Add cross-tenant factories for: {missing}"


@pytest.mark.parametrize("cls", list(_collect_viewset_routes().keys()), ids=lambda c: c.__name__)
def test_cross_tenant_detail_and_list(cls, org_a, org_b, client_for):
    model = _model_for(cls)
    factory = factories.CROSS_TENANT_FACTORIES.get(model)
    if factory is None:
        pytest.skip(f"{cls.__name__} has no tenant model")
    foreign = factory(org_b)
    routes = _collect_viewset_routes()[cls]
    client = client_for(org_a.owner, org_a.owner_membership)

    probed = 0
    for template, actions in routes["detail"].items():
        for method in list(actions):  # DRF adds 'head' to the dict on first dispatch
            if method.upper() == "OPTIONS":
                continue
            resp = getattr(client, method.lower())(_django_path(template, foreign.pk), {}, format="json")
            assert resp.status_code == 404, f"{cls.__name__} {method} {template} returned {resp.status_code}"
            probed += 1
    assert probed > 0, f"{cls.__name__} exposes no detail routes to probe"

    if routes["list"]:
        resp = client.get(_django_path(routes["list"], ""))
        assert resp.status_code == 200
        body = resp.json()
        ids = {item["id"] for item in body.get("results", body if isinstance(body, list) else [])}
        assert str(foreign.pk) not in ids
