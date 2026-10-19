from __future__ import annotations

from typing import Any

from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.viewsets import TenantViewSet
from apps.core.concurrency import expected_version
from apps.pipelines import services
from apps.pipelines.models import STAGE_COLORS, Pipeline, PipelineStage
from apps.pipelines.templates import TEMPLATES


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


class PipelineAccessSerializer(serializers.Serializer):
    team_ids = serializers.ListField(child=serializers.UUIDField(), max_length=50)
    hierarchy_role_ids = serializers.ListField(child=serializers.UUIDField(), max_length=50)


class PipelineSerializer(serializers.ModelSerializer):
    stages = serializers.SerializerMethodField()
    parent_id = serializers.UUIDField(read_only=True, allow_null=True)
    access = serializers.SerializerMethodField()
    effective_layout = serializers.SerializerMethodField()

    class Meta:
        model = Pipeline
        fields = [
            "id",
            "name",
            "position",
            "is_default",
            "parent_id",
            "restricted",
            "layout",
            "effective_layout",
            "template_key",
            "access",
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

    def get_access(self, obj: Pipeline) -> dict[str, list[str]]:
        rules = list(obj.access_rules.all()) if obj.parent_id is None else []
        return {
            "team_ids": [str(r.team_id) for r in rules if r.team_id],
            "hierarchy_role_ids": [str(r.hierarchy_role_id) for r in rules if r.hierarchy_role_id],
        }

    def get_effective_layout(self, obj: Pipeline) -> dict[str, Any]:
        """The layout this pipeline renders with: its own, or its parent's for a sub-pipeline."""
        return (obj.parent.layout if obj.parent_id and obj.parent else obj.layout) or {}


class TemplateSerializer(serializers.Serializer):
    key = serializers.CharField(read_only=True)
    name = serializers.CharField(read_only=True)
    description = serializers.CharField(read_only=True)
    stages = serializers.ListField(child=serializers.DictField(), read_only=True)


class StageInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    kind = serializers.ChoiceField(choices=PipelineStage.Kind.choices, required=False)
    default_probability = serializers.IntegerField(min_value=0, max_value=100, required=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    color_token = serializers.ChoiceField(choices=[(c, c) for c in STAGE_COLORS], required=False)


def _active_top_level_pipelines():
    return Pipeline.objects.filter(archived_at__isnull=True, parent__isnull=True)


class PipelineCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    stages = StageInputSerializer(many=True, required=False)
    template = serializers.ChoiceField(choices=[(k, k) for k in TEMPLATES], required=False)
    parent_id = TenantPrimaryKeyRelatedField(
        source="parent", model=Pipeline, queryset_fn=_active_top_level_pipelines, required=False, allow_null=True
    )
    layout = serializers.JSONField(required=False)
    restricted = serializers.BooleanField(required=False, default=False)


class PipelineUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    is_default = serializers.BooleanField(required=False)
    position = serializers.IntegerField(min_value=0, max_value=1000, required=False)
    layout = serializers.JSONField(required=False)
    restricted = serializers.BooleanField(required=False)


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
        "templates": "pipelines.view",
        "set_access": "pipelines.manage",
    }
    serializer_class = PipelineSerializer
    resolved_ordering = ("position", "id")

    def base_queryset(self):
        qs = Pipeline.objects.select_related("parent").prefetch_related("stages", "access_rules")
        if self.action == "list" and self.request.query_params.get("archived", "").lower() not in {"true", "1"}:
            qs = qs.filter(archived_at__isnull=True)
        return qs

    def _read(self, pipeline: Pipeline) -> dict:
        return PipelineSerializer(self.base_queryset().get(pk=pipeline.pk)).data

    def create(self, request):
        ser = PipelineCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        pipeline = services.create_pipeline(
            request.actor,
            name=data["name"],
            stages=data.get("stages"),
            template=data.get("template"),
            parent=data.get("parent"),
            layout=data.get("layout"),
            restricted=data.get("restricted", False),
            request=request._request,
        )
        return Response(self._read(pipeline), status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["get"])
    def templates(self, request):
        """The pipeline templates shipped with the product (original wording, DECISIONS M2.5)."""
        return Response({"results": TemplateSerializer(services.templates(), many=True).data})

    @action(detail=True, methods=["put"], url_path="access")
    def set_access(self, request, pk=None):
        """Replace the teams and hierarchy roles that may use this (restricted) pipeline."""
        pipeline = self.get_object()
        ser = PipelineAccessSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.set_access(
            request.actor,
            pipeline,
            team_ids=ser.validated_data["team_ids"],
            hierarchy_role_ids=ser.validated_data["hierarchy_role_ids"],
            request=request._request,
        )
        return Response(self._read(pipeline))

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
