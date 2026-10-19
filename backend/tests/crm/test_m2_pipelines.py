"""Milestone 2 pipelines: templates, sub-pipelines, restricted team pipelines, the transition hook, the
board's paging and weighted forecast, and the pipeline limit with its add-on."""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.audit.models import AuditEvent
from apps.pipelines import transitions
from apps.pipelines.models import Pipeline
from apps.teams.models import TeamMembership
from tests.m2_helpers import in_org, member_with, profile, set_plan

pytestmark = pytest.mark.django_db

FIVE_STAGES = [
    {"name": "Lead in", "kind": "open", "default_probability": 10},
    {"name": "Demo", "kind": "open", "default_probability": 40},
    {"name": "Contract", "kind": "open", "default_probability": 80},
    {"name": "Signed", "kind": "won"},
    {"name": "Gone", "kind": "lost"},
]


def _create(client, **body):
    return client.post("/api/v1/pipelines/", body, format="json")


def test_templates_are_listed_and_new_orgs_start_on_the_sales_template(owner_client):
    templates = owner_client.get("/api/v1/pipelines/templates/").json()["results"]
    keys = {t["key"] for t in templates}
    assert {"sales", "inbound", "services", "renewals", "partnerships"} <= keys
    for t in templates:
        kinds = [s["kind"] for s in t["stages"]]
        assert "won" in kinds and "lost" in kinds and "open" in kinds
    default = owner_client.get("/api/v1/pipelines/").json()["results"][0]
    assert [s["name"] for s in default["stages"]] == [
        "Discovery",
        "Fit confirmed",
        "Proposal sent",
        "Terms agreed",
        "Won",
        "Lost",
    ]
    created = _create(owner_client, name="Renewals 2026", template="renewals").json()
    assert created["template_key"] == "renewals" and created["stages"][0]["name"] == "Renewal due"


def test_pipeline_with_five_stages_and_a_variant_on_the_board(org_a, owner_client, crm):
    """Acceptance: an admin creates a five-stage pipeline and a sub-pipeline; both board correctly."""
    parent = _create(owner_client, name="Enterprise", stages=FIVE_STAGES)
    assert parent.status_code == 201, parent.content
    parent = parent.json()
    variant = _create(
        owner_client,
        name="Enterprise - EMEA",
        parent_id=parent["id"],
        stages=[{"name": "Qualify", "kind": "open", "default_probability": 20}, *FIVE_STAGES[3:]],
    )
    assert variant.status_code == 201, variant.content
    variant = variant.json()
    assert variant["parent_id"] == parent["id"] and len(variant["stages"]) == 3

    def deal(pipeline, stage, amount):
        resp = owner_client.post(
            "/api/v1/deals/",
            {"name": f"D {amount}", "pipeline_id": pipeline["id"], "stage_id": stage["id"], "amount": amount},
            format="json",
        )
        assert resp.status_code == 201, resp.content

    by_name = {s["name"]: s for s in parent["stages"]}
    deal(parent, by_name["Lead in"], "1000")
    deal(parent, by_name["Demo"], "2000")
    deal(parent, by_name["Demo"], "3000")
    deal(parent, by_name["Signed"], "9000")
    deal(variant, variant["stages"][0], "500")

    board = owner_client.get(f"/api/v1/deals/board/?pipeline={parent['id']}").json()
    stages = {s["name"]: s for s in board["stages"]}
    assert stages["Demo"]["deal_count"] == 2 and stages["Demo"]["total_amount_base"] == "5000.00"
    assert stages["Demo"]["weighted_amount_base"] == "2000.00"  # 40% of 5000
    assert stages["Lead in"]["weighted_amount_base"] == "100.00"
    # forecast = open stages only: 100 + 2000
    assert board["totals"]["weighted_forecast_base"] == "2100.00"
    assert board["totals"]["open_amount_base"] == "6000.00"
    family = {f["name"] for f in board["family"]}
    assert family == {"Enterprise", "Enterprise - EMEA"}

    vboard = owner_client.get(f"/api/v1/deals/board/?pipeline={variant['id']}").json()
    assert vboard["pipeline"]["parent_id"] == parent["id"]
    assert vboard["stages"][0]["deal_count"] == 1 and vboard["totals"]["weighted_forecast_base"] == "100.00"


