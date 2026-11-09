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

import contextlib
import re
import time
import uuid
from collections.abc import Iterator
from typing import Any

import structlog
from django.conf import settings

from apps.ai import budgets
from apps.ai.providers.base import LLMError, LLMRequest
from apps.ai.providers.router import AllProvidersUnavailableError
from apps.ai.providers.router import complete as route_complete
from apps.assistant import actions, crm_tools, fallback, memory, prompts
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


@contextlib.contextmanager
def _phase(timings: dict[str, int], name: str) -> Iterator[None]:
    """Time one stage of the answer into ``timings``.

    The stages are measured separately because they behave completely differently: the structured and
    knowledge lookups are our own database work (bounded, cacheable, and what a timeout should protect),
    while the model call is someone else's network service and dominates the total. Deciding between a
    synchronous response, streaming and an async job without that split is guesswork -- see
    docs/architecture/ai-architecture.md.
    """
    started = time.monotonic()
    try:
        yield
    finally:
        timings[name] = int((time.monotonic() - started) * 1000)


def ask(
    actor: Actor, question: str, *, conversation_id: Any = None, page: str = "", request: Any = None
) -> dict[str, Any]:
    """Answer one question. Never raises for "AI is unavailable" -- that is a supported mode.

    ``page`` is the route the user is looking at. It only steers *which help article* answers a
    question like "how do I add one here?"; it grants nothing and is never used for authorization.
    """
    check(actor, "ai.assistant.use")
    question = (question or "").strip()[:MAX_QUESTION_CHARS]
    page = _clean_page(page)
    started = time.monotonic()
    timings: dict[str, int] = {}

    with _phase(timings, "memory_ms"):
        history = memory.load(actor, conversation_id)
    parsed = intent_module.classify(question)

    routed = _route_special(actor, parsed, question=question, page=page, history=history, timings=timings)
    if routed is not None:
        payload, model_used, level, records = routed
        chunks: list[Any] = []
        tools = ToolResult(answer_type=payload["answer_type"])
    else:
        with _phase(timings, "structured_ms"):
            records = _resolve_focus(actor, parsed, history)
            tools = _run_tools(actor, parsed, records)
        with _phase(timings, "rag_ms"):
            chunks, retrieval_ok = _retrieve(actor, parsed, records, history)

        reason = _generative_reason(actor)
        if reason:
            timings["provider_ms"] = 0
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
            with _phase(timings, "provider_ms"):
                payload, model_used, level = _generate(
                    actor,
                    question=question,
                    parsed=parsed,
                    tools=tools,
                    chunks=chunks,
                    history=history,
                    request=request,
                )
            payload["degraded_retrieval"] = not retrieval_ok
        payload["sources"] = _sources(tools, chunks, records)
        payload["suggestions"] = _suggestions(parsed, records)

    payload["intent"] = parsed.name
    payload.setdefault("sources", [])
    payload.setdefault("suggestions", [])
    payload["question"] = question
    payload["knowledge_search_only"] = payload["mode"] == MODE_RETRIEVAL

    help_payload = payload.get("help") or {}
    help_slug = (help_payload.get("article") or {}).get("id", "") if help_payload else ""
    conversation, turn = _persist(
        actor,
        question=question,
        parsed=parsed,
        payload=payload,
        history=history,
        tools=tools,
        model=model_used,
        help_article=help_slug,
    )
    payload["conversation_id"] = str(conversation.pk)
    payload["turn_id"] = str(turn.pk)

    elapsed_ms = int((time.monotonic() - started) * 1000)
    timings["total_ms"] = elapsed_ms
    metrics.publish(
        [
            {"name": "AssistantRequest", "value": 1, "unit": "Count", "dimensions": {"Mode": payload["mode"]}},
            {"name": "AssistantLatency", "value": elapsed_ms, "unit": "Milliseconds"},
            {"name": "AssistantChunks", "value": len(chunks), "unit": "Count"},
            # Per-phase, so "Ask Keel is slow" can be answered with which part.
            {
                "name": "AssistantPhaseLatency",
                "value": timings.get("structured_ms", 0),
                "unit": "Milliseconds",
                "dimensions": {"Phase": "structured"},
            },
            {
                "name": "AssistantPhaseLatency",
                "value": timings.get("rag_ms", 0),
                "unit": "Milliseconds",
                "dimensions": {"Phase": "rag"},
            },
            {
                "name": "AssistantPhaseLatency",
                "value": timings.get("provider_ms", 0),
                "unit": "Milliseconds",
                "dimensions": {"Phase": "provider"},
            },
        ],
        wait=False,  # a request thread: never wait on CloudWatch
    )
    payload["timings_ms"] = timings
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
            "help_article": help_slug,
            "latency_ms": elapsed_ms,
            "structured_ms": timings.get("structured_ms"),
            "rag_ms": timings.get("rag_ms"),
            "provider_ms": timings.get("provider_ms"),
            "flagged_input": payload.get("flagged_input", False),
        },
    )
    return payload


