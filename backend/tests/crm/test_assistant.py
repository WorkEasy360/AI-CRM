"""Ask Keel: one interface, four operating modes, and the same useful answer in each.

    AI available            -> CRM facts + retrieved evidence + written analysis
    primary model down      -> the cheaper model answers
    every model down        -> deterministic CRM + knowledge answer
    AI switched off/budget  -> the same deterministic answer, with an honest notice

These tests care about what the salesperson gets, not about which vendor was called.
"""

from __future__ import annotations

import pytest
from django.test import override_settings

from apps.ai.providers.base import LLMError
from apps.ai.providers.fake import FakeProvider
from apps.assistant import intent as intent_module
from apps.assistant.models import Conversation
from apps.core.tenancy.context import tenant_context
from tests.crm.test_rag_indexing import index_all

pytestmark = pytest.mark.django_db

ASK = "/api/v1/assistant/ask/"


@pytest.fixture(autouse=True)
def _fake_provider():
    FakeProvider.reset()
    yield
    FakeProvider.reset()


@pytest.fixture
def abc(org_a, crm):
    """A company with an open deal, a meeting, an email, a call and a WhatsApp message."""
    import datetime as dt

    from django.utils import timezone

    now = timezone.now()
    company = crm.make_company(org_a, name="ABC Corp")
    contact = crm.make_contact(org_a, first_name="Dana", last_name="Reyes", company=company)
    deal = crm.make_deal(
        org_a,
        name="Enterprise Expansion",
        company=company,
        contact=contact,
        amount="850000.00",
        amount_base="850000.00",
    )
    with tenant_context(org_a.org.pk, reason="test.abc"):
        from apps.deals.models import Deal

        Deal.objects.filter(pk=deal.pk).update(
            last_activity_at=now - dt.timedelta(days=9),
            stage_entered_at=now - dt.timedelta(days=21),
            expected_close_date=(now + dt.timedelta(days=20)).date(),
        )
    crm.make_activity(
        org_a,
        kind="meeting",
        deal=deal,
        contact=contact,
        title="Pricing review",
        description="Customer requested revised pricing and pushed back on the licence tier.",
    )
    crm.make_email_message(
        org_a, contact=contact, deal=deal, subject="Proposal", body_text="Attached is the proposal we discussed."
    )
    crm.make_whatsapp_message(org_a, contact=contact, body="What does the implementation timeline look like?")
    crm.make_note(org_a, record=deal, body="Decision maker is on leave until the end of the month.")
    index_all(org_a.org)
    with tenant_context(org_a.org.pk, reason="test.abc"):
        return {"company": company, "contact": contact, "deal": Deal.objects.get(pk=deal.pk)}


def ask(client, question, conversation_id=None):
    body = {"question": question}
    if conversation_id:
        body["conversation_id"] = conversation_id
    response = client.post(ASK, body, format="json")
    assert response.status_code == 200, response.content
    return response.json()


# --------------------------------------------------------------------------- AI available


def test_a_customer_question_combines_crm_facts_retrieval_and_analysis(owner_client, abc):
    answer = ask(owner_client, "What happened with ABC Corp?")

    assert answer["mode"] == "ai"
    assert answer["intent"] == intent_module.CUSTOMER_HISTORY
    # Facts come from SQL and name the real deal and its real value.
    facts = " ".join(answer["facts"])
    assert "Enterprise Expansion" in facts and "850000" in facts
    # Analysis is the model's inference, kept separate from the facts.
    assert answer["analysis"] and answer["analysis"] not in answer["facts"]
    assert answer["recommendation"]
    assert answer["notice"] == ""
    # Evidence is cited, and every citation points at a record the caller may open.
    kinds = {source["type"] for source in answer["sources"]}
    assert {"company"} <= kinds
    assert all(source["href"] for source in answer["sources"] if source["type"] != "activity")
    assert any(section["kind"] == "events" for section in answer["sections"])


def test_the_model_is_given_facts_and_evidence_but_never_asked_for_numbers(owner_client, abc):
    ask(owner_client, "What happened with ABC Corp?")
    sent = FakeProvider.calls[-1]
    assert "<crm_facts>" in sent.user and "Enterprise Expansion" in sent.user
    assert "<crm_evidence>" in sent.user and "revised pricing" in sent.user
    assert "<question>" in sent.user