def test_sub_pipelines_do_not_count_against_the_pipeline_limit(org_a, owner_client):
    set_plan(org_a, "free")  # one team pipeline: the default one
    default = owner_client.get("/api/v1/pipelines/").json()["results"][0]
    blocked = _create(owner_client, name="Partners")
    assert blocked.status_code == 403 and blocked.json()["type"] == "plan_limit_reached"
    assert blocked.json()["upgrade"]["metric"] == "pipelines"
    variant = _create(owner_client, name="Partners (variant)", parent_id=default["id"])
    assert variant.status_code == 201, variant.content
    # a variant of a variant is refused
    nested = _create(owner_client, name="Too deep", parent_id=variant.json()["id"])
    assert nested.status_code == 400


def test_pipeline_addon_lifts_the_limit(org_a, owner_client):
    set_plan(org_a, "express", seats=1)
    for i in range(2):  # Express allows 3 team pipelines including the default
        assert _create(owner_client, name=f"P{i}").status_code == 201
    assert _create(owner_client, name="P-extra").status_code == 403
    assert owner_client.post("/api/v1/billing/addons/", {"addon": "extra_pipelines"}, format="json").status_code == 201
    assert _create(owner_client, name="P-extra").status_code == 201


PIPELINE_USER = {
    "org.view": "all",
    "search.use": "all",
    "pipelines.view": "all",
    "deals.view": "all",
    "deals.create": "all",
}


def test_restricted_pipeline_hides_itself_and_its_deals(org_a, owner_client, make_member, client_for, crm):
    restricted = _create(owner_client, name="Key accounts", stages=FIVE_STAGES, restricted=True).json()
    team = crm.make_team(org_a, "Key account team")
    # Members who see every deal but do not manage pipelines (pipeline managers always see every pipeline).
    key = profile(owner_client, "Pipeline user", PIPELINE_USER)
    insider = member_with(org_a, make_member, key)
    outsider = member_with(org_a, make_member, key)
    with in_org(org_a):
        TeamMembership.objects.create(team=team, membership=insider)
    resp = owner_client.put(
        f"/api/v1/pipelines/{restricted['id']}/access/",
        {"team_ids": [str(team.pk)], "hierarchy_role_ids": []},
        format="json",
    )
    assert resp.status_code == 200 and resp.json()["access"]["team_ids"] == [str(team.pk)]
    deal = owner_client.post(
        "/api/v1/deals/",
        {"name": "Globex renewal", "pipeline_id": restricted["id"], "amount": "100"},
        format="json",
    ).json()
    with in_org(org_a):
        assert AuditEvent.objects.filter(action="pipelines.access_changed").exists()

    out = client_for(outsider.user, outsider)
    ins = client_for(insider.user, insider)
    assert restricted["id"] not in {p["id"] for p in out.get("/api/v1/pipelines/").json()["results"]}
    assert out.get(f"/api/v1/deals/board/?pipeline={restricted['id']}").status_code == 404
    assert out.get(f"/api/v1/deals/{deal['id']}/").status_code == 404
    assert deal["id"] not in {d["id"] for d in out.get("/api/v1/deals/").json()["results"]}
    assert out.get("/api/v1/search/?q=Globex").json()["results"]["deal"] == []
    rows = out.get("/api/v1/records/deal/rows/").json()["rows"]
    assert deal["id"] not in {r["id"] for r in rows}
    # an outsider cannot create a deal in it either
    assert out.post("/api/v1/deals/", {"name": "x", "pipeline_id": restricted["id"]}, format="json").status_code == 400

    assert restricted["id"] in {p["id"] for p in ins.get("/api/v1/pipelines/").json()["results"]}
    assert ins.get(f"/api/v1/deals/{deal['id']}/").status_code == 200
    assert ins.get(f"/api/v1/deals/board/?pipeline={restricted['id']}").status_code == 200
    # pipeline managers always see every pipeline
    assert owner_client.get(f"/api/v1/deals/{deal['id']}/").status_code == 200


def test_access_grants_are_tenant_scoped(org_a, org_b, owner_client, crm):
    pipeline = _create(owner_client, name="Locked", restricted=True).json()
    foreign_team = crm.make_team(org_b, "Elsewhere")
    resp = owner_client.put(
        f"/api/v1/pipelines/{pipeline['id']}/access/",
        {"team_ids": [str(foreign_team.pk)], "hierarchy_role_ids": []},
        format="json",
    )
    assert resp.status_code == 400


