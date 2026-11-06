"""``/api/v1/records/<entity_type>/...``: module schema and the generic views (Sheet, Kanban, Calendar, Chart).

The route gate is ``org.view`` (every member holds it); each handler then requires the module's own
``<module>.view`` / ``<module>.update`` through ``apps.crm.query`` / ``apps.crm.sheet``, so a member without
access to a module gets 403 from the service, and records outside their scope never appear.
"""

from __future__ import annotations

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.response import Response

from apps.authz.service import check
from apps.core.api.viewsets import TenantAPIView
from apps.crm import query, schema, sheet

_ENTITY = OpenApiParameter("entity_type", str, OpenApiParameter.PATH, enum=["contact", "company", "deal", "product"])


class ModuleSerializer(serializers.Serializer):
    entity_type = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]
    label_plural = serializers.CharField()
    counts_as_record = serializers.BooleanField()


class ModulesView(TenantAPIView):
    """Modules the actor can open (the registry, filtered by ``<module>.view``)."""

    permission_map = {"GET": "org.view"}

    @extend_schema(responses=ModuleSerializer(many=True))
    def get(self, request):
        out = [
            {
                "entity_type": m.entity_type,
                "label": m.label,
                "label_plural": m.label_plural,
                "counts_as_record": m.counts_as_record,
            }
            for m in schema.modules()
            if request.actor.has(f"{m.module}.view")
        ]
        return Response({"results": out})


class ModuleSchemaView(TenantAPIView):
    """The fields of one module as this actor may see them (hidden fields absent, read-only flagged)."""

    permission_map = {"GET": "org.view"}

    @extend_schema(parameters=[_ENTITY])
    def get(self, request, entity_type: str):
        module = schema.get(entity_type)
        check(request.actor, f"{module.module}.view")
        return Response(schema.describe(request.actor, entity_type))


class RowsView(TenantAPIView):
    """Sheet/List window: ``?offset=&limit=&columns=a,b&sort=&<filters>``."""

    permission_map = {"GET": "org.view"}

    @extend_schema(parameters=[_ENTITY])
    def get(self, request, entity_type: str):
        return Response(query.rows(request.actor, entity_type, request.query_params.dict()))


class CellEditSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    version = serializers.IntegerField(min_value=1)
    values = serializers.DictField()


class EditsSerializer(serializers.Serializer):
    rows = serializers.ListField(child=CellEditSerializer(), max_length=sheet.MAX_ROWS)


class EditsView(TenantAPIView):
    """Sheet edits: ``{"rows": [{"id", "version", "values": {field: value}}]}``; per-row and per-cell results."""

    permission_map = {"POST": "org.view"}

    @extend_schema(parameters=[_ENTITY], request=EditsSerializer)
    def post(self, request, entity_type: str):
        ser = EditsSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        rows = [dict(r) for r in ser.validated_data["rows"]]
        return Response(sheet.apply_edits(request.actor, entity_type, rows, request=request._request))


class GroupsView(TenantAPIView):
    """Generic Kanban: ``?group_by=<field>&per_group=&columns=&<filters>``."""

    permission_map = {"GET": "org.view"}

    @extend_schema(parameters=[_ENTITY])
    def get(self, request, entity_type: str):
        return Response(query.groups(request.actor, entity_type, request.query_params.dict()))


class GroupPageView(TenantAPIView):
    """More cards for one generic Kanban column: ``?group_by=&value=&offset=&limit=``."""

    permission_map = {"GET": "org.view"}

    @extend_schema(parameters=[_ENTITY])
    def get(self, request, entity_type: str):
        return Response(query.group_page(request.actor, entity_type, request.query_params.dict()))


class CalendarView(TenantAPIView):
    """Records by one of their date fields: ``?date_field=&from=&to=&<filters>``."""

    permission_map = {"GET": "org.view"}

    @extend_schema(parameters=[_ENTITY])
    def get(self, request, entity_type: str):
        return Response(query.calendar(request.actor, entity_type, request.query_params.dict()))


class ChartView(TenantAPIView):
    """One grouped series: ``?group_by=&measure=count|sum&field=&<filters>``."""

    permission_map = {"GET": "org.view"}

    @extend_schema(parameters=[_ENTITY])
    def get(self, request, entity_type: str):
        return Response(query.chart(request.actor, entity_type, request.query_params.dict()))