def test_facts_are_server_authored_even_when_the_model_invents_numbers(owner_client, abc):
    FakeProvider.next_text = (
        '{"headline": "Pipeline is 99 crore", "analysis": "Everything is fine.", "recommendation": "Relax."}'
    )
    answer = ask(owner_client, "What happened with ABC Corp?")
    assert "99 crore" not in " ".join(answer["facts"])
    assert "850000" in " ".join(answer["facts"])


# --------------------------------------------------------------------------- structured questions


def test_a_pipeline_question_is_answered_by_sql_not_by_retrieval(owner_client, abc):
    answer = ask(owner_client, "How much pipeline do I have?")
    assert answer["intent"] == intent_module.CRM_ANALYTICS
    metrics = [s for s in answer["sections"] if s["kind"] == "metrics"]
    assert metrics and any(item["label"] == "Open pipeline" for item in metrics[0]["items"])
    assert "850000" in " ".join(answer["facts"])


def test_a_deal_list_question_with_no_matching_deals_answers(owner_client):
    # A new organization has no deals: the total of an empty match must still be a money amount.
    answer = ask(owner_client, "Which deals close this week?")
    assert any("0.00" in fact for fact in answer["facts"])


def test_deal_risk_uses_the_rules_engine(owner_client, abc):
    answer = ask(owner_client, "Which deals are at risk?")
    assert answer["intent"] == intent_module.DEAL_ANALYSIS
    assert answer["answer_type"] == "deal_risk"
    facts = " ".join(answer["facts"])
    assert "risk" in facts.lower()
    assert "Enterprise Expansion" in facts


def test_my_day_only_shows_the_callers_own_work(owner_client, org_a, crm, make_member, client_for):
    import datetime as dt

    from django.utils import timezone

    colleague = make_member(org_a, "sales_rep")
    crm.make_activity(
        org_a, kind="task", owner=colleague, title="Colleague task", start_at=timezone.now() - dt.timedelta(days=1)
    )
    crm.make_activity(
        org_a,
        kind="task",
        owner=org_a.owner_membership,
        title="My overdue task",
        start_at=timezone.now() - dt.timedelta(days=2),
    )
    answer = ask(owner_client, "What should I do today?")
    assert answer["intent"] == intent_module.MY_DAY
    titles = [item["title"] for section in answer["sections"] for item in section["items"]]
    assert "My overdue task" in titles
    assert "Colleague task" not in titles


def test_forecast_question_returns_forecast_months(owner_client, abc):
    answer = ask(owner_client, "What is my forecast?")
    assert answer["intent"] == intent_module.FORECAST
    assert answer["sections"] and answer["sections"][0]["kind"] == "metrics"


# --------------------------------------------------------------------------- provider fallback


def test_the_cheaper_model_answers_when_the_primary_one_fails(owner_client, abc):
    FakeProvider.fail_next = LLMError("primary is down", retryable=True, status=503)
    answer = ask(owner_client, "What happened with ABC Corp?")

    assert answer["mode"] == "ai_fallback"
    assert answer["analysis"], "the user still gets a written answer"
    assert answer["notice"] == ""
    assert len(FakeProvider.calls) == 2
    assert FakeProvider.calls[0].model != FakeProvider.calls[1].model


@override_settings(AI_BREAKER_FAILURES=0)
def test_every_model_down_still_answers_from_the_crm(owner_client, abc):
    FakeProvider.fail_always = LLMError("provider outage", retryable=True, status=503)
    answer = ask(owner_client, "What happened with ABC Corp?")

    assert answer["mode"] == "retrieval"
    assert answer["knowledge_search_only"] is True
    assert "temporarily unavailable" in answer["notice"]
    # This is the whole point: the answer is still worth reading.
    facts = " ".join(answer["facts"])
    assert "Enterprise Expansion" in facts and "850000" in facts
    assert answer["analysis"] == ""
    excerpts = [s for s in answer["sections"] if s["title"] == "From your conversations"]
    assert excerpts and any("revised pricing" in item["snippet"] for item in excerpts[0]["items"])
    assert answer["sources"]


@override_settings(AI_BREAKER_FAILURES=0)
def test_a_refusal_is_not_retried_on_another_model(owner_client, abc):
    FakeProvider.fail_always = LLMError("declined", refused=True)
    answer = ask(owner_client, "What happened with ABC Corp?")
    assert answer["mode"] == "retrieval"
    # Refusals are a decision, not an outage: exactly one call, no fallback attempt.
    assert len(FakeProvider.calls) == 1


