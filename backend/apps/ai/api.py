from __future__ import annotations

from rest_framework import serializers
from rest_framework.response import Response

from apps.ai import budgets, features, scoring
from apps.core.api.viewsets import TenantAPIView
from apps.notes.registry import resolve_viewable


class DealSummaryView(TenantAPIView):
    """POST: summarise one deal the caller may view (cached per deal version; ``force`` refreshes)."""

    permission_map = {"POST": "ai.copilot.use"}
    throttle_scope = "sensitive"

    def post(self, request, deal_id=None):
        deal = resolve_viewable(request.actor, "deal", deal_id)
        force = bool((request.data or {}).get("force"))
        return Response(features.summarize_deal(request.actor, deal, request=request._request, force=force))


class ContactScoreView(TenantAPIView):
    """Rules-based lead score with reasons for one contact the caller may view."""

    permission_map = {"GET": "ai.scores.view"}

    def get(self, request, contact_id=None):
        contact = resolve_viewable(request.actor, "contact", contact_id)
        facts = scoring.facts_with_engagement(contact)
        score = scoring.score_contact(facts)
        return Response(
            {"value": score.value, "label": score.label, "reasons": score.reasons, "factors": score.factors}
        )


class FollowUpSerializer(serializers.Serializer):
    entity_type = serializers.ChoiceField(choices=[("deal", "deal"), ("contact", "contact")])
    entity_id = serializers.UUIDField()
    # Named ``tone`` in the API because ``style`` is a reserved attribute on DRF fields.
    tone = serializers.ChoiceField(choices=[(s, s) for s in features.STYLES], required=False, default="professional")
    channel = serializers.ChoiceField(
        choices=[("email", "email"), ("whatsapp", "whatsapp")], required=False, default="email"
    )


class AIFollowUpView(TenantAPIView):
    permission_map = {"POST": "ai.copilot.use"}
    throttle_scope = "sensitive"

    def post(self, request):
        ser = FollowUpSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        record = resolve_viewable(request.actor, data["entity_type"], data["entity_id"])
        return Response(
            features.generate_followup(
                request.actor,
                entity_type=data["entity_type"],
                record=record,
                style=data["tone"],
                channel=data["channel"],
                request=request._request,
            )
        )


class EmailDraftSerializer(serializers.Serializer):
    contact_id = serializers.UUIDField(required=False, allow_null=True)
    deal_id = serializers.UUIDField(required=False, allow_null=True)
    purpose = serializers.ChoiceField(choices=[(p, p) for p in features.PURPOSES], required=False, default="custom")
    tone = serializers.ChoiceField(choices=[(t, t) for t in features.TONES], required=False, default="professional")
    operation = serializers.ChoiceField(
        choices=[(o, o) for o in features.OPERATIONS], required=False, default="generate"
    )
    text = serializers.CharField(max_length=20000, required=False, allow_blank=True, default="")
    instructions = serializers.CharField(max_length=1000, required=False, allow_blank=True, default="")


class AIEmailDraftView(TenantAPIView):
    permission_map = {"POST": "ai.copilot.use"}
    throttle_scope = "sensitive"

    def post(self, request):
        ser = EmailDraftSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        contact = resolve_viewable(request.actor, "contact", data["contact_id"]) if data.get("contact_id") else None
        deal = resolve_viewable(request.actor, "deal", data["deal_id"]) if data.get("deal_id") else None
        return Response(
            features.draft_email(
                request.actor,
                contact=contact,
                deal=deal,
                purpose=data["purpose"],
                tone=data["tone"],
                operation=data["operation"],
                text=data["text"],
                instructions=data["instructions"],
                request=request._request,
            )
        )


class AIUsageView(TenantAPIView):
    """Organization AI usage and limits (administrators)."""

    permission_map = {"GET": "ai.settings.manage"}
    throttle_scope = "admin"

    def get(self, request):
        return Response(budgets.usage_summary(request.actor))