def test_stage_moves_route_through_the_transition_hook(org_a, owner_client, crm):
    deal = crm.make_deal(org_a)
    pipeline = crm.make_pipeline(org_a)
    target = crm.stage_named(pipeline, "Proposal sent")
    seen: list[transitions.StageTransition] = []

    def refuse_proposals(t: transitions.StageTransition) -> None:
        seen.append(t)
        if t.to_stage.name == "Proposal sent":
            raise transitions.TransitionRefused("Attach a quote first.", rule="needs_quote", fields=("quote",))

    transitions.register_validator(refuse_proposals)
    try:
        resp = owner_client.post(
            f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": str(target.pk), "version": 1}, format="json"
        )
        assert resp.status_code == 409 and resp.json()["type"] == "stage_transition_refused"
        assert resp.json()["rule"] == "needs_quote"
        # the Sheet view's stage edit goes through the same hook
        edit = owner_client.post(
            "/api/v1/records/deal/edits/",
            {"rows": [{"id": str(deal.pk), "version": 1, "values": {"stage": str(target.pk)}}]},
            format="json",
        ).json()
        assert edit["results"][0]["status"] == "error"
        assert edit["results"][0]["errors"]["stage"]["code"] == "stage_transition_refused"
        assert all(t.deal.pk == deal.pk for t in seen) and len(seen) == 2
    finally:
        transitions.unregister_validator(refuse_proposals)
    ok = owner_client.post(f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": str(target.pk), "version": 1}, format="json")
    assert ok.status_code == 200


def test_board_pages_through_a_column(org_a, owner_client, crm):
    pipeline = crm.make_pipeline(org_a)
    stage = crm.stage_named(pipeline, "Discovery")
    for i in range(7):
        crm.make_deal(org_a, stage=stage, name=f"Deal {i}", amount=str(100 * (i + 1)), amount_base=str(100 * (i + 1)))
    board = owner_client.get(f"/api/v1/deals/board/?pipeline={pipeline.pk}&per_stage=3").json()
    column = next(s for s in board["stages"] if s["id"] == str(stage.pk))
    assert column["deal_count"] == 7 and len(column["deals"]) == 3 and column["has_more"] is True
    assert Decimal(column["total_amount_base"]) == Decimal("2800.00")
    more = owner_client.get(f"/api/v1/deals/board/stage/?stage={stage.pk}&offset=3&limit=10").json()
    assert len(more["deals"]) == 4 and more["has_more"] is False
    seen = {d["id"] for d in column["deals"]} | {d["id"] for d in more["deals"]}
    assert len(seen) == 7


def test_layout_is_validated_against_the_deal_schema(owner_client):
    ok = _create(owner_client, name="Laid out", layout={"card_fields": ["amount", "expected_close_date"]})
    assert ok.status_code == 201 and ok.json()["layout"] == {"card_fields": ["amount", "expected_close_date"]}
    bad = _create(owner_client, name="Bad layout", layout={"card_fields": ["no_such_field"]})
    assert bad.status_code == 400
    variant = _create(owner_client, name="Laid out EU", parent_id=ok.json()["id"])
    assert variant.json()["effective_layout"] == {"card_fields": ["amount", "expected_close_date"]}


def test_archived_variants_block_parent_archive(org_a, owner_client):
    parent = _create(owner_client, name="Parent").json()
    _create(owner_client, name="Child", parent_id=parent["id"])
    resp = owner_client.delete(f"/api/v1/pipelines/{parent['id']}/")
    assert resp.status_code == 409 and resp.json()["type"] == "pipeline_has_variants"
    with in_org(org_a):
        assert Pipeline.objects.filter(parent_id=parent["id"]).count() == 1


def test_card_layout_puts_its_fields_on_board_cards_minus_hidden_ones(
    org_a, owner_client, make_member, client_for, crm
):
    from tests.m2_helpers import restrict

    pipeline = crm.make_pipeline(org_a)
    resp = owner_client.patch(
        f"/api/v1/pipelines/{pipeline.pk}/", {"layout": {"card_fields": ["lost_reason", "amount"]}}, format="json"
    )
    assert resp.status_code == 200, resp.content
    rep = make_member(org_a, "sales_rep")
    crm.make_deal(org_a, owner=rep, lost_reason="n/a")
    card = owner_client.get("/api/v1/deals/board/").json()["stages"][0]["deals"][0]
    assert [e["key"] for e in card["extra"]] == ["lost_reason", "amount"]
    restrict(owner_client, "sales_rep", "deal", [{"field": "amount", "access": "hidden"}])
    rep_card = client_for(rep.user, rep).get("/api/v1/deals/board/").json()["stages"][0]["deals"][0]
    assert [e["key"] for e in rep_card["extra"]] == ["lost_reason"] and "amount" not in rep_card
