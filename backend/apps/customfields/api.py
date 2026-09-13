from __future__ import annotations

from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api.filters import Filter, FilterSet
from apps.core.api.viewsets import TenantViewSet
from apps.customfields import service
from apps.customfields.models import ENTITY_TYPES, CustomFieldDefinition


class CustomFieldDefinitionSerializer(serializers.ModelSerializer):
    class Meta:
        model = CustomFieldDefinition
        fields = [
            "id",
            "entity_type",
            "key",
            "label",
            "description",
            "field_type",
            "options",
            "is_required",
            "position",
            "archived_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class CustomFieldCreateSerializer(serializers.Serializer):
    entity_type = serializers.ChoiceField(choices=[(e, e) for e in ENTITY_TYPES])
    key = serializers.CharField(max_length=40)
    label = serializers.CharField(max_length=80)  # type: ignore[assignment]
    description = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")
    field_type = serializers.ChoiceField(choices=CustomFieldDefinition.FieldType.choices)
    options = serializers.ListField(child=serializers.CharField(max_length=80), required=False, max_length=100)
    is_required = serializers.BooleanField(required=False, default=False)


class CustomFieldUpdateSerializer(serializers.Serializer):
    label = serializers.CharField(max_length=80, required=False)  # type: ignore[assignment]
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    options = serializers.ListField(child=serializers.CharField(max_length=80), required=False, max_length=100)
    is_required = serializers.BooleanField(required=False)
    position = serializers.IntegerField(required=False, min_value=0, max_value=10_000)


FILTERS = FilterSet(
    filters={
        "entity_type": Filter("choice", "entity_type", choices=ENTITY_TYPES),
        "archived": Filter("isnull", "archived_at"),
    },
    sort_fields={"position": "position", "created_at": "created_at", "label": "label"},
    default_sort="position",
)


class CustomFieldDefinitionViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Definitions are tenant settings: anyone with ``customfields.view`` reads them (forms need them);
    ``customfields.manage`` (Owner/Admin) changes them."""

    permission_map = {
        "list": "customfields.view",
        "retrieve": "customfields.view",
        "create": "customfields.manage",
        "partial_update": "customfields.manage",
        "destroy": "customfields.manage",
        "restore": "customfields.manage",
    }
    serializer_class = CustomFieldDefinitionSerializer
    throttle_scope = "admin"
    resolved_ordering: tuple[str, ...] | None = None

    def base_queryset(self):
        return CustomFieldDefinition.objects.all()

    def filter_queryset(self, queryset):
        if self.action == "list":
            params = self.request.query_params.dict()
            # Archived definitions are hidden unless explicitly requested.
            if "archived" not in params:
                queryset = queryset.filter(archived_at__isnull=True)
            elif params["archived"].lower() in {"true", "1"}:
                queryset = queryset.filter(archived_at__isnull=False)
            queryset, ordering = FILTERS.apply(queryset, params, actor=self.request.actor)
            self.resolved_ordering = ordering
        return queryset

    def create(self, request):
        ser = CustomFieldCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        definition = service.create_definition(request.actor, request=request._request, **ser.validated_data)
        return Response(CustomFieldDefinitionSerializer(definition).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        definition = self.get_object()
        ser = CustomFieldUpdateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        definition = service.update_definition(
            request.actor, definition, request=request._request, **ser.validated_data
        )
        return Response(CustomFieldDefinitionSerializer(definition).data)

    def destroy(self, request, pk=None):
        definition = self.get_object()
        service.archive_definition(request.actor, definition, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        definition = self.get_object()
        if definition.archived_at is not None:
            definition.archived_at = None
            definition.save(update_fields=["archived_at", "updated_at"])
        return Response(CustomFieldDefinitionSerializer(definition).data)
