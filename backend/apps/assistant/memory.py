"""Bounded, isolated conversation memory.

Two rules:

1. **Bounded.** At most ``ASSISTANT_HISTORY_TURNS`` turns, truncated to
   ``ASSISTANT_HISTORY_CHARS`` in total, ever reach a prompt. An assistant that quietly grows its
   context window grows its bill and its latency with every question, and eventually starts
   answering from a transcript instead of from the CRM.
2. **Isolated.** A conversation belongs to one membership in one organization. Loading one is a
   tenant-scoped query filtered by the caller's own membership, so there is no thread id a user can
   guess their way into -- an unknown or foreign id simply starts a new conversation.

The stored history is the *question and answer text*, never the retrieved CRM context. Evidence is
re-retrieved for every question under the caller's current permissions, so a conversation started
when someone could see a deal stops being able to quote it the moment they cannot.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from django.conf import settings
from django.db.models import Max
from django.utils import timezone

from apps.assistant.models import MAX_STORED_ANSWER_CHARS, Conversation, ConversationTurn
from apps.authz.actor import Actor


@dataclass
class History:
    conversation: Conversation | None
    turns: list[ConversationTurn]
    focus_entity_type: str = ""
    focus_entity_id: uuid.UUID | None = None

    def as_prompt(self) -> str:
        """Earlier turns as plain text for the model, oldest first, hard-capped in total length."""
        budget = settings.ASSISTANT_HISTORY_CHARS
        lines: list[str] = []
        for turn in self.turns:
            block = f"Earlier question: {turn.question}\nEarlier answer: {turn.answer}"
            if len(block) > budget:
                break
            budget -= len(block)
            lines.append(block)
        return "\n\n".join(lines)


def load(actor: Actor, conversation_id: Any) -> History:
    """The caller's own conversation, or an empty history. Never another member's thread."""
    if not conversation_id:
        return History(conversation=None, turns=[])
    try:
        pk = uuid.UUID(str(conversation_id))
    except (TypeError, ValueError):
        return History(conversation=None, turns=[])
    conversation = Conversation.objects.filter(pk=pk, membership=actor.membership).first()
    if conversation is None:
        return History(conversation=None, turns=[])
    turns = list(conversation.turns.order_by("-position")[: settings.ASSISTANT_HISTORY_TURNS])
    turns.reverse()
    return History(
        conversation=conversation,
        turns=turns,
        focus_entity_type=conversation.focus_entity_type,
        focus_entity_id=conversation.focus_entity_id,
    )


def start(actor: Actor, *, question: str) -> Conversation:
    return Conversation.objects.create(
        membership=actor.membership, title=question[:160], last_message_at=timezone.now()
    )


def record(
    conversation: Conversation,
    *,
    question: str,
    answer: str,
    intent: str,
    mode: str,
    model: str = "",
    flagged_input: bool = False,
    focus: tuple[str, uuid.UUID] | None = None,
) -> ConversationTurn:
    """Append one turn and move the thread's focus to whatever this answer was about."""
    position = (conversation.turns.aggregate(latest=Max("position"))["latest"] or 0) + 1
    turn = ConversationTurn.objects.create(
        conversation=conversation,
        position=position,
        question=question[:1000],
        answer=(answer or "")[:MAX_STORED_ANSWER_CHARS],
        intent=intent[:32],
        mode=mode[:16],
        model=model[:64],
        flagged_input=flagged_input,
    )
    fields = ["last_message_at", "updated_at"]
    conversation.last_message_at = timezone.now()
    if focus is not None:
        conversation.focus_entity_type, conversation.focus_entity_id = focus[0][:16], focus[1]
        fields += ["focus_entity_type", "focus_entity_id"]
    conversation.save(update_fields=fields)
    _trim(conversation)
    return turn


def _trim(conversation: Conversation) -> None:
    """Keep only the turns memory can use. Older turns are not archived anywhere: this is a working
    memory, not a record of what people asked (that is the audit log)."""
    keep = settings.ASSISTANT_HISTORY_TURNS * 2
    positions = list(conversation.turns.order_by("-position").values_list("position", flat=True)[:keep])
    if len(positions) < keep:
        return
    conversation.turns.filter(position__lt=min(positions)).delete()
