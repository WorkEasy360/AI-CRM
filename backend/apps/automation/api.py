from __future__ import annotations

from django.db.models import Count, OuterRef, Subquery
from django.db.models.functions import Coalesce
from rest_framework import mixins, serializers, status
from rest_framework.response import Response

from apps.automation import services
from apps.automation.models import MAX_DELAY_DAYS, AutomationRule, AutomationRun
from apps.core.api.viewsets import TenantViewSet


class AutomationRuleSerializer(serializers.ModelSerializer):
    whatsapp_template_id = serializers.UUIDField(read_only=True, allow_null=True)
    whatsapp_template_name = serializers.CharField(source="whatsapp_template.name", read_only=True, default=None)
    pending_runs = serializers.IntegerField(read_only=True, default=0)
    last_outcome = serializers.CharField(read_only=True, default=None)
    last_detail = serializers.CharField(read_only=True, default=None)

    class Meta:
        model = AutomationRule
        fields = [
            "id",
            "name",
            "description",
            "trigger",
            "action",
            "message",
            "delay_days",
            "only_if_no_reply",
            "whatsapp_template_id",
            "whatsapp_template_name",
            "template_params",
            "is_enabled",
            "pending_runs",
            "last_outcome",
            "last_detail",
            "run_count",
            "last_run_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class AutomationRuleWriteSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, required=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    trigger = serializers.ChoiceField(choices=AutomationRule.Trigger.choices, required=False)
    action = serializers.ChoiceField(choices=AutomationRule.Action.choices, required=False)
    message = serializers.CharField(max_length=200, required=False, allow_blank=True)
    delay_days = serializers.IntegerField(min_value=0, max_value=MAX_DELAY_DAYS, required=False)
    is_enabled = serializers.BooleanField(required=False)
    only_if_no_reply = serializers.BooleanField(required=False)
    whatsapp_template_id = serializers.UUIDField(required=False, allow_null=True)
    template_params = serializers.ListField(
        child=serializers.CharField(max_length=200, allow_blank=True), max_length=10, required=False
    )


class AutomationRuleViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Organization-wide automation rules: everyone with ``automation.view`` sees them, admins manage."""

    permission_map = {
        "list": "automation.view",
        "retrieve": "automation.view",
        "create": "automation.manage",
        "partial_update": "automation.manage",
        "destroy": "automation.manage",
    }
    serializer_class = AutomationRuleSerializer

    def base_queryset(self):
        runs = AutomationRun.objects.filter(rule=OuterRef("pk"))
        latest = runs.exclude(outcome=AutomationRun.Outcome.PENDING).order_by("-updated_at")
        pending = (
            runs.filter(outcome=AutomationRun.Outcome.PENDING)
            .order_by()
            .values("rule")
            .annotate(n=Count("id"))
            .values("n")
        )
        return (
            AutomationRule.objects.select_related("whatsapp_template")
            .annotate(
                last_outcome=Subquery(latest.values("outcome")[:1]),
                last_detail=Subquery(latest.values("detail")[:1]),
                pending_runs=Coalesce(Subquery(pending), 0),
            )
            .order_by("created_at", "id")
        )

    def _out(self, rule: AutomationRule) -> dict:
        return AutomationRuleSerializer(self.base_queryset().get(pk=rule.pk)).data

    def create(self, request):
        ser = AutomationRuleWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        rule = services.create_rule(request.actor, ser.validated_data, request=request._request)
        return Response(self._out(rule), status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        rule = self.get_object()
        ser = AutomationRuleWriteSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        rule = services.update_rule(request.actor, rule, ser.validated_data, request=request._request)
        return Response(self._out(rule))

    def destroy(self, request, pk=None):
        rule = self.get_object()
        services.delete_rule(request.actor, rule, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)