def test_the_circuit_breaker_stops_hammering_a_dead_provider(owner_client, abc):
    """After enough consecutive failures the router stops calling the provider at all, so an outage
    costs one slow request rather than one per user."""
    from apps.ai.providers import router

    FakeProvider.fail_always = LLMError("outage", retryable=True, status=503)
    with override_settings(AI_BREAKER_FAILURES=2, AI_BREAKER_COOLDOWN_SECONDS=60):
        ask(owner_client, "What happened with ABC Corp?")  # 1st failure for each level
        ask(owner_client, "What happened with ABC Corp?")  # 2nd failure: both breakers trip
        assert router._breaker_open(FakeProvider.calls[0].model)

        FakeProvider.calls = []
        answer = ask(owner_client, "What happened with ABC Corp?")
        assert FakeProvider.calls == [], "an open breaker must skip the provider entirely"
        assert answer["mode"] == "retrieval"
        assert "Enterprise Expansion" in " ".join(answer["facts"])


# --------------------------------------------------------------------------- request-thread protection


def test_every_provider_call_carries_the_remaining_deadline(owner_client, abc):
    with override_settings(AI_INTERACTIVE_DEADLINE_SECONDS=30, AI_REQUEST_TIMEOUT_SECONDS=45):
        answer = ask(owner_client, "What happened with ABC Corp?")
    assert answer["mode"] == "ai"
    timeout = FakeProvider.calls[0].timeout
    assert timeout is not None and 0 < timeout <= 30, "a call may never outlive the request deadline"


@override_settings(AI_BREAKER_FAILURES=0, AI_INTERACTIVE_DEADLINE_SECONDS=6, AI_MIN_ATTEMPT_SECONDS=5)
def test_no_fallback_attempt_is_started_once_the_deadline_is_nearly_spent(owner_client, abc, monkeypatch):
    """The primary model burning the deadline must not be followed by a second full wait."""
    import time as real_time
    from types import SimpleNamespace

    from apps.ai.providers import router

    clock = iter([100.0, 100.0, 102.0])  # deadline set, primary starts, fallback check (4 s left < 5 s)
    monkeypatch.setattr(router, "time", SimpleNamespace(monotonic=lambda: next(clock, 102.0), time=real_time.time))
    FakeProvider.fail_always = LLMError("timed out", retryable=True, status=503)

    answer = ask(owner_client, "What happened with ABC Corp?")

    assert len(FakeProvider.calls) == 1, "the fallback level must be skipped, not attempted"
    assert answer["mode"] == "retrieval"
    assert "Enterprise Expansion" in " ".join(answer["facts"])


@override_settings(AI_MAX_CONCURRENT_CALLS_PER_PROCESS=1)
def test_a_saturated_ai_bulkhead_answers_from_the_crm_without_waiting(owner_client, abc):
    """When slow provider calls hold every slot, the next question degrades at once instead of taking
    another request thread from the rest of the CRM."""
    from apps.ai.providers import router

    slots = router._call_slots()
    assert slots is not None and slots.acquire(blocking=False)  # a slow call in flight elsewhere
    try:
        answer = ask(owner_client, "What happened with ABC Corp?")
    finally:
        slots.release()

    assert FakeProvider.calls == [], "no provider call may start while the bulkhead is full"
    assert answer["mode"] == "retrieval"
    assert "Enterprise Expansion" in " ".join(answer["facts"])
    # The slot is free again: the next question is answered by the model.
    assert ask(owner_client, "What happened with ABC Corp?")["mode"] == "ai"


def test_a_failing_retrieval_query_degrades_instead_of_failing_the_request(owner_client, abc, monkeypatch):
    """A statement error inside the request transaction aborts it; retrieval must contain the failure so
    the answer, the conversation and the audit row are still written."""
    from apps.rag import retrieval

    real_fields = retrieval._fields
    monkeypatch.setattr(retrieval, "_fields", lambda qs: real_fields(qs.extra(where=["1 / (random() * 0)::int = 1"])))
    resp = owner_client.post(ASK, {"question": "What happened with ABC Corp?"}, format="json")
    assert resp.status_code == 200, resp.content
    answer = resp.json()
    assert answer["degraded_retrieval"] is True
    assert "Enterprise Expansion" in " ".join(answer["facts"])
    assert answer["conversation_id"]


