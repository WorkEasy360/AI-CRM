from __future__ import annotations

from rest_framework import serializers
from rest_framework.response import Response

from apps.core.api.request import ActorRequest
from apps.core.api.viewsets import TenantAPIView
from apps.dashboards import service


class DashboardQuerySerializer(serializers.Serializer):
    # A preset ("30d") or a calendar month that has started ("2026-11").
    period = serializers.CharField(max_length=8, required=False, default=service.DEFAULT_PERIOD)
    pipeline = serializers.UUIDField(required=False, allow_null=True)
    months = serializers.ChoiceField(choices=list(service.TREND_CHOICES), required=False, default=service.TREND_MONTHS)
    # "me" narrows every figure to records the member owns, inside what they could already see.
    owner = serializers.ChoiceField(choices=["all", "me"], required=False, default="all")

    def validate_period(self, value: str) -> str:
        if not service.is_period(value):
            raise serializers.ValidationError("Choose 7d, 30d, 90d, 365d or a month like 2026-11.")
        return value


class DashboardSummaryView(TenantAPIView):
    """Sales dashboard numbers for the active organization, limited to what the actor may see."""

    permission_map = {"GET": "dashboards.view"}
    throttle_scope = "search"

    def get(self, request: ActorRequest) -> Response:
        ser = DashboardQuerySerializer(data=request.query_params)
        ser.is_valid(raise_exception=True)
        data = service.summary(
            request.actor,
            period=ser.validated_data["period"],
            pipeline_id=ser.validated_data.get("pipeline"),
            trend_months=int(ser.validated_data["months"]),
            mine=ser.validated_data["owner"] == "me",
        )
        return Response(data)
