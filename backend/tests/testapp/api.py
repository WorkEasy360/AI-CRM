from rest_framework import mixins, serializers, status
from rest_framework.response import Response

from apps.authz.service import check
from apps.core.api.viewsets import TenantViewSet
from tests.testapp.models import Widget


class WidgetSerializer(serializers.ModelSerializer):
    owner_id = serializers.UUIDField(read_only=True)

    class Meta:
        model = Widget
        fields = ["id", "name", "owner_id", "created_at"]
        read_only_fields = ["id", "owner_id", "created_at"]


class WidgetViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin, mixins.DestroyModelMixin, TenantViewSet
):
    permission_map = {
        "list": "contacts.view",
        "retrieve": "contacts.view",
        "create": "contacts.create",
        "update": "contacts.update",
        "partial_update": "contacts.update",
        "destroy": "contacts.delete",
    }
    serializer_class = WidgetSerializer

    def base_queryset(self):
        return Widget.objects.all()

    def create(self, request):
        ser = WidgetSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        check(request.actor, "contacts.create")
        widget = Widget.objects.create(name=ser.validated_data["name"], owner=request.actor.membership)
        return Response(WidgetSerializer(widget).data, status=status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        check(self.request.actor, "contacts.update", serializer.instance)
        serializer.save()

    def perform_destroy(self, instance):
        check(self.request.actor, "contacts.delete", instance)
        instance.delete()
