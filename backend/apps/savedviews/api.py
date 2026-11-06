from __future__ import annotations

from typing import Any

from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api.serializers import MembershipRefSerializer
from apps.core.api.viewsets import TenantViewSet
from apps.core.concurrency import expected_version
from apps.savedviews import services
from apps.savedviews.models import SavedView


class SavedViewSerializer(serializers.ModelSerializer):
    """A view as the requesting member may use it (``for_viewer``), plus whether it is theirs/default."""

    owner = MembershipRefSerializer(read_only=True)
    is_owner = serializers.SerializerMethodField()
    is_default = serializers.SerializerMethodField()
    # True when some of the view's columns or filters use fields this viewer cannot see (left out).
    restricted = serializers.BooleanField(read_only=True, default=False)

    class Meta:
        model = SavedView
        fields = [
            "id",
            "entity_type",
            "name",
            "kind",
            "filters",
            "sort",
            "columns",
            "config",
            "visibility",
            "team_ids",
            "owner",
            "is_owner",
            "is_default",
            "restricted",
            "version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def to_representation(self, instance: SavedView) -> dict[str, Any]:
        data = super().to_representation(instance)
        usable = services.for_viewer(self.context["actor"], instance)
        data.update(
            filters=usable["filters"],
            columns=usable["columns"],
            config=usable["config"],
            sort=usable["sort"],
            restricted=usable["restricted"],
        )
        return data

    def get_is_owner(self, obj: SavedView) -> bool:
        return obj.owner_id == self.context["actor"].membership.pk

    def get_is_default(self, obj: SavedView) -> bool:
        return self.context.get("defaults", {}).get(obj.entity_type) == obj.pk


class SavedViewWriteSerializer(serializers.Serializer):
    entity_type = serializers.CharField(max_length=32, required=False)
    name = serializers.CharField(max_length=80, required=False)
    kind = serializers.ChoiceField(choices=SavedView.Kind.choices, required=False)
    filters = serializers.DictField(child=serializers.CharField(max_length=200, allow_blank=True), required=False)
    sort = serializers.CharField(max_length=64, required=False, allow_blank=True)
    columns = serializers.ListField(child=serializers.CharField(max_length=80), max_length=80, required=False)
    config = serializers.DictField(required=False)
    visibility = serializers.ChoiceField(choices=SavedView.Visibility.choices, required=False)
    team_ids = serializers.ListField(child=serializers.UUIDField(), max_length=50, required=False)


class ClearDefaultSerializer(serializers.Serializer):
    entity_type = serializers.CharField(max_length=32)


class SavedViewViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Saved views (``?entity_type=deal``). Visible: own, shared with everyone, or with one of my teams."""

    permission_map = {
        "list": "org.view",
        "retrieve": "org.view",
        "create": "org.view",
        "partial_update": "org.view",
        "destroy": "org.view",
        "set_default": "org.view",
        "clear_default": "org.view",
    }
    serializer_class = SavedViewSerializer
    resolved_ordering = ("name", "id")

    def base_queryset(self):
        return services.visible(self.request.actor)

    def get_queryset(self):
        # Visibility is the saved-view rule, not an ownership scope: ``visible`` is the whole answer.
        qs = services.visible(self.request.actor)
        entity_type = self.request.query_params.get("entity_type")
        if self.action == "list" and entity_type:
            qs = qs.filter(entity_type=entity_type[:32])
        return qs.order_by("entity_type", "name")

    def get_serializer_context(self) -> dict[str, Any]:
        ctx = dict(super().get_serializer_context())
        ctx["actor"] = self.request.actor
        ctx["defaults"] = services.default_ids(self.request.actor)
        return ctx

    def list(self, request, *args, **kwargs):
        rows = list(self.get_queryset()[:500])
        return Response({"results": SavedViewSerializer(rows, many=True, context=self.get_serializer_context()).data})

    def _read(self, view: SavedView) -> dict:
        return SavedViewSerializer(
            SavedView.objects.select_related("owner__user").get(pk=view.pk), context=self.get_serializer_context()
        ).data

    def create(self, request):
        ser = SavedViewWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = dict(ser.validated_data)
        if not data.get("entity_type") or not data.get("kind"):
            raise serializers.ValidationError({"entity_type": "entity_type and kind are required."})
        view = services.create_view(request.actor, data, request=request._request)
        return Response(self._read(view), status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        view = self.get_object()
        ser = SavedViewWriteSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        data = {k: v for k, v in ser.validated_data.items() if k not in {"entity_type", "kind"}}
        version = expected_version(request._request, request.data, required=False)
        services.update_view(request.actor, view, data, expected_version=version, request=request._request)
        return Response(self._read(view))

    def destroy(self, request, pk=None):
        view = self.get_object()
        services.delete_view(request.actor, view, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="default")
    def set_default(self, request, pk=None):
        view = self.get_object()
        services.set_default(request.actor, view, request=request._request)
        return Response(self._read(view))

    @action(detail=False, methods=["post"], url_path="default/clear")
    def clear_default(self, request):
        ser = ClearDefaultSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.clear_default(request.actor, ser.validated_data["entity_type"], request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)
