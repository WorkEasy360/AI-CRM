"""Per-entity import and export viewsets so each route carries a static ``permission_map``.

``/imports/contacts/``, ``/imports/companies/``, ``/imports/products/`` and
``/exports/{contacts,companies,products,deals}/``. Jobs are visible only to the member who requested them.
"""

from __future__ import annotations

from typing import ClassVar

from django.http import HttpResponse
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.core.api.serializers import MembershipRefSerializer
from apps.core.api.viewsets import TenantViewSet
from apps.importexport import service
from apps.importexport.models import ExportJob, ImportJob


class ImportJobSerializer(serializers.ModelSerializer):
    requested_by = MembershipRefSerializer(read_only=True)

    class Meta:
        model = ImportJob
        fields = [
            "id",
            "entity_type",
            "status",
            "original_filename",
            "size_bytes",
            "headers",
            "mapping",
            "options",
            "total_rows",
            "processed_rows",
            "created_rows",
            "error_rows",
            "errors",
            "error_message",
            "requested_by",
            "started_at",
            "finished_at",
            "created_at",
        ]
        read_only_fields = fields


class ImportStartSerializer(serializers.Serializer):
    mapping = serializers.DictField(child=serializers.CharField(max_length=60, allow_blank=True))
    options = serializers.DictField(required=False, default=dict)

    def validate_mapping(self, value):
        if len(value) > 60:
            raise serializers.ValidationError("Too many columns.")
        return value


class ExportJobSerializer(serializers.ModelSerializer):
    requested_by = MembershipRefSerializer(read_only=True)

    class Meta:
        model = ExportJob
        fields = [
            "id",
            "entity_type",
            "status",
            "filters",
            "row_count",
            "size_bytes",
            "error_message",
            "requested_by",
            "started_at",
            "finished_at",
            "expires_at",
            "download_count",
            "created_at",
        ]
        read_only_fields = fields


class ExportCreateSerializer(serializers.Serializer):
    filters = serializers.DictField(
        child=serializers.CharField(max_length=200, allow_blank=True), required=False, default=dict
    )

    def validate_filters(self, value):
        if len(value) > 30:
            raise serializers.ValidationError("Too many filters.")
        return value


class _ImportJobViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    entity_type: ClassVar[str]
    serializer_class = ImportJobSerializer
    throttle_scope = "sensitive"
    resolved_ordering = ("-created_at", "-id")

    # The upload is multipart; every other action is JSON. DRF selects by Content-Type.
    parser_classes = [JSONParser, MultiPartParser]

    def base_queryset(self):
        return ImportJob.objects.filter(
            entity_type=self.entity_type, requested_by=self.request.actor.membership
        ).select_related("requested_by__user")

    def create(self, request):
        uploaded = request.FILES.get("file")
        if uploaded is None:
            raise serializers.ValidationError({"file": "Upload a CSV file in the 'file' field."})
        job = service.create_import(
            request.actor, entity_type=self.entity_type, uploaded=uploaded, request=request._request
        )
        data = ImportJobSerializer(job).data
        data["preview"] = service.preview_rows(job)
        data["targets"] = service.allowed_targets(self.entity_type)
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def preview(self, request, pk=None):
        job = self.get_object()
        if job.status != "uploaded":
            return Response({"preview": [], "targets": service.allowed_targets(self.entity_type)})
        return Response({"preview": service.preview_rows(job), "targets": service.allowed_targets(self.entity_type)})

    @action(detail=True, methods=["post"])
    def start(self, request, pk=None):
        job = self.get_object()
        ser = ImportStartSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        job = service.start_import(
            request.actor,
            job,
            mapping=ser.validated_data["mapping"],
            options=ser.validated_data.get("options"),
            request=request._request,
        )
        return Response(ImportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class _ExportJobViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    entity_type: ClassVar[str]
    serializer_class = ExportJobSerializer
    throttle_scope = "sensitive"
    resolved_ordering = ("-created_at", "-id")

    def base_queryset(self):
        return ExportJob.objects.filter(
            entity_type=self.entity_type, requested_by=self.request.actor.membership
        ).select_related("requested_by__user")

    def create(self, request):
        ser = ExportCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        job = service.create_export(
            request.actor,
            entity_type=self.entity_type,
            filters=ser.validated_data.get("filters") or {},
            request=request._request,
        )
        return Response(ExportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        job = self.get_object()
        data, filename = service.open_download(request.actor, job, request=request._request)
        response = HttpResponse(data, content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "no-store"
        return response


def _perms(module: str, action: str) -> dict[str, str]:
    p = f"{module}.{action}"
    return {"list": p, "retrieve": p, "create": p, "preview": p, "start": p, "download": p}


class ContactImportViewSet(_ImportJobViewSet):
    entity_type = "contact"
    permission_map = _perms("contacts", "import")


class CompanyImportViewSet(_ImportJobViewSet):
    entity_type = "company"
    permission_map = _perms("companies", "import")


class ProductImportViewSet(_ImportJobViewSet):
    entity_type = "product"
    permission_map = _perms("products", "import")


class ContactExportViewSet(_ExportJobViewSet):
    entity_type = "contact"
    permission_map = _perms("contacts", "export")


class CompanyExportViewSet(_ExportJobViewSet):
    entity_type = "company"
    permission_map = _perms("companies", "export")


class ProductExportViewSet(_ExportJobViewSet):
    entity_type = "product"
    permission_map = _perms("products", "export")


class DealExportViewSet(_ExportJobViewSet):
    entity_type = "deal"
    permission_map = _perms("deals", "export")
