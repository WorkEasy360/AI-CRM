from __future__ import annotations

from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api.filters import parse_uuid_list
from apps.core.api.viewsets import TenantAPIView, TenantViewSet
from apps.notifications import service
from apps.notifications.models import NOTIFICATION_KINDS, Notification, NotificationPreference


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = ["id", "kind", "title", "body", "entity_type", "entity_id", "read_at", "created_at"]
        read_only_fields = fields


class NotificationViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """A member's own notifications only. The recipient filter is applied before any scope logic."""

    permission_map = {
        "list": "notifications.view",
        "retrieve": "notifications.view",
        "read": "notifications.view",
        "read_all": "notifications.view",
        "unread_count": "notifications.view",
    }
    serializer_class = NotificationSerializer
    resolved_ordering = ("-created_at", "-id")

    def base_queryset(self):
        return Notification.objects.filter(recipient_id=self.request.actor.membership.id)

    def get_queryset(self):
        qs = self.base_queryset()
        if self.request.query_params.get("unread", "").lower() in {"true", "1"}:
            qs = qs.filter(read_at__isnull=True)
        return qs

    @action(detail=False, methods=["get"], url_path="unread-count")
    def unread_count(self, request):
        return Response({"count": service.unread_count(request.actor.membership.id)})

    @action(detail=False, methods=["post"])
    def read(self, request):
        ids = parse_uuid_list((request.data or {}).get("ids", []), max_items=200)
        updated = service.mark_read(request.actor.membership.id, ids)
        return Response({"updated": updated})

    @action(detail=False, methods=["post"], url_path="read-all")
    def read_all(self, request):
        updated = service.mark_read(request.actor.membership.id)
        return Response({"updated": updated})


class PreferenceSerializer(serializers.Serializer):
    in_app = serializers.DictField(child=serializers.BooleanField(), required=False)
    email = serializers.DictField(child=serializers.BooleanField(), required=False)
    deal_inactive_days = serializers.IntegerField(min_value=0, max_value=90, required=False)

    def validate_in_app(self, value):
        return _validate_kinds(value)

    def validate_email(self, value):
        return _validate_kinds(value)


def _validate_kinds(value: dict) -> dict:
    unknown = [k for k in value if k not in NOTIFICATION_KINDS]
    if unknown:
        raise serializers.ValidationError(f"Unknown notification kind: {', '.join(sorted(unknown))}.")
    return {k: bool(v) for k, v in value.items()}


def _payload(pref: NotificationPreference | None) -> dict:
    return {
        "kinds": list(NOTIFICATION_KINDS),
        "in_app": {k: service.wants(pref, "in_app", k) for k in NOTIFICATION_KINDS},
        "email": {k: service.wants(pref, "email", k) for k in NOTIFICATION_KINDS},
        "deal_inactive_days": pref.deal_inactive_days if pref else 14,
    }


class NotificationPreferenceView(TenantAPIView):
    permission_map = {"GET": "notifications.view", "PATCH": "notifications.view"}

    def get(self, request):
        return Response(_payload(service.preferences_for(request.actor.membership.id)))

    def patch(self, request):
        ser = PreferenceSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        pref, _ = NotificationPreference.objects.get_or_create(membership=request.actor.membership)
        data = ser.validated_data
        if "in_app" in data:
            pref.in_app = {**pref.in_app, **data["in_app"]}
        if "email" in data:
            pref.email = {**pref.email, **data["email"]}
        if "deal_inactive_days" in data:
            pref.deal_inactive_days = data["deal_inactive_days"]
        pref.save(update_fields=["in_app", "email", "deal_inactive_days", "updated_at"])
        return Response(_payload(pref), status=status.HTTP_200_OK)
