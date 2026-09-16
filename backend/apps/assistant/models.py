"""Conversation memory for Ask Keel.

Short, bounded and never shared. A conversation belongs to one membership inside one organization;
there is no path that reads another member's thread, and the tenant manager plus RLS make that true
in the database as well as in the code.

Only what the next question needs is kept: the last few turns (truncated), and the record the
conversation is currently about, so "what should I do next?" knows that "it" is ABC Corp. Nothing
here is an audit trail -- that is ``apps.audit`` -- and nothing here is retrieved by the knowledge
index, so an answer can never become evidence for a later answer.
"""

from __future__ import annotations

from typing import ClassVar

from django.db import models

from apps.core.models import TenantModel

MAX_QUESTION_CHARS = 1000
MAX_STORED_ANSWER_CHARS = 4000


class Conversation(TenantModel):
    """One Ask Keel thread, owned by the member who started it."""

    OWNER_FIELD: ClassVar[str | None] = "membership"

    membership = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="assistant_threads")
    title = models.CharField(max_length=160, blank=True)
    # The record the thread is currently about, so follow-up questions resolve pronouns.
    focus_entity_type = models.CharField(max_length=16, blank=True)
    focus_entity_id = models.UUIDField(null=True, blank=True)
    last_message_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["organization", "membership", "-last_message_at"], name="asstconv_org_member_idx"),
        ]
        ordering = ["-last_message_at"]


class ConversationTurn(TenantModel):
    """One question and the answer given to it."""

    OWNER_FIELD: ClassVar[str | None] = None

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="turns")
    position = models.PositiveSmallIntegerField(default=0)
    question = models.CharField(max_length=MAX_QUESTION_CHARS)
    answer = models.TextField(blank=True)
    intent = models.CharField(max_length=32, blank=True)
    # "ai" | "ai_fallback" | "retrieval" -- what actually produced the answer.
    mode = models.CharField(max_length=16, blank=True)
    model = models.CharField(max_length=64, blank=True)
    flagged_input = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["conversation", "position"], name="uniq_assistant_turn_position")
        ]
        indexes = [models.Index(fields=["organization", "conversation", "position"], name="asstturn_conv_pos_idx")]
        ordering = ["position"]