# --------------------------------------------------------------------------- help, actions, scope

_PAGE = re.compile(r"^/[A-Za-z0-9/_\-]{0,199}$")
# A general question this close to a help article is a help question even without "how do I".
HELP_TAKEOVER_COVERAGE = 0.75


def _clean_page(page: Any) -> str:
    text = str(page or "").split("?", 1)[0].split("#", 1)[0].strip()
    return text if _PAGE.match(text) else ""


def _route_special(
    actor: Actor, parsed: Any, *, question: str, page: str, history: memory.History, timings: dict[str, int]
) -> tuple[dict[str, Any], str, str, list[tuple[str, Any]]] | None:
    """Help, action and out-of-scope answers. ``None`` hands the question to the CRM data path."""
    from apps.helpkb import search as help_search

    name = parsed.name
    if name == intent_module.OUT_OF_SCOPE:
        return _out_of_scope(actor, page), "", "", []
    if name == intent_module.ACTION_REQUEST:
        with _phase(timings, "structured_ms"):
            records = crm_tools.resolve_records(actor, parsed.entity_hints) if parsed.entity_hints else []
        return actions.propose(actor, parsed, records), "", "", records
    if name not in {intent_module.HOW_TO, intent_module.GENERAL_CRM_QUESTION}:
        return None
    with _phase(timings, "help_ms"):
        result = help_search.search(actor, question, page=page)
    if name == intent_module.GENERAL_CRM_QUESTION:
        best = result.best
        if not (result.confident and best and best.coverage >= HELP_TAKEOVER_COVERAGE and not parsed.entity_hints):
            return None
    with _phase(timings, "provider_ms"):
        return (*_help_answer(actor, question, result, page=page), [])


def _help_answer(actor: Actor, question: str, result: Any, *, page: str) -> tuple[dict[str, Any], str, str]:
    from apps.helpkb import answer as help_answer
    from apps.helpkb import search as help_search

    if result.confident:
        reason = _generative_reason(actor)
        body, model_used, level, flagged = help_answer.build(actor, question, result, page=page, reason=reason)
    else:
        suggestions = [
            {"id": m.slug, "title": m.article.title, "question": m.article.question} for m in result.matches[:3]
        ] or [
            {"id": s["id"], "title": "", "question": s["question"]}
            for s in help_search.suggestions_for_page(actor, page)
        ]
        body = help_answer.not_found_payload(question, page=page, suggestions=suggestions)
        model_used, level, flagged, reason = "", "", False, ""
    if not model_used or model_used == help_answer.KB_MODEL:
        # Answered from the guide alone: no tokens, but still counted under Usage & Limits.
        budgets.record_usage(actor, feature="help", model=help_answer.KB_MODEL, input_tokens=0, output_tokens=0)
    article = body.get("article") or {}
    payload = {
        "answer_type": "help",
        "mode": MODE_AI if body.get("text") else MODE_RETRIEVAL,
        "headline": body.get("summary") or "",
        "facts": [],
        "analysis": "",
        "recommendation": "",
        "sections": [],
        "notice": help_answer.notice_for(body, reason),
        "flagged_input": flagged,
        "help": body,
        "suggestions": [item["question"] for item in body.get("related", []) if item.get("question")][:3],
        "sources": (
            [
                {
                    "type": "help",
                    "id": article["id"],
                    "title": article["title"],
                    "subtitle": article["module"],
                    "occurred_at": None,
                    "href": f"/help/{article['id']}",
                }
            ]
            if article
            else []
        ),
    }
    return payload, model_used, level


def _out_of_scope(actor: Actor, page: str) -> dict[str, Any]:
    return {
        "answer_type": "out_of_scope",
        "mode": MODE_RETRIEVAL,
        "headline": "I can only help with WorkEasyCRM.",
        "facts": [],
        "analysis": "Ask me how to use a feature, or about your own customers, deals and activities.",
        "recommendation": "",
        "sections": [],
        "notice": "",
        "flagged_input": False,
        "suggestions": suggestions_for(actor)[:3],
    }


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
    help_article: str = "",
) -> tuple[Any, Any]:
    conversation = history.conversation or memory.start(actor, question=question)
    answer_text = "\n".join(
        part
        for part in [payload.get("headline", ""), payload.get("analysis", ""), payload.get("recommendation", "")]
        if part
    )
    focus: tuple[str, uuid.UUID] | None = tools.focus[0] if tools.focus else None
    turn = memory.record(
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
        help_article=help_article,
        action=actions.for_storage(payload["action"]) if payload.get("answer_type") == "action" else None,
    )
    return conversation, turn


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
