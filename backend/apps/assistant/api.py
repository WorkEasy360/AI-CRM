"""Ask Keel HTTP surface. One endpoint to ask, one to open the panel, one for the index's health."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.response import Response

from apps.assistant import memory, orchestrator
from apps.assistant.models import MAX_QUESTION_CHARS, Conversation
from apps.core.api.request import ActorRequest
from apps.core.api.viewsets import TenantAPIView


class AskSerializer(serializers.Serializer):
    question = serializers.CharField(max_length=MAX_QUESTION_CHARS, trim_whitespace=True)
    conversation_id = serializers.UUIDField(required=False, allow_null=True)


class AskKeelView(TenantAPIView):
    """POST a question; always answers, with or without a model behind it.

    The response shape is identical in every mode -- ``mode`` says which one produced it, so the UI
    can show "Knowledge search mode" without ever exposing a provider name or status code.
    """

    permission_map = {"POST": "ai.assistant.use"}
    throttle_scope = "assistant"

    def post(self, request: ActorRequest) -> Response:
        ser = AskSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        return Response(
            orchestrator.ask(
                request.actor,
                ser.validated_data["question"],
                conversation_id=ser.validated_data.get("conversation_id"),
                request=request._request,
            )
        )


class AssistantHomeView(TenantAPIView):
    """What the dashboard card needs before anyone types: prompts, and whether AI is available."""

    permission_map = {"GET": "ai.assistant.use"}
    throttle_scope = "search"

    def get(self, request: ActorRequest) -> Response:
        from apps.ai import orgsettings
        from apps.rag.models import KnowledgeChunk

        actor = request.actor
        policy = orgsettings.policy(actor)
        generative = policy.enabled and actor.has("ai.copilot.use")
        return Response(
            {
                "suggestions": orchestrator.suggestions_for(actor),
                # Deliberately coarse: a salesperson needs to know whether answers will be written
                # for them, not which vendor returned which status code.
                "generative_available": generative,
                "knowledge_available": KnowledgeChunk.objects.exists(),
                "recent": [
                    {
                        "id": str(row.pk),
                        "title": row.title,
                        "last_message_at": row.last_message_at,
                    }
                    for row in Conversation.objects.filter(membership=actor.membership).order_by("-last_message_at")[:5]
                ],
            }
        )


class ConversationView(TenantAPIView):
    """One thread of the caller's own. Another member's id simply reads as empty."""

    permission_map = {"GET": "ai.assistant.use", "DELETE": "ai.assistant.use"}
    throttle_scope = "search"

    def get(self, request: ActorRequest, conversation_id=None) -> Response:
        history = memory.load(request.actor, conversation_id)
        if history.conversation is None:
            return Response({"id": None, "turns": []})
        return Response(
            {
                "id": str(history.conversation.pk),
                "title": history.conversation.title,
                "turns": [
                    {
                        "position": turn.position,
                        "question": turn.question,
                        "answer": turn.answer,
                        "mode": turn.mode,
                        "created_at": turn.created_at,
                    }
                    for turn in history.turns
                ],
            }
        )

    def delete(self, request: ActorRequest, conversation_id=None) -> Response:
        history = memory.load(request.actor, conversation_id)
        if history.conversation is not None:
            history.conversation.delete()
        return Response(status=204)
