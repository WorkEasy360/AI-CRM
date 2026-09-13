from __future__ import annotations

from typing import Any

from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api.viewsets import TenantViewSet
from apps.core.concurrency import expected_version
from apps.pipelines import services
from apps.pipelines.models import STAGE_COLORS, Pipeline, PipelineStage


class StageSerializer(serializers.ModelSerializer):
    pipeline_id = serializers.UUIDField(read_only=True)

    class Meta:
        model = PipelineStage
        fields = [
            "id",
            "pipeline_id",
            "name",
            "position",
            "kind",
            "default_probability",
            "description",
            "color_token",
            "archived_at",
        ]
        read_only_fields = fields


class PipelineSerializer(serializers.ModelSerializer):
    stages = serializers.SerializerMethodField()

    class Meta:
        model = Pipeline
        fields = [
            "id",
            "name",
            "position",
            "is_default",
            "stages",
            "version",
            "archived_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_stages(self, obj: Pipeline) -> Any:
        stages = [s for s in obj.stages.all() if s.archived_at is None]
        return StageSerializer(sorted(stages, key=lambda s: s.position), many=True).data


class StageInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    kind = serializers.ChoiceField(choices=PipelineStage.Kind.choices, required=False)
    default_probability = serializers.IntegerField(min_value=0, max_value=100, required=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    color_token = serializers.ChoiceField(choices=[(c, c) for c in STAGE_COLORS], required=False)


class PipelineCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    stages = StageInputSerializer(many=True, required=False)


class PipelineUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    is_default = serializers.BooleanField(required=False)
    position = serializers.IntegerField(min_value=0, max_value=1000, required=False)


class ReorderSerializer(serializers.Serializer):
    stage_ids = serializers.ListField(child=serializers.UUIDField(), min_length=1, max_length=30)


class PipelineViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "pipelines.view",
        "retrieve": "pipelines.view",
        "create": "pipelines.manage",
        "partial_update": "pipelines.manage",
        "destroy": "pipelines.manage",
        "add_stage": "pipelines.manage",
        "reorder_stages": "pipelines.manage",
    }
    serializer_class = PipelineSerializer
    resolved_ordering = ("position", "id")

    def base_queryset(self):
        qs = Pipeline.objects.prefetch_related("stages")
        if self.action == "list" and self.request.query_params.get("archived", "").lower() not in {"true", "1"}:
            qs = qs.filter(archived_at__isnull=True)
        return qs

    def _read(self, pipeline: Pipeline) -> dict:
        return PipelineSerializer(Pipeline.objects.prefetch_related("stages").get(pk=pipeline.pk)).data

    def create(self, request):
        ser = PipelineCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        pipeline = services.create_pipeline(
            request.actor,
            name=ser.validated_data["name"],
            stages=ser.validated_data.get("stages"),
            request=request._request,
        )
        return Response(self._read(pipeline), status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        pipeline = self.get_object()
        ser = PipelineUpdateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        version = expected_version(request._request, request.data, required=False)
        services.update_pipeline(
            request.actor, pipeline, expected_version=version, request=request._request, **ser.validated_data
        )
        return Response(self._read(pipeline))

    def destroy(self, request, pk=None):
        pipeline = self.get_object()
        services.archive_pipeline(request.actor, pipeline, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="stages")
    def add_stage(self, request, pk=None):
        pipeline = self.get_object()
        ser = StageInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        if "name" not in ser.validated_data:
            raise serializers.ValidationError({"name": "Name is required."})
        stage = services.create_stage(request.actor, pipeline, request=request._request, **ser.validated_data)
        return Response(StageSerializer(stage).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="stages/reorder")
    def reorder_stages(self, request, pk=None):
        pipeline = self.get_object()
        ser = ReorderSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        stages = services.reorder_stages(
            request.actor, pipeline, stage_ids=ser.validated_data["stage_ids"], request=request._request
        )
        return Response({"stages": StageSerializer(stages, many=True).data})


class PipelineStageViewSet(mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {"retrieve": "pipelines.view", "partial_update": "pipelines.manage", "destroy": "pipelines.manage"}
    serializer_class = StageSerializer

    def base_queryset(self):
        return PipelineStage.objects.select_related("pipeline")

    def partial_update(self, request, pk=None):
        stage = self.get_object()
        ser = StageInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.update_stage(request.actor, stage, request=request._request, **ser.validated_data)
        return Response(StageSerializer(stage).data)

    def destroy(self, request, pk=None):
        stage = self.get_object()
        services.archive_stage(request.actor, stage, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)
