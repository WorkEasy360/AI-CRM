"""Ask Keel: one question in, one grounded answer out.

    authenticate -> tenant context -> RBAC
        -> intent (deterministic)
        -> structured CRM facts (SQL, exact)   +   knowledge retrieval (pgvector + full text)
        -> context builder (permitted, delimited, capped)
        -> provider router (primary -> cheaper -> none)
        -> typed answer + citations

Two properties hold in every mode:

**The model never authors a fact.** ``facts`` is built by ``crm_tools`` from authorized SQL and is
handed to the model as evidence, not requested from it. The model writes ``analysis`` and
``recommendation`` -- inference and advice, labelled as such in the response and in the UI -- and the
answer is assembled server-side. A model that invents a pipeline total therefore cannot show one.

**Losing the model loses the prose, not the answer.** If every provider is down, the budget is spent
or AI is switched off for the workspace, the same facts, sections and citations are rendered by
``fallback`` instead. The user sees one assistant, not a working one and a broken one.
"""

from __future__ import annotations

import re
import time
import uuid
from typing import Any

import structlog
from django.conf import settings

from apps.ai import budgets
from apps.ai.providers.base import LLMError, LLMRequest
from apps.ai.providers.router import AllProvidersUnavailableError
from apps.ai.providers.router import complete as route_complete
from apps.assistant import crm_tools, fallback, memory, prompts
from apps.assistant import intent as intent_module
from apps.assistant.crm_tools import ToolResult
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.observability import metrics
from apps.rag import retrieval

log = structlog.get_logger(__name__)

MAX_QUESTION_CHARS = 1000
MODE_AI = "ai"
MODE_AI_FALLBACK = "ai_fallback"
MODE_RETRIEVAL = fallback.MODE_RETRIEVAL
REASON_NO_PERMISSION = "no_ai_permission"

fallback.NOTICES[REASON_NO_PERMISSION] = (
    "Your role does not include AI answers. The information above was retrieved directly from your CRM."
)


def ask(actor: Actor, question: str, *, conversation_id: Any = None, request: Any = None) -> dict[str, Any]:
    """Answer one question. Never raises for "AI is unavailable" -- that is a supported mode."""
    check(actor, "ai.assistant.use")
    question = (question or "").strip()[:MAX_QUESTION_CHARS]
    started = time.monotonic()

    history = memory.load(actor, conversation_id)
    parsed = intent_module.classify(question)
    records = _resolve_focus(actor, parsed, history)
    tools = _run_tools(actor, parsed, records)
    chunks, retrieval_ok = _retrieve(actor, parsed, records, history)

    reason = _generative_reason(actor)
    if reason:
        payload = fallback.build(
            question=question,
            intent=parsed,
            tools=tools,
            chunks=chunks,
            reason=reason,
            degraded_retrieval=not retrieval_ok,
        )
        model_used, level = "", ""
    else:
        payload, model_used, level = _generate(
            actor, question=question, parsed=parsed, tools=tools, chunks=chunks, history=history, request=request
        )
        payload["degraded_retrieval"] = not retrieval_ok

    payload["intent"] = parsed.name
    payload["sources"] = _sources(tools, chunks, records)
    payload["suggestions"] = _suggestions(parsed, records)
    payload["question"] = question
    payload["knowledge_search_only"] = payload["mode"] == MODE_RETRIEVAL

    conversation = _persist(
        actor, question=question, parsed=parsed, payload=payload, history=history, tools=tools, model=model_used
    )
    payload["conversation_id"] = str(conversation.pk)

    elapsed_ms = int((time.monotonic() - started) * 1000)
    metrics.publish(
        [
            {"name": "AssistantRequest", "value": 1, "unit": "Count", "dimensions": {"Mode": payload["mode"]}},
            {"name": "AssistantLatency", "value": elapsed_ms, "unit": "Milliseconds"},
            {"name": "AssistantChunks", "value": len(chunks), "unit": "Count"},
        ],
        wait=False,  # a request thread: never wait on CloudWatch
    )
    audit.record(
        "ai.assistant",
        request=request,
        user=actor.user,
        metadata={
            # The question itself is not logged: it is customer-identifying free text and the audit
            # log is read by administrators. What was *done* is logged.
            "intent": parsed.name,
            "mode": payload["mode"],
            "level": level,
            "model": model_used,
            "records": len(records),
            "chunks": len(chunks),
            "latency_ms": elapsed_ms,
            "flagged_input": payload.get("flagged_input", False),
        },
    )
    return payload


# --------------------------------------------------------------------------- pipeline steps


