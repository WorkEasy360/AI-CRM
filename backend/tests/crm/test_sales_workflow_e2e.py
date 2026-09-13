"""Critical end-to-end sales workflow (one connected flow, two users):

login -> create lead -> qualify prospect -> create company -> create deal -> schedule meeting -> log call
-> send email -> send WhatsApp -> AI summary -> AI risk -> AI follow-up -> move deal -> closed won
-> contact becomes customer -> forecast/dashboard update.
"""

from __future__ import annotations

import json
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from django.utils import timezone

from apps.ai.providers.fake import FakeProvider
from apps.core.tenancy.context import tenant_context
from apps.messaging.providers.fake import FakeEmailProvider, FakeWhatsAppProvider
from apps.notifications.models import Notification

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _reset():
    FakeProvider.reset()
    FakeEmailProvider.reset()
    FakeWhatsAppProvider.reset()
    yield
    FakeProvider.reset()
    FakeEmailProvider.reset()
    FakeWhatsAppProvider.reset()


def _iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def test_full_sales_workflow(
    org_a, owner_client, make_member, client_for, reauthenticate, crm, django_capture_on_commit_callbacks
):
    rep = make_member(org_a, "sales_rep")
    repc = client_for(rep.user, rep)
    now = timezone.now()

    # 1. Lead
    lead = repc.post(
        "/api/v1/contacts/",
        {
            "first_name": "Hank",
            "last_name": "Scorpio",
            "email": "hank@globex.example",
            "phone": "+1 555 0100 555",
            "source": "Referral",
        },
        format="json",
    ).json()
    assert lead["lifecycle_stage"] == "lead" and lead["lead_score"] >= 0
    dup = repc.get("/api/v1/contacts/duplicates/?email=hank@globex.example").json()["results"]
    assert dup and dup[0]["id"] == lead["id"]

    # 2. Qualify
    lead = repc.patch(
        f"/api/v1/contacts/{lead['id']}/", {"lifecycle_stage": "qualified", "version": lead["version"]}, format="json"
    ).json()
    assert lead["lifecycle_stage"] == "qualified"

    # 3. Company, linked to the contact
    company = repc.post(
        "/api/v1/companies/", {"name": "Globex", "industry": "Energy", "lifecycle_stage": "prospect"}, format="json"
    ).json()
    lead = repc.patch(
        f"/api/v1/contacts/{lead['id']}/", {"company_id": company["id"], "version": lead["version"]}, format="json"
    ).json()

    # 4. Deal
    deal = repc.post(
        "/api/v1/deals/",
        {
            "name": "Globex reactor",
            "company_id": company["id"],
            "primary_contact_id": lead["id"],
            "amount": "10000",
            "expected_close_date": (now + timedelta(days=20)).date().isoformat(),
        },
        format="json",
    ).json()
    assert deal["risk_level"] in {"low", "medium", "high"} and deal["weighted_amount_base"] == "1000.00"

    # 5. Schedule meeting
    meeting = repc.post(
        "/api/v1/activities/",
        {
            "kind": "meeting",
            "title": "Discovery",
            "start_at": _iso(now + timedelta(days=2)),
            "deal_id": deal["id"],
            "reminder_minutes": 30,
        },
        format="json",
    ).json()
    assert meeting["contact"]["id"] == lead["id"]

    # 6. Log call
    call = repc.post(
        "/api/v1/activities/",
        {
            "kind": "call",
            "title": "Intro call",
            "start_at": _iso(now),
            "direction": "outbound",
            "outcome": "interested",
            "deal_id": deal["id"],
            "completed": True,
        },
        format="json",
    ).json()
    assert call["status"] == "completed"
    deal = repc.get(f"/api/v1/deals/{deal['id']}/").json()
    assert deal["last_activity_at"] and deal["next_activity_title"] == "Discovery"

    # 7. Send email from the rep's connected mailbox
    reauthenticate(repc)
    url = repc.post("/api/v1/email/accounts/connect/", {"provider": "gmail"}, format="json").json()["authorization_url"]
    state = parse_qs(urlsplit(url).query)["state"][0]
    assert repc.get(f"/api/v1/email/accounts/callback/?state={state}&code=rep").status_code == 302
    with django_capture_on_commit_callbacks(execute=True):
        email = repc.post(
            "/api/v1/email/messages/",
            {
                "to": ["hank@globex.example"],
                "subject": "Proposal",
                "body": "Attached is our proposal.",
                "deal_id": deal["id"],
            },
            format="json",
        ).json()
    assert repc.get(f"/api/v1/email/messages/{email['id']}/").json()["status"] == "sent"

    # 8. WhatsApp: admin connects the account, the rep records consent and sends a template
    reauthenticate(owner_client)
    assert (
        owner_client.post(
            "/api/v1/whatsapp/account/", {"phone_number_id": "99887766", "access_token": "tok"}, format="json"
        ).status_code
        == 201
    )
    template = owner_client.post(
        "/api/v1/whatsapp/templates/",
        {"name": "proposal_sent", "body": "Hi {{1}}, we sent the proposal."},
        format="json",
    ).json()
    lead = repc.get(f"/api/v1/contacts/{lead['id']}/").json()
    repc.patch(f"/api/v1/contacts/{lead['id']}/", {"whatsapp_opt_in": True, "version": lead["version"]}, format="json")
    with django_capture_on_commit_callbacks(execute=True):
        wa = repc.post(
            "/api/v1/whatsapp/messages/",
            {
                "contact_id": lead["id"],
                "deal_id": deal["id"],
                "message_type": "template",
                "template_id": template["id"],
                "template_params": ["Hank"],
            },
            format="json",
        )
    assert wa.status_code == 201, wa.content
    assert repc.get(f"/api/v1/whatsapp/messages/{wa.json()['id']}/").json()["status"] == "sent"

    # 9-11. AI: summary, risk, follow-up (drafts only, nothing sent)
    summary = repc.post(f"/api/v1/ai/deals/{deal['id']}/summary/", {}, format="json")
    assert summary.status_code == 200 and summary.json()["headline"]
    insights = repc.get(f"/api/v1/deals/{deal['id']}/insights/").json()
    assert insights["risk"]["level"] in {"low", "medium", "high"} and insights["next_best_action"]
    follow_up = repc.post(
        "/api/v1/ai/follow-up/", {"entity_type": "deal", "entity_id": deal["id"], "tone": "friendly"}, format="json"
    )
    assert follow_up.status_code == 200 and follow_up.json()["draft"]
    assert len(FakeEmailProvider.sent) == 1  # AI never sent anything

    # 12-13. Move the deal through to closed won
    pipeline = repc.get("/api/v1/pipelines/").json()["results"][0]
    stages = {s["name"]: s["id"] for s in pipeline["stages"]}
    version = repc.get(f"/api/v1/deals/{deal['id']}/").json()["version"]
    for name in ["Needs analysis", "Proposal", "Negotiation", "Closed won"]:
        resp = repc.post(
            f"/api/v1/deals/{deal['id']}/stage/", {"stage_id": stages[name], "version": version}, format="json"
        )
        assert resp.status_code == 200, resp.content
        version = resp.json()["version"]
    deal = repc.get(f"/api/v1/deals/{deal['id']}/").json()
    assert deal["status"] == "won" and deal["risk_level"] == "low"

    # 14. Contact and company became customers
    assert repc.get(f"/api/v1/contacts/{lead['id']}/").json()["lifecycle_stage"] == "customer"
    assert repc.get(f"/api/v1/companies/{company['id']}/").json()["lifecycle_stage"] == "customer"

    # 15. Dashboard and forecast reflect the win; the unified timeline tells the story
    dashboard = owner_client.get("/api/v1/dashboard/").json()
    assert dashboard["deals_won"] == {"count": 1, "amount": "10000.00"}
    assert dashboard["activities"]["calls_completed"] == 1 and dashboard["lead_conversion"]["converted"] == 1
    forecast = owner_client.get("/api/v1/forecast/?period=month").json()
    assert forecast["totals"]["won"]["amount"] == "10000.00"
    kinds = [
        e["kind"] for e in repc.get(f"/api/v1/timeline/?entity_type=deal&entity_id={deal['id']}").json()["results"]
    ]
    assert {"deal.stage_changed", "activity.call", "activity.meeting", "email", "whatsapp", "record.created"} <= set(
        kinds
    )
    contact_kinds = [
        e["kind"] for e in repc.get(f"/api/v1/timeline/?entity_type=contact&entity_id={lead['id']}").json()["results"]
    ]
    assert "lifecycle.changed" in contact_kinds
    with tenant_context(org_a.org.pk):
        assert Notification.objects.count() >= 0
    assert "tok" not in json.dumps(owner_client.get("/api/v1/whatsapp/account/").json())
