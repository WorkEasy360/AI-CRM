from __future__ import annotations

from django.http import HttpResponse, HttpResponseRedirect
from django.shortcuts import get_object_or_404
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.authz.service import check
from apps.core.api.serializers import MembershipRefSerializer
from apps.core.api.viewsets import TenantViewSet
from apps.files import services
from apps.files.models import FILE_ENTITY_TYPES, MAX_FILE_BYTES, FileAttachment
from apps.notes.registry import resolve_viewable


class FileAttachmentSerializer(serializers.ModelSerializer):
    uploaded_by = MembershipRefSerializer(read_only=True)

    class Meta:
        model = FileAttachment
        fields = [
            "id",
            "entity_type",
            "entity_id",
            "filename",
            "content_type",
            "size_bytes",
            "uploaded_by",
            "created_at",
        ]
        read_only_fields = fields


class EntityQuerySerializer(serializers.Serializer):
    entity_type = serializers.ChoiceField(choices=[(e, e) for e in FILE_ENTITY_TYPES])
    entity_id = serializers.UUIDField()


class FileAttachmentViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Files hang off a record: anyone who can view the record and holds ``files.view`` sees them;
    deleting follows ``files.delete`` scopes (a rep removes their own uploads, managers remove any)."""

    permission_map = {
        "list": "files.view",
        "retrieve": "files.view",
        "create": "files.upload",
        "destroy": "files.delete",
        "download": "files.view",
    }
    serializer_class = FileAttachmentSerializer
    resolved_ordering = ("-created_at", "-id")
    # The upload is multipart; every other action is JSON. DRF selects by Content-Type.
    parser_classes = [JSONParser, MultiPartParser]

    def base_queryset(self):
        return FileAttachment.objects.select_related("uploaded_by__user")

    def get_queryset(self):
        # Listing is gated by the *record*, not by upload ownership: resolve the record within the
        # actor's view scope first, then list its files.
        if self.action == "list":
            params = self.request.query_params
            if not params.get("entity_type") and not params.get("entity_id"):
                return self.base_queryset().filter(uploaded_by=self.request.actor.membership)
            ser = EntityQuerySerializer(data=params)
            ser.is_valid(raise_exception=True)
            record = resolve_viewable(
                self.request.actor, ser.validated_data["entity_type"], ser.validated_data["entity_id"]
            )
            return self.base_queryset().filter(entity_type=ser.validated_data["entity_type"], entity_id=record.pk)
        if self.action == "retrieve":
            return self.base_queryset()
        return super().get_queryset()

    def get_object(self):
        """A file is addressable only if its record is within the actor's view scope (404 otherwise);
        the action's permission is then checked against the uploader (403)."""
        attachment = get_object_or_404(self.base_queryset(), pk=self.kwargs["pk"])
        resolve_viewable(self.request.actor, attachment.entity_type, attachment.entity_id)
        check(self.request.actor, self.current_permission(), attachment)
        return attachment

    def create(self, request):
        uploaded = request.FILES.get("file")
        if uploaded is None:
            raise serializers.ValidationError({"file": "Upload a file in the 'file' field."})
        if uploaded.size > MAX_FILE_BYTES:
            raise serializers.ValidationError({"file": "Files are limited to 10 MB each."})
        ser = EntityQuerySerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        attachment = services.upload_file(
            request.actor,
            entity_type=ser.validated_data["entity_type"],
            entity_id=ser.validated_data["entity_id"],
            filename=uploaded.name or "attachment",
            content_type=(uploaded.content_type or "").split(";")[0].strip().lower(),
            blob=uploaded.read(),
            request=request._request,
        )
        data = FileAttachmentSerializer(self.base_queryset().get(pk=attachment.pk)).data
        return Response(data, status=status.HTTP_201_CREATED)

    def destroy(self, request, pk=None):
        attachment = self.get_object()
        services.delete_file(request.actor, attachment, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        attachment = self.get_object()
        download = services.open_download(request.actor, attachment, request=request._request)
        if download.url is not None:
            # Object storage: a short-lived signed URL (attachment disposition enforced by the URL itself).
            response = HttpResponseRedirect(download.url)
        else:
            response = HttpResponse(download.data, content_type=download.content_type)
            response["Content-Disposition"] = f'attachment; filename="{download.filename}"'
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "no-store"
        return response