def test_drafting_features_respect_the_circuit_breaker(owner_client, org_a, crm):
    """Deal summary / follow-up / email drafts go through the router: an open breaker answers 503 at once
    instead of every salesperson waiting out the provider timeout."""
    contact = crm.make_contact(org_a)
    FakeProvider.fail_always = LLMError("outage", retryable=True, status=503)
    with override_settings(AI_BREAKER_FAILURES=1, AI_BREAKER_COOLDOWN_SECONDS=60):
        first = owner_client.post(
            "/api/v1/ai/follow-up/", {"entity_type": "contact", "entity_id": str(contact.pk)}, format="json"
        )
        assert first.status_code == 503 and first.json()["type"] == "ai_unavailable"
        FakeProvider.calls = []
        second = owner_client.post(
            "/api/v1/ai/follow-up/", {"entity_type": "contact", "entity_id": str(contact.pk)}, format="json"
        )
    assert second.status_code == 503
    assert FakeProvider.calls == [], "an open breaker must skip the provider for drafting features too"


def test_anthropic_calls_with_a_deadline_make_a_single_attempt(settings, monkeypatch):
    """SDK retries would multiply the per-call timeout; with a router deadline there is exactly one try."""
    from apps.ai.providers import anthropic_provider
    from apps.ai.providers.base import LLMRequest

    settings.ANTHROPIC_API_KEY = "sk-test"  # never sent: the client is replaced below
    provider = anthropic_provider.AnthropicProvider()
    seen: dict = {}

    class _Messages:
        def create(self, **kwargs):
            raise anthropic_provider.anthropic.APIConnectionError(request=None)

    class _Client:
        messages = _Messages()

        def with_options(self, **options):
            seen.update(options)
            return self

    monkeypatch.setattr(provider, "_client", _Client())
    request = LLMRequest(system="s", user="u", model="claude-haiku-4-5", max_tokens=10, feature="t", timeout=12.5)
    with pytest.raises(LLMError) as err:
        provider.complete(request)
    assert err.value.retryable
    assert seen == {"timeout": 12.5, "max_retries": 0}


# --------------------------------------------------------------------------- AI off / out of budget


def test_ai_switched_off_answers_from_the_crm_and_calls_nobody(owner_client, org_a, abc):
    from apps.ai import orgsettings

    with tenant_context(org_a.org.pk, reason="test"):
        org_a.org.settings = {**(org_a.org.settings or {}), orgsettings.AI_ENABLED_KEY: False}
        org_a.org.save(update_fields=["settings", "updated_at"])

    answer = ask(owner_client, "What happened with ABC Corp?")
    assert answer["mode"] == "retrieval"
    assert "switched off" in answer["notice"]
    assert FakeProvider.calls == []
    assert "Enterprise Expansion" in " ".join(answer["facts"])


def test_an_exhausted_monthly_budget_degrades_instead_of_failing(owner_client, org_a, abc):
    from apps.ai import orgsettings

    with tenant_context(org_a.org.pk, reason="test"):
        org_a.org.settings = {**(org_a.org.settings or {}), orgsettings.BUDGET_KEY: "0.01"}
        org_a.org.save(update_fields=["settings", "updated_at"])
        from django.utils import timezone

        from apps.ai.models import AIUsage

        AIUsage.objects.create(
            membership=org_a.owner_membership,
            day=timezone.now().date(),
            feature="assistant",
            model="fake",
            requests=1,
            estimated_cost_usd="5.00",
        )

    answer = ask(owner_client, "What happened with ABC Corp?")
    assert answer["mode"] == "retrieval"
    assert "budget for the month" in answer["notice"]
    assert FakeProvider.calls == []


def test_a_role_without_copilot_still_gets_a_useful_answer(org_a, crm, make_member, client_for, abc):
    viewer = make_member(org_a, "viewer")
    client = client_for(viewer.user, viewer)
    answer = ask(client, "What happened with ABC Corp?")
    assert answer["mode"] == "retrieval"
    assert "does not include AI answers" in answer["notice"]
    assert answer["facts"]
    assert FakeProvider.calls == []


# --------------------------------------------------------------------------- conversation


def test_a_follow_up_question_keeps_the_subject(owner_client, abc):
    first = ask(owner_client, "Tell me about ABC Corp")
    assert first["conversation_id"]
    second = ask(owner_client, "What should I do next?", conversation_id=first["conversation_id"])
    assert second["conversation_id"] == first["conversation_id"]
    # The follow-up resolved "next" against ABC Corp without the name being repeated.
    assert any(
        "ABC Corp" in source["title"] or "Enterprise Expansion" in source["title"] for source in second["sources"]
    )


def test_history_sent_to_the_model_is_bounded(owner_client, abc):
    conversation_id = None
    for i in range(8):
        answer = ask(owner_client, f"Question number {i} about ABC Corp", conversation_id=conversation_id)
        conversation_id = answer["conversation_id"]
    from django.conf import settings

    sent = FakeProvider.calls[-1].user
    assert sent.count("Earlier question:") <= settings.ASSISTANT_HISTORY_TURNS
    assert len(sent) <= settings.AI_MAX_PROMPT_CHARS + 100


