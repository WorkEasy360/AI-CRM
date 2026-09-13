from __future__ import annotations

from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from apps.core.api.request import ActorRequest
from apps.core.api.viewsets import TenantAPIView
from apps.forecasting import service


class ForecastQuerySerializer(serializers.Serializer):
    period = serializers.ChoiceField(choices=[(p, p) for p in service.PERIODS], required=False, default="month")
    start = serializers.DateField(required=False, source="from_", input_formats=["iso-8601"])
    end = serializers.DateField(required=False, input_formats=["iso-8601"])
    pipeline = serializers.UUIDField(required=False, allow_null=True)
    group_by = serializers.ChoiceField(choices=[(g, g) for g in service.GROUP_BYS], required=False, default="stage")


class ForecastView(TenantAPIView):
    """Sales forecast for the active organization inside the caller's ``deals.view`` scope."""

    permission_map = {"GET": "reports.view"}
    throttle_scope = "search"

    def get(self, request: ActorRequest) -> Response:
        params = request.query_params.dict()
        # "from" is a reserved word for a serializer attribute; accept it as the query key.
        if "from" in params:
            params["start"] = params.pop("from")
        if "to" in params:
            params["end"] = params.pop("to")
        ser = ForecastQuerySerializer(data=params)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        try:
            payload = service.compute_forecast(
                request.actor,
                period=data["period"],
                start=data.get("from_"),
                end=data.get("end"),
                pipeline_id=data.get("pipeline"),
                group_by=data["group_by"],
            )
        except ValueError as exc:
            raise ValidationError({"period": str(exc)}) from exc
        return Response(payload)