def _resolve_focus(actor: Actor, parsed: Any, history: memory.History) -> list[tuple[str, Any]]:
    """Which records is this question about? The names in it, or what the thread was already about."""
    records = crm_tools.resolve_records(actor, parsed.entity_hints) if parsed.entity_hints else []
    if records or not history.focus_entity_id:
        return records
    # "What should I do next?" after "Tell me about ABC Corp": reuse the thread's focus, re-resolved
    # under the caller's *current* permissions rather than trusted from the stored row.
    obj = crm_tools._load(actor, history.focus_entity_type, history.focus_entity_id)
    return [(history.focus_entity_type, obj)] if obj is not None else []


# "Who has not responded?" / "who has gone quiet?" is a deterministic query, not a text search, and
# people phrase it in ways that land in several intents. It is checked before the intent table.
# No trailing : "not responded" and "no response" must both match the same alternative.
_QUIET = re.compile(r"(not respond|no response|not repl|hasn'?t repl|gone quiet|no reply|waiting on)", re.I)


def _run_tools(actor: Actor, parsed: Any, records: list[tuple[str, Any]]) -> ToolResult:
    name = parsed.name
    if not records and _QUIET.search(parsed.question):
        return crm_tools.quiet_customers(actor)
    if records and name in {
        intent_module.CUSTOMER_HISTORY,
        intent_module.CRM_LOOKUP,
        intent_module.GENERAL_CRM_QUESTION,
    }:
        entity_type, record = records[0]
        return crm_tools.entity_snapshot(actor, entity_type, record)
    if name == intent_module.DEAL_ANALYSIS:
        deal = next((obj for entity_type, obj in records if entity_type == "deal"), None)
        if deal is not None:
            return crm_tools.deal_risk_detail(actor, deal)
        if records:
            return crm_tools.entity_snapshot(actor, *records[0])
        return crm_tools.deals_needing_attention(actor)
    if name == intent_module.MY_DAY:
        return crm_tools.my_day(actor)
    if name == intent_module.FORECAST:
        return crm_tools.forecast_summary(actor)
    if name == intent_module.CRM_ANALYTICS:
        return crm_tools.pipeline_summary(actor)
    if name == intent_module.ACTIVITY_QUERY:
        return crm_tools.activity_list(actor, time_window=parsed.time_window or "today")
    if name == intent_module.CRM_LOOKUP:
        return crm_tools.deal_list(
            actor, time_window=parsed.time_window, min_amount=parsed.min_amount, won=parsed.wants_won
        )
    if records:
        return crm_tools.entity_snapshot(actor, *records[0])
    return ToolResult(answer_type="answer")


def _retrieve(
    actor: Actor, parsed: Any, records: list[tuple[str, Any]], history: memory.History
) -> tuple[list[Any], bool]:
    """Knowledge retrieval, narrowed to the record in question when there is one."""
    if not parsed.needs_retrieval and not records:
        return [], True
    entity_type, entity_id = "", None
    if records:
        entity_type, record = records[0]
        # A question about a company should still find the conversations on its deals, so only the
        # narrow entity types pin retrieval to a single record.
        if entity_type in {"contact", "deal"}:
            entity_id = record.pk
        else:
            entity_type = ""
    result = retrieval.search(actor, parsed.question, entity_type=entity_type, entity_id=entity_id)
    if not result.chunks and entity_id is not None:
        # Nothing matched inside that record: widen rather than answer "nothing found".
        result = retrieval.search(actor, parsed.question)
    return result.chunks, result.available and result.semantic


def _generative_reason(actor: Actor) -> str:
    if not actor.has("ai.copilot.use"):
        return REASON_NO_PERMISSION
    return budgets.generative_reason(actor)


