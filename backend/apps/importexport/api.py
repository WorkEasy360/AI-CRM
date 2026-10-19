"""Per-entity import and export viewsets so each route carries a static ``permission_map``.

``/imports/{contacts,companies,products,deals}/`` and ``/exports/{contacts,companies,products,deals,all}/``.
Jobs are visible only to the member who requested them.
"""

from __future__ import annotations

from typing import ClassVar

from django.http import HttpResponse, HttpResponseRedirect
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.core.api.serializers import MembershipRefSerializer
from apps.core.api.viewsets import TenantViewSet
from apps.importexport import importing, service
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
            "file_format",
            "total_rows",
            "processed_rows",
            "created_rows",
            "updated_rows",
            "skipped_rows",
            "error_rows",
            "errors",
            "error_message",
            "preview",
            "stop",
            "rollback",
            "rolled_back_at",
            "requested_by",
            "started_at",
            "finished_at",
            "created_at",
        ]
        read_only_fields = fields


class ImportStartSerializer(serializers.Serializer):
    mapping = serializers.DictField(child=serializers.CharField(max_length=60, allow_blank=True), required=False)
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


class SuggestSerializer(serializers.Serializer):
    preset = serializers.ChoiceField(choices=[(k, k) for k in importing.PRESETS], required=False, allow_blank=True)


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
        data["preview_rows"] = data["sample"] = service.preview_rows(job)
        data["targets"] = service.allowed_targets(request.actor, self.entity_type)
        data["presets"] = importing.presets(self.entity_type)
        # Before Milestone 2 ``preview`` held the sample rows; keep that for older clients on upload.
        data["preview"] = data["sample"]
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def preview(self, request, pk=None):
        """The first rows of the file (raw) and the fields they may be mapped to."""
        job = self.get_object()
        targets = service.allowed_targets(request.actor, self.entity_type)
        if job.status not in {"uploaded", "previewed"}:
            return Response({"preview": [], "targets": targets})
        return Response({"preview": service.preview_rows(job), "targets": targets})

    @action(detail=False, methods=["get"])
    def presets(self, request):
        """Column-mapping presets for exports of other CRMs (Zoho CRM, HubSpot, Pipedrive)."""
        return Response({"results": importing.presets(self.entity_type)})

    @action(detail=True, methods=["post"])
    def suggest(self, request, pk=None):
        """A suggested mapping for this file's headers, optionally from a migration preset."""
        job = self.get_object()
        ser = SuggestSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        mapping = service.suggest_mapping(
            request.actor, self.entity_type, job.headers, preset=ser.validated_data.get("preset") or None
        )
        return Response({"mapping": mapping})

    @action(detail=True, methods=["post"])
    def check(self, request, pk=None):
        """Dry run: validate every row with this mapping and options, write nothing (see ``preview`` on the job)."""
        job = self.get_object()
        ser = ImportStartSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        job = service.start_preview(
            request.actor,
            job,
            mapping=ser.validated_data.get("mapping"),
            options=ser.validated_data.get("options"),
            request=request._request,
        )
        return Response(ImportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["post"])
    def start(self, request, pk=None):
        job = self.get_object()
        ser = ImportStartSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        job = service.start_import(
            request.actor,
            job,
            mapping=ser.validated_data.get("mapping"),
            options=ser.validated_data.get("options"),
            request=request._request,
        )
        return Response(ImportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["post"])
    def rollback(self, request, pk=None):
        """Undo this import: delete what it created, restore what it updated; conflicts are reported."""
        job = self.get_object()
        job = service.start_rollback(request.actor, job, request=request._request)
        return Response(ImportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class _ExportJobViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    entity_type: ClassVar[str]
    serializer_class = ExportJobSerializer
    # Starting an export is a POST but changes no CRM data: a read-only (suspended) organization may still
    # export, as Workeasy360's entitlement contract and the read-only message promise.
    entitlement_read_actions: ClassVar[frozenset[str]] = frozenset({"create"})
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
        download = service.open_download(request.actor, job, request=request._request)
        if download.url is not None:
            # Object storage: a short-lived signed URL (attachment disposition enforced by the URL itself).
            response = HttpResponseRedirect(download.url)
        else:
            content_type = "application/zip" if download.filename.endswith(".zip") else "text/csv; charset=utf-8"
            response = HttpResponse(download.data, content_type=content_type)
            response["Content-Disposition"] = f'attachment; filename="{download.filename}"'
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "no-store"
        return response


def _perms(module: str, action: str) -> dict[str, str]:
    p = f"{module}.{action}"
    return {
        "list": p,
        "retrieve": p,
        "create": p,
        "preview": p,
        "presets": p,
        "suggest": p,
        "check": p,
        "start": p,
        "rollback": p,
        "download": p,
    }


class ContactImportViewSet(_ImportJobViewSet):
    entity_type = "contact"
    permission_map = _perms("contacts", "import")


class CompanyImportViewSet(_ImportJobViewSet):
    entity_type = "company"
    permission_map = _perms("companies", "import")


class ProductImportViewSet(_ImportJobViewSet):
    entity_type = "product"
    permission_map = _perms("products", "import")


class DealImportViewSet(_ImportJobViewSet):
    entity_type = "deal"
    permission_map = _perms("deals", "import")


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


class FullExportViewSet(_ExportJobViewSet):
    """Every module the requester may export, one CSV per module in a ZIP (hierarchy and field rules applied).

    The route only needs membership; the service exports just the modules the requester holds
    ``<module>.export`` for and refuses with 403 when that is none.
    """

    entity_type = service.FULL_EXPORT
    permission_map = {"list": "org.view", "retrieve": "org.view", "create": "org.view", "download": "org.view"}
