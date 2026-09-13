from __future__ import annotations

from rest_framework import serializers
from rest_framework.response import Response

from apps.core.api.viewsets import TenantAPIView
from apps.search import service


class SearchQuerySerializer(serializers.Serializer):
    q = serializers.CharField(max_length=service.MAX_QUERY_LENGTH, allow_blank=True, required=False, default="")
    types = serializers.CharField(max_length=80, required=False, allow_blank=True, default="")
    limit = serializers.IntegerField(
        min_value=1, max_value=service.MAX_PER_TYPE, required=False, default=service.DEFAULT_PER_TYPE
    )


class GlobalSearchView(TenantAPIView):
    permission_map = {"GET": "search.use"}
    throttle_scope = "search"

    def get(self, request):
        ser = SearchQuerySerializer(data=request.query_params)
        ser.is_valid(raise_exception=True)
        types = [t.strip() for t in ser.validated_data["types"].split(",") if t.strip()] or None
        return Response(
            service.search(request.actor, ser.validated_data["q"], types=types, per_type=ser.validated_data["limit"])
        )
