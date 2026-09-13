"""Base viewset for CRM records. Modules subclass it, declare their spec, serializers and filterset.

Behaviour shared by every record type:
- list: view-scoped, archived hidden unless ``?archived=true``, allowlisted filters/sort/search,
  cursor pagination, tags and custom-field definitions batch-loaded (no N+1)
- retrieve: view-scoped (404 outside scope) then object-level check
- create/update: write serializer → service → read serializer; ``If-Match``/``version`` enforced on update
- destroy = archive (soft), ``restore`` action, ``tags`` action, ``count`` action, ``bulk`` action
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db.models import QuerySet
from rest_framework import mixins, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core import records
from apps.core.api.filters import FilterSet
from apps.core.api.serializers import BulkActionSerializer, TagIdsSerializer
from apps.core.api.viewsets import TenantViewSet
from apps.core.concurrency import expected_version
from apps.core.records import RecordSpec


def crud_permission_map(module: str, **extra: str) -> dict[str, str]:
    return {
        "list": f"{module}.view",
        "retrieve": f"{module}.view",
        "count": f"{module}.view",
        "create": f"{module}.create",
        "partial_update": f"{module}.update",
        "set_tags": f"{module}.update",
        "destroy": f"{module}.delete",
        "restore": f"{module}.delete",
        "bulk": f"{module}.bulk_update",
        **extra,
    }


class CrmViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    spec: ClassVar[RecordSpec]
    filterset: ClassVar[FilterSet]
    serializer_class: Any
    write_serializer_class: ClassVar[type]
    resolved_ordering: tuple[str, ...] | None = None

    # ------------------------------------------------------------------ queryset plumbing
    def base_queryset(self) -> QuerySet:
        return self.spec.model.objects.select_related("owner__user")

    def filter_queryset(self, queryset: QuerySet) -> QuerySet:
        if self.action in {"list", "count"}:
            params = self.request.query_params.dict()
            archived = params.get("archived", "").lower()
            if archived in {"true", "1"}:
                queryset = queryset.filter(archived_at__isnull=False)
            elif archived == "all":
                pass
            else:
                queryset = queryset.filter(archived_at__isnull=True)
            queryset, ordering = self.filterset.apply(queryset, params, actor=self.request.actor)
            self.resolved_ordering = ordering
        return queryset

    def get_serializer_context(self) -> dict[str, Any]:
        ctx = dict(super().get_serializer_context())
        ctx["actor"] = self.request.actor
        return ctx

    def _read_context(self, objs: list[Any]) -> dict[str, Any]:
        from apps.customfields import service as customfields
        from apps.tagging import service as tagging

        ctx = dict(self.get_serializer_context())
        ctx["tags_map"] = tagging.tags_for(self.spec.entity_type, [o.pk for o in objs])
        ctx["custom_definitions"] = customfields.active_definitions(self.spec.entity_type)
        return ctx

    def read(self, obj: Any) -> dict[str, Any]:
        obj = self.base_queryset().get(pk=obj.pk)
        return self.serializer_class(obj, context=self._read_context([obj])).data

    # ------------------------------------------------------------------ actions
    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        objs = list(page if page is not None else queryset)
        data = self.serializer_class(objs, many=True, context=self._read_context(objs)).data
        if page is not None:
            return self.get_paginated_response(data)
        return Response({"results": data})

    def retrieve(self, request, *args, **kwargs):
        obj = self.get_object()
        return Response(self.serializer_class(obj, context=self._read_context([obj])).data)

    @action(detail=False, methods=["get"])
    def count(self, request):
        queryset = self.filter_queryset(self.get_queryset())
        return Response({"count": queryset.count()})

    def create(self, request):
        ser = self.write_serializer_class(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        obj = self.perform_create(ser.validated_data)
        return Response(self.read(obj), status=status.HTTP_201_CREATED)

    def perform_create(self, data: dict[str, Any]):
        return records.create(self.request.actor, self.spec, data, request=self.request._request)

    def partial_update(self, request, pk=None):
        obj = self.get_object()
        ser = self.write_serializer_class(obj, data=request.data, partial=True, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        version = expected_version(request._request, request.data)
        obj = self.perform_update(obj, ser.validated_data, version)
        return Response(self.read(obj))

    def perform_update(self, obj: Any, data: dict[str, Any], version: int | None):
        return records.update(
            self.request.actor, self.spec, obj, data, expected_version=version, request=self.request._request
        )

    def destroy(self, request, pk=None):
        obj = self.get_object()
        records.archive(request.actor, self.spec, obj, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        obj = self.get_object()
        records.restore(request.actor, self.spec, obj, request=request._request)
        return Response(self.read(obj))

    @action(detail=True, methods=["put"], url_path="tags")
    def set_tags(self, request, pk=None):
        from apps.tagging import service as tagging
        from apps.tagging.api import TagRefSerializer

        obj = self.get_object()
        ser = TagIdsSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        tags = tagging.set_tags(
            request.actor,
            record=obj,
            entity_type=self.spec.entity_type,
            permission=self.spec.perm("update"),
            tag_ids=ser.validated_data["tag_ids"],
            request=request._request,
        )
        return Response({"tags": TagRefSerializer(tags, many=True).data})

    @action(detail=False, methods=["post"])
    def bulk(self, request):
        ser = BulkActionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        result = records.bulk(
            request.actor,
            self.spec,
            ids=list(dict.fromkeys(ser.validated_data["ids"])),
            action=ser.validated_data["action"],
            payload=ser.validated_data.get("payload") or {},
            request=request._request,
        )
        return Response(result)
