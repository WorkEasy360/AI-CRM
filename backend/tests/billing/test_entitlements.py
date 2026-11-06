"""Editions, limits, add-ons and the subscription lifecycle (apps.billing)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.billing import entitlements
from apps.billing.models import AddonPurchase, Subscription, UsageCounter
from apps.core.tenancy.context import system_context, tenant_context

pytestmark = pytest.mark.django_db


def _set_plan(bundle, edition: str, *, status: str = "active", seats: int = 0, **extra) -> None:
    with tenant_context(bundle.org.pk, reason="test.set_plan"):
        Subscription.objects.update(
            edition=edition, status=status, seats=seats, trial_ends_at=None, grandfathered=False, **extra
        )


def _set_usage(bundle, metric: str, used: int) -> None:
    with tenant_context(bundle.org.pk, reason="test.set_usage"):
        UsageCounter.objects.update_or_create(
            metric=metric, period_key=entitlements.period_key(metric), defaults={"used": used}
        )


def _contact(client, name="Ada"):
    return client.post("/api/v1/contacts/", {"first_name": name, "last_name": "Lovelace"}, format="json")


# ----------------------------------------------------------------------------- lifecycle


def test_new_organization_starts_on_premier_trial(org_a, owner_client):
    body = owner_client.get("/api/v1/billing/subscription/").json()
    assert body["edition"]["key"] == "premier" and body["status"] == "trialing"
    assert body["trial_ends_at"] is not None and "ai_suite" in body["features"]
    usage = owner_client.get("/api/v1/billing/usage/").json()
    by_key = {m["key"]: m for m in usage["metrics"]}
    assert by_key["pipelines"]["used"] == 1 and by_key["pipelines"]["limit"] == 5
    assert by_key["records"]["limit"] == 100_000
    assert {m["module"] for m in by_key["custom_fields"]["modules"]} == {"contact", "company", "deal", "product"}


def test_lapsed_trial_falls_back_to_free(org_a, owner_client):
    with tenant_context(org_a.org.pk, reason="test"):
        Subscription.objects.update(trial_ends_at=timezone.now() - timedelta(minutes=1))
    body = owner_client.get("/api/v1/billing/subscription/").json()
    assert body["edition"]["key"] == "free" and body["subscribed_edition"] == "premier"
    assert body["seat_limit"] == 1 and body["features"] == []


def test_catalogue_matches_the_published_limits(owner_client):
    editions = {e["key"]: e for e in owner_client.get("/api/v1/billing/editions/").json()["editions"]}
    assert [editions[k]["limits"]["records"] for k in ("free", "express", "premier", "edition_360")] == [
        500,
        50_000,
        100_000,
        1_000_000,
    ]
    assert [editions[k]["limits"]["pipelines"] for k in editions] == [1, 3, 5, 15]
    assert [editions[k]["limits"]["custom_fields"] for k in editions] == [0, 10, 25, 50]
    assert [editions[k]["limits"]["ai_credits"] for k in editions] == [0, 0, 1_000, 3_000]
    assert [editions[k]["price_annual_cents"] for k in editions] == [0, 700, 1200, 1800]
    assert [editions[k]["price_monthly_cents"] for k in editions] == [0, 900, 1500, 2100]
    assert "email_in" in editions["edition_360"]["features"] and "email_in" not in editions["premier"]["features"]


# ----------------------------------------------------------------------------- limits


def test_pipeline_limit_blocks_with_upgrade_path(org_a, owner_client):
    _set_plan(org_a, "free")
    resp = owner_client.post("/api/v1/pipelines/", {"name": "Partners"}, format="json")
    assert resp.status_code == 403
    body = resp.json()
    assert body["type"] == "plan_limit_reached"
    assert body["upgrade"]["metric"] == "pipelines" and body["upgrade"]["limit"] == 1
    assert body["upgrade"]["required_edition"]["key"] == "express"
    _set_plan(org_a, "express")
    assert owner_client.post("/api/v1/pipelines/", {"name": "Partners"}, format="json").status_code == 201


def test_record_limit_counts_creates_archives_and_restores(org_a, owner_client):
    _set_plan(org_a, "free")
    _set_usage(org_a, "records", 499)
    first = _contact(owner_client)
    assert first.status_code == 201, first.content
    blocked = _contact(owner_client, "Grace")
    assert blocked.status_code == 403 and blocked.json()["type"] == "plan_limit_reached"
    assert blocked.json()["upgrade"]["required_edition"]["key"] == "express"
    # archiving frees a slot; restoring takes it again
    cid = first.json()["id"]
    assert owner_client.delete(f"/api/v1/contacts/{cid}/").status_code == 204
    second = _contact(owner_client, "Grace")
    assert second.status_code == 201
    assert owner_client.post(f"/api/v1/contacts/{cid}/restore/").status_code == 403


def test_addon_purchase_raises_the_limit_immediately(org_a, owner_client):
    _set_plan(org_a, "express", seats=1)
    _set_usage(org_a, "records", 50_000)
    assert _contact(owner_client).status_code == 403
    resp = owner_client.post("/api/v1/billing/addons/", {"addon": "extra_records", "quantity": 1}, format="json")
    assert resp.status_code == 201, resp.content
    assert _contact(owner_client).status_code == 201
    usage = {m["key"]: m for m in owner_client.get("/api/v1/billing/usage/").json()["metrics"]}
    assert usage["records"]["limit"] == 55_000 and usage["records"]["addon_amount"] == 5_000
    # cancelling removes the extra allowance again
    owner_client.post(f"/api/v1/billing/addons/{resp.json()['id']}/cancel/")
    with tenant_context(org_a.org.pk, reason="test"):
        assert entitlements.resolve(org_a.org).limit("records") == 50_000


def test_addons_require_a_paid_plan(org_a, owner_client):
    _set_plan(org_a, "free")
    resp = owner_client.post("/api/v1/billing/addons/", {"addon": "extra_records"}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "addon_requires_paid_plan"


def test_custom_field_limit_is_per_module(org_a, owner_client):
    _set_plan(org_a, "free")
    payload = {"entity_type": "contact", "key": "tier", "label": "Tier", "field_type": "text"}
    resp = owner_client.post("/api/v1/custom-fields/", payload, format="json")
    assert resp.status_code == 403 and resp.json()["upgrade"]["metric"] == "custom_fields"
    _set_plan(org_a, "express")
    for i in range(10):
        body = {**payload, "key": f"f{i}", "label": f"Field {i}"}
        assert owner_client.post("/api/v1/custom-fields/", body, format="json").status_code == 201
    assert owner_client.post("/api/v1/custom-fields/", {**payload, "key": "f10"}, format="json").status_code == 403
    # another module has its own allowance
    other = {**payload, "entity_type": "deal", "key": "d0"}
    assert owner_client.post("/api/v1/custom-fields/", other, format="json").status_code == 201


def test_free_plan_is_single_user_and_paid_plans_are_limited_by_licences(org_a, owner_client):
    _set_plan(org_a, "free")
    resp = owner_client.post("/api/v1/invitations/", {"email": "two@example.com", "role": "viewer"}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "user_limit_reached"
    assert resp.json()["upgrade"]["metric"] == "users"
    _set_plan(org_a, "express", seats=2)
    assert (
        owner_client.post(
            "/api/v1/invitations/", {"email": "two@example.com", "role": "viewer"}, format="json"
        ).status_code
        == 201
    )
    resp = owner_client.post("/api/v1/invitations/", {"email": "three@example.com", "role": "viewer"}, format="json")
    assert resp.status_code == 403


def test_counter_cannot_be_overdrawn_at_the_boundary(org_a):
    _set_plan(org_a, "free")
    _set_usage(org_a, "records", 499)
    with tenant_context(org_a.org.pk, reason="test"):
        assert entitlements.consume(org_a.org, "records") == 500
        with pytest.raises(entitlements.LimitReached):
            entitlements.consume(org_a.org, "records")
        entitlements.release(org_a.org, "records", 10_000)
        assert entitlements.usage(org_a.org, "records") == 0  # never negative


def test_reconcile_repairs_drift(org_a, crm):
    crm.make_contact(org_a)  # factory bypasses the service: the counter does not know about it
    with tenant_context(org_a.org.pk, reason="test"):
        UsageCounter.objects.create(metric="records", period_key="", used=40)
        assert entitlements.reconcile(org_a.org) == {"records": -39}
        assert entitlements.usage(org_a.org, "records") == 1


# ----------------------------------------------------------------------------- feature gates


def test_feature_gates_name_the_edition_that_unlocks_them(org_a):
    _set_plan(org_a, "express")
    with tenant_context(org_a.org.pk, reason="test"):
        entitlements.check_feature(org_a.org, "whatsapp")
        with pytest.raises(entitlements.FeatureNotInPlan) as exc:
            entitlements.check_feature(org_a.org, "ai_suite")
        assert exc.value.extra["upgrade"]["required_edition"]["key"] == "premier"
        with pytest.raises(entitlements.FeatureNotInPlan) as exc:
            entitlements.check_feature(org_a.org, "email_in")
        assert exc.value.extra["upgrade"]["required_edition"]["key"] == "edition_360"


def test_ai_copilot_is_blocked_below_premier(org_a, owner_client, crm):
    contact = crm.make_contact(org_a)
    _set_plan(org_a, "express")
    resp = owner_client.post(
        "/api/v1/ai/follow-up/", {"entity_type": "contact", "entity_id": str(contact.pk)}, format="json"
    )
    assert resp.status_code == 403 and resp.json()["type"] == "feature_not_in_plan"
    assert resp.json()["upgrade"]["feature"] == "ai_suite"


def test_data_backup_addon_grants_its_feature(org_a, owner_client):
    _set_plan(org_a, "express", seats=1)
    assert owner_client.post("/api/v1/billing/addons/", {"addon": "data_backup"}, format="json").status_code == 201
    with tenant_context(org_a.org.pk, reason="test"):
        assert entitlements.has_feature(org_a.org, "data_backup")


# ----------------------------------------------------------------------------- plan changes


def test_plan_change_is_owner_only_and_audited(org_a, owner_client, make_member, client_for):
    admin = make_member(org_a, "admin")
    admin_client = client_for(admin.user, admin)
    assert admin_client.post("/api/v1/billing/subscription/", {"edition": "express"}, format="json").status_code == 403
    resp = owner_client.post(
        "/api/v1/billing/subscription/",
        {"edition": "edition_360", "billing_cycle": "monthly", "seats": 3},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["edition"]["key"] == "edition_360" and body["status"] == "active" and body["seat_limit"] == 3
    with system_context("test"):
        event = AuditEvent.objects.filter(organization_id=org_a.org.pk, action="billing.plan_changed").get()
    assert event.metadata["before"]["edition"] == "premier" and event.metadata["after"]["edition"] == "edition_360"


def test_plan_change_validates_seats_and_downgrades(org_a, owner_client, make_member):
    make_member(org_a, "sales_rep")
    resp = owner_client.post("/api/v1/billing/subscription/", {"edition": "express", "seats": 1}, format="json")
    assert resp.status_code == 409 and resp.json()["type"] == "seats_below_users"
    resp = owner_client.post("/api/v1/billing/subscription/", {"edition": "free"}, format="json")
    assert resp.status_code == 409 and resp.json()["type"] == "downgrade_blocked"


def test_self_service_can_be_switched_off(org_a, owner_client, settings):
    settings.BILLING_SELF_SERVICE = False
    resp = owner_client.post("/api/v1/billing/subscription/", {"edition": "express"}, format="json")
    assert resp.status_code == 409 and resp.json()["type"] == "billing_self_service_disabled"
    assert owner_client.get("/api/v1/billing/subscription/").json()["self_service"] is False


def test_billing_disabled_grandfathers_new_organizations(settings, make_org, client_for):
    settings.BILLING_ENABLED = False
    bundle = make_org("Legacy-like")
    body = client_for(bundle.owner, bundle.owner_membership).get("/api/v1/billing/subscription/").json()
    assert body["edition"]["key"] == "edition_360" and body["grandfathered"] and body["seat_limit"] is None


def test_billing_rows_are_tenant_isolated(org_a, org_b, owner_client, client_for):
    _set_plan(org_a, "express", seats=1)
    owner_client.post("/api/v1/billing/addons/", {"addon": "extra_records"}, format="json")
    other = client_for(org_b.owner, org_b.owner_membership)
    assert other.get("/api/v1/billing/addons/").json()["results"] == []
    with tenant_context(org_b.org.pk, reason="test"):
        assert AddonPurchase.objects.count() == 0
        assert Subscription.objects.get().edition == "premier"