def test_a_conversation_belongs_to_one_member_only(org_a, owner_client, make_member, client_for, abc):
    mine = ask(owner_client, "Tell me about ABC Corp")["conversation_id"]
    colleague = make_member(org_a, "sales_manager")
    other_client = client_for(colleague.user, colleague)

    # Reading it back returns nothing rather than someone else's thread.
    response = other_client.get(f"/api/v1/assistant/conversations/{mine}/")
    assert response.status_code == 200 and response.json()["id"] is None

    # Continuing it starts a fresh thread instead of appending to mine.
    theirs = ask(other_client, "What should I do next?", conversation_id=mine)
    assert theirs["conversation_id"] != mine


def test_a_conversation_is_not_visible_across_organizations(org_a, org_b, owner_client, client_for, abc):
    mine = ask(owner_client, "Tell me about ABC Corp")["conversation_id"]
    other = client_for(org_b.owner, org_b.owner_membership)
    assert other.get(f"/api/v1/assistant/conversations/{mine}/").json()["id"] is None
    with tenant_context(org_b.org.pk, reason="test"):
        assert Conversation.objects.count() == 0


def test_deleting_a_conversation_removes_it(owner_client, abc):
    conversation_id = ask(owner_client, "Tell me about ABC Corp")["conversation_id"]
    assert owner_client.delete(f"/api/v1/assistant/conversations/{conversation_id}/").status_code == 204
    assert owner_client.get(f"/api/v1/assistant/conversations/{conversation_id}/").json()["id"] is None


# --------------------------------------------------------------------------- surface


def test_the_dashboard_card_offers_prompts_the_role_can_answer(owner_client, org_a, make_member, client_for):
    home = owner_client.get("/api/v1/assistant/home/")
    assert home.status_code == 200
    body = home.json()
    assert body["suggestions"] and body["generative_available"] is True

    viewer = make_member(org_a, "viewer")
    viewer_body = client_for(viewer.user, viewer).get("/api/v1/assistant/home/").json()
    assert viewer_body["generative_available"] is False
    assert viewer_body["suggestions"]


def test_asking_requires_authentication(anon_client):
    assert anon_client.post(ASK, {"question": "hello"}, format="json").status_code in {401, 403}


def test_an_empty_question_is_rejected(owner_client):
    assert owner_client.post(ASK, {"question": "   "}, format="json").status_code == 400


def test_usage_is_metered_and_audited(owner_client, org_a, abc):
    ask(owner_client, "What happened with ABC Corp?")
    usage = owner_client.get("/api/v1/ai/usage/").json()
    assert any(row["feature"] == "assistant" for row in usage["by_feature"])
    with tenant_context(org_a.org.pk, reason="test"):
        from apps.audit.models import AuditEvent

        event = AuditEvent.objects.filter(action="ai.assistant").order_by("-created_at").first()
        assert event is not None
        assert event.metadata["mode"] == "ai" and event.metadata["intent"] == intent_module.CUSTOMER_HISTORY
        # The question itself is customer-identifying free text and must not be in the audit log.
        assert "ABC" not in str(event.metadata)


def test_who_has_not_responded_is_a_deterministic_query(owner_client, org_a, crm):
    """One of the dashboard's own quick prompts; it must not depend on a text search finding it."""
    import datetime as dt

    from django.utils import timezone

    deal = crm.make_deal(org_a, name="Quiet deal")
    with tenant_context(org_a.org.pk, reason="test"):
        from apps.deals.models import Deal

        Deal.objects.filter(pk=deal.pk).update(last_activity_at=timezone.now() - dt.timedelta(days=20))

    answer = ask(owner_client, "Who has not responded recently?")
    titles = [item["title"] for section in answer["sections"] for item in section["items"]]
    assert "Quiet deal" in titles
    assert "20 days" in " ".join(answer["facts"])


def test_the_response_never_names_the_model_but_the_turn_records_it(owner_client, org_a, abc):
    answer = ask(owner_client, "What happened with ABC Corp?")
    assert "model" not in answer and "provider" not in answer
    assert "claude" not in str(answer).lower()
    with tenant_context(org_a.org.pk, reason="test"):
        from apps.assistant.models import ConversationTurn

        turn = ConversationTurn.objects.order_by("-created_at").first()
        assert turn is not None and turn.model.startswith("claude")