def _generate(
    actor: Actor,
    *,
    question: str,
    parsed: Any,
    tools: ToolResult,
    chunks: list[Any],
    history: memory.History,
    request: Any,
) -> tuple[dict[str, Any], str, str]:
    context, flagged = prompts.build_context(
        question=question, facts=tools.facts, chunks=chunks, history=history.as_prompt()
    )
    model, max_tokens, effort = prompts.model_for(parsed, records=len(tools.focus), chunks=len(chunks))
    llm_request = LLMRequest(
        system=prompts.SYSTEM,
        user=context,
        model=model,
        max_tokens=max_tokens,
        feature="assistant",
        effort=effort,
        temperature=0.3,
        metadata={"user_id": prompts.opaque_user_id(actor)},
    )
    try:
        routed = route_complete(llm_request)
    except AllProvidersUnavailableError as exc:
        log.warning("assistant.ai_unavailable", reason=exc.message[:120])
        metrics.publish([{"name": "AssistantFallback", "value": 1, "unit": "Count"}], wait=False)
        payload = fallback.build(question=question, intent=parsed, tools=tools, chunks=chunks, reason="ai_unavailable")
        payload["flagged_input"] = flagged
        return payload, "", ""
    except LLMError as exc:
        # A refusal or a rejected request: show the evidence rather than an apology.
        log.info("assistant.ai_refused", refused=exc.refused)
        payload = fallback.build(question=question, intent=parsed, tools=tools, chunks=chunks, reason="ai_unavailable")
        payload["flagged_input"] = flagged
        return payload, "", ""

    response = routed.response
    budgets.record_usage(
        actor,
        feature="assistant",
        model=response.model,
        input_tokens=response.input_tokens,
        output_tokens=response.output_tokens,
        cache_read_tokens=response.cache_read_tokens,
        flagged=flagged,
    )
    parts = prompts.parse(response.text)
    payload = {
        "answer_type": tools.answer_type,
        "mode": MODE_AI_FALLBACK if routed.degraded else MODE_AI,
        "headline": parts["headline"] or tools.headline or "Here is what I found",
        # Facts stay server-authored: the model is given them, never asked for them.
        "facts": list(tools.facts),
        "analysis": parts["analysis"],
        "recommendation": parts["recommendation"] or tools.recommendation,
        "sections": [section.as_dict() for section in tools.sections]
        + ([fallback.excerpt_section(chunks).as_dict()] if chunks else []),
        "notice": "",
        "flagged_input": flagged,
    }
    return payload, response.model, routed.level


def _sources(tools: ToolResult, chunks: list[Any], records: list[tuple[str, Any]]) -> list[dict[str, Any]]:
    """Citations, every one of them already resolved inside the caller's scope.

    Records come from ``crm_tools`` (authorized queries) and chunks from ``rag.retrieval`` (authorized
    and then re-verified against live CRM state), so there is no path by which a citation names a
    record the caller may not open.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entity_type, record in records:
        key = f"{entity_type}:{record.pk}"
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "type": entity_type,
                "id": str(record.pk),
                "title": crm_tools._title(entity_type, record),
                "subtitle": entity_type.title(),
                "occurred_at": None,
                "href": fallback._entity_href(entity_type, record.pk),
            }
        )
    for chunk in chunks:
        key = f"{chunk.source_type}:{chunk.source_id}"
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "type": chunk.source_type,
                "id": str(chunk.source_id),
                "title": chunk.entity_name or chunk.label,
                "subtitle": chunk.label,
                "occurred_at": chunk.occurred_at.isoformat() if chunk.occurred_at else None,
                "href": fallback._entity_href(chunk.entity_type, chunk.entity_id),
            }
        )
    return out[: settings.RAG_MAX_RECORDS + settings.RAG_MAX_CHUNKS]


SUGGESTIONS_DEFAULT = (
    "Which deals need attention?",
    "What should I follow up today?",
    "Summarize my pipeline.",
    "Which deals are at risk?",
)


def _suggestions(parsed: Any, records: list[tuple[str, Any]]) -> list[str]:
    if records:
        entity_type, record = records[0]
        name = crm_tools._title(entity_type, record)
        return [
            f"What are the risks on {name}?",
            f"What did {name} say about pricing?",
            f"What should I do next with {name}?",
        ]
    if parsed.name == intent_module.MY_DAY:
        return ["Which deals are at risk?", "Who has not responded recently?", "Summarize my pipeline."]
    return list(SUGGESTIONS_DEFAULT)


def _persist(
    actor: Actor,
    *,
    question: str,
    parsed: Any,
    payload: dict[str, Any],
    history: memory.History,
    tools: ToolResult,
    model: str = "",
) -> Any:
    conversation = history.conversation or memory.start(actor, question=question)
    answer_text = "\n".join(
        part
        for part in [payload.get("headline", ""), payload.get("analysis", ""), payload.get("recommendation", "")]
        if part
    )
    focus: tuple[str, uuid.UUID] | None = tools.focus[0] if tools.focus else None
    memory.record(
        conversation,
        question=question,
        answer=answer_text,
        intent=parsed.name,
        mode=payload["mode"],
        # The model name is recorded here and in the audit log, never in the response: a
        # salesperson has no use for it and it is infrastructure detail.
        model=model,
        flagged_input=bool(payload.get("flagged_input")),
        focus=focus,
    )
    return conversation


def suggestions_for(actor: Actor) -> list[str]:
    """Dashboard quick prompts, trimmed to what this member's role can actually answer."""
    prompts_list = [
        ("Which deals need attention?", "deals.view"),
        ("What should I follow up today?", "activities.view"),
        ("Summarize my pipeline.", "deals.view"),
        ("Which deals are at risk?", "deals.view"),
        ("Show high-value deals closing this month.", "deals.view"),
        ("Who has not responded recently?", "deals.view"),
        ("What meetings do I have today?", "activities.view"),
    ]
    return [text for text, permission in prompts_list if actor.has(permission)][:5]
