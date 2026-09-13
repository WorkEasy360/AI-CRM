from __future__ import annotations

from django.db.models import Count
from rest_framework import mixins, serializers, status
from rest_framework.response import Response

from apps.core.api.viewsets import TenantViewSet
from apps.tagging import service
from apps.tagging.models import COLOR_TOKENS, Tag


class TagSerializer(serializers.ModelSerializer):
    usage_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Tag
        fields = ["id", "name", "color_token", "usage_count", "created_at"]
        read_only_fields = fields


class TagRefSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tag
        fields = ["id", "name", "color_token"]
        read_only_fields = fields


class TagInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=40, required=False)
    color_token = serializers.ChoiceField(choices=[(c, c) for c in COLOR_TOKENS], required=False)


class TagViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "tags.view",
        "retrieve": "tags.view",
        "create": "tags.manage",
        "partial_update": "tags.manage",
        "destroy": "tags.manage",
    }
    serializer_class = TagSerializer
    resolved_ordering = ("name", "id")

    def base_queryset(self):
        return Tag.objects.annotate(usage_count=Count("items")).order_by("name")

    def create(self, request):
        ser = TagInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        if "name" not in ser.validated_data:
            raise serializers.ValidationError({"name": "Name is required."})
        tag = service.create_tag(request.actor, request=request._request, **ser.validated_data)
        return Response(TagSerializer(self.base_queryset().get(pk=tag.pk)).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        tag = self.get_object()
        ser = TagInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        service.update_tag(request.actor, tag, request=request._request, **ser.validated_data)
        return Response(TagSerializer(self.base_queryset().get(pk=tag.pk)).data)

    def destroy(self, request, pk=None):
        tag = self.get_object()
        service.delete_tag(request.actor, tag, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)
