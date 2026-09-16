from __future__ import annotations

from decimal import Decimal

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


class AISettingsSerializer(serializers.Serializer):
    """Everything an administrator can change about AI for this workspace."""

    ai_enabled = serializers.BooleanField(required=False)
    monthly_budget_usd = serializers.DecimalField(
        max_digits=10, decimal_places=2, min_value=0, required=False, allow_null=True
    )
    user_requests_per_hour = serializers.IntegerField(min_value=0, max_value=10_000, required=False)


class AISettingsView(TenantAPIView):
    """Workspace AI policy and the health of the knowledge index.

    ``ai_enabled = false`` is a supported operating mode, not a kill switch: Ask Keel keeps answering
    from structured CRM data and the knowledge index, it simply stops sending anything to a model.
    """

    permission_map = {"GET": "ai.settings.manage", "PUT": "ai.settings.manage"}
    throttle_scope = "admin"

    def get(self, request):
        return Response(self._payload(request.actor))

    def put(self, request):
        from apps.ai import orgsettings
        from apps.audit import service as audit

        ser = AISettingsSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        orgsettings.update(
            request.actor,
            enabled=data.get("ai_enabled"),
            monthly_budget_usd=data.get("monthly_budget_usd"),
            user_requests_per_hour=data.get("user_requests_per_hour"),
        )
        audit.record(
            "ai.settings_updated",
            request=request._request,
            user=request.user,
            metadata={"fields": sorted(data.keys())},
        )
        return Response(self._payload(request.actor))

    @staticmethod
    def _payload(actor):
        from django.conf import settings as django_settings
        from django.db.models import Count, Max

        from apps.ai import orgsettings
        from apps.rag.embeddings import current_model
        from apps.rag.models import IndexEvent, IndexStatus, KnowledgeChunk

        policy = orgsettings.policy(actor)
        by_status = {
            row["status"]: row["total"]
            for row in IndexEvent.objects.values("status").annotate(total=Count("id")).order_by()
        }
        by_source = {
            row["source_type"]: row["total"]
            for row in KnowledgeChunk.objects.values("source_type").annotate(total=Count("id")).order_by()
        }
        last_failure = (
            IndexEvent.objects.filter(status=IndexStatus.FAILED).exclude(last_error="").order_by("-updated_at").first()
        )
        return {
            "ai_enabled": policy.enabled,
            "monthly_budget_usd": str(policy.monthly_budget_usd),
            "month_to_date_usd": str(budgets.month_to_date_cost(actor).quantize(Decimal("0.01"))),
            "user_requests_per_hour": policy.user_requests_per_hour,
            "provider": django_settings.AI_PROVIDER_BACKEND,
            "model_strong": django_settings.AI_MODEL_STRONG,
            "model_fast": django_settings.AI_MODEL_FAST,
            "model_fallback": django_settings.AI_FALLBACK_MODEL,
            "knowledge": {
                "embedding_backend": django_settings.RAG_EMBEDDING_BACKEND,
                "embedding_model": current_model(),
                "semantic": django_settings.RAG_EMBEDDING_BACKEND != "local",
                "chunks": sum(by_source.values()),
                "by_source": by_source,
                "status": {status: by_status.get(status, 0) for status in IndexStatus.values},
                "last_indexed_at": IndexEvent.objects.aggregate(latest=Max("indexed_at"))["latest"],
                "last_error": last_failure.last_error if last_failure else "",
            },
        }
