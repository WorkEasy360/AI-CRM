"""Cached dashboard data must never cross organizations, users or permission scopes."""

from __future__ import annotations

import pytest

from apps.authz.actor import build_actor
from apps.core.tenancy.context import tenant_context
from apps.dashboards import cache as dashboard_cache

pytestmark = [pytest.mark.django_db, pytest.mark.security]


def _in_context(bundle, membership, fn):
    """Run ``fn(actor)`` the way a request would: with the member's tenant context bound."""
    from apps.accounts.models import Membership

    membership = membership or bundle.owner_membership
    with tenant_context(bundle.org.pk, user_id=membership.user_id, membership_id=membership.pk, reason="test"):
        actor = build_actor(Membership.objects.select_related("user", "role", "organization").get(pk=membership.pk))
        return fn(actor)


def _key(bundle, membership=None, period="30d"):
    return _in_context(bundle, membership, lambda a: dashboard_cache.cache_key(a, period=period, pipeline_id=None))


def _fingerprint(bundle, membership=None):
    return _in_context(bundle, membership, dashboard_cache.scope_fingerprint)


def test_cache_keys_differ_per_organization_user_and_scope(org_a, org_b, make_member):
    rep = make_member(org_a, "sales_rep")
    keys = {_key(org_a), _key(org_b), _key(org_a, rep), _key(org_a, period="7d")}
    assert len(keys) == 4
    assert str(org_a.org.pk) in _key(org_a)
    assert str(org_a.org.pk) not in _key(org_b)


def test_org_a_dashboard_is_never_served_to_org_b(org_a, org_b, crm, client_for):
    crm.make_contact(org_a)
    crm.make_contact(org_a)
    a = client_for(org_a.owner, org_a.owner_membership).get("/api/v1/dashboard/")
    assert a.status_code == 200 and a.json()["contacts_created"] == 2
    b = client_for(org_b.owner, org_b.owner_membership).get("/api/v1/dashboard/")
    assert b.status_code == 200 and b.json()["contacts_created"] == 0
    # And again from the (now warm) cache: still isolated.
    assert client_for(org_b.owner, org_b.owner_membership).get("/api/v1/dashboard/").json()["contacts_created"] == 0
    assert client_for(org_a.owner, org_a.owner_membership).get("/api/v1/dashboard/").json()["contacts_created"] == 2


def test_narrower_scope_never_sees_wider_cached_numbers(org_a, crm, make_member, client_for):
    rep = make_member(org_a, "sales_rep")  # own-scope on contacts
    crm.make_contact(org_a)  # owned by the owner, invisible to the rep
    owner = client_for(org_a.owner, org_a.owner_membership).get("/api/v1/dashboard/")
    assert owner.json()["contacts_created"] == 1
    mine = client_for(rep.user, rep).get("/api/v1/dashboard/")
    assert mine.json()["contacts_created"] == 0


def test_writes_invalidate_the_organizations_dashboard(org_a, owner_client):
    assert owner_client.get("/api/v1/dashboard/").json()["contacts_created"] == 0
    resp = owner_client.post("/api/v1/contacts/", {"first_name": "Ada"}, format="json")
    assert resp.status_code == 201
    assert owner_client.get("/api/v1/dashboard/").json()["contacts_created"] == 1


def test_role_change_changes_the_scope_fingerprint(org_a, make_member):
    rep = make_member(org_a, "sales_rep")
    before = _fingerprint(org_a, rep)
    from apps.authz.models import Role

    with tenant_context(org_a.org.pk, reason="test"):
        rep.role = Role.objects.get(key="sales_manager", is_system=True, organization__isnull=True)
        rep.save(update_fields=["role"])
    after = _fingerprint(org_a, rep)
    assert before != after


def test_dashboard_works_when_cache_is_unavailable(org_a, owner_client, monkeypatch):
    def broken(*args, **kwargs):
        raise ConnectionError("redis down")

    # Only the dashboard cache path is broken here; in production django-redis swallows connection
    # errors for every caller (CACHE_FAIL_OPEN), which the locmem test cache does not emulate.
    class Broken:
        get = set = incr = add = delete = staticmethod(broken)

    monkeypatch.setattr(dashboard_cache, "cache", Broken())
    resp = owner_client.get("/api/v1/dashboard/")
    assert resp.status_code == 200
    assert resp["Cache-Control"] == "no-store"


def test_dashboard_responses_are_never_edge_cacheable(org_a, owner_client):
    assert owner_client.get("/api/v1/dashboard/")["Cache-Control"] == "no-store"
