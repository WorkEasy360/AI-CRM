from __future__ import annotations

from rest_framework import serializers
from rest_framework.response import Response

from apps.core.api.request import ActorRequest
from apps.core.api.viewsets import TenantAPIView
from apps.dashboards import service


class DashboardQuerySerializer(serializers.Serializer):
    period = serializers.ChoiceField(choices=list(service.PERIODS), required=False, default=service.DEFAULT_PERIOD)
    pipeline = serializers.UUIDField(required=False, allow_null=True)


class DashboardSummaryView(TenantAPIView):
    """Sales dashboard numbers for the active organization, limited to what the actor may see."""

    permission_map = {"GET": "dashboards.view"}
    throttle_scope = "search"

    def get(self, request: ActorRequest) -> Response:
        ser = DashboardQuerySerializer(data=request.query_params)
        ser.is_valid(raise_exception=True)
        data = service.summary(
            request.actor, period=ser.validated_data["period"], pipeline_id=ser.validated_data.get("pipeline")
        )
        return Response(data)
