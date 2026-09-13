from __future__ import annotations

from django.utils.dateparse import parse_datetime
from rest_framework import mixins, serializers
from rest_framework.exceptions import ValidationError

from apps.audit.models import AuditEvent
from apps.core.api.viewsets import TenantViewSet

ALLOWED_FILTERS = {"action", "actor_user", "resource_type", "resource_id"}


class AuditEventSerializer(serializers.ModelSerializer):
    actor_user_id = serializers.UUIDField(read_only=True)
    actor_email = serializers.SerializerMethodField()

    class Meta:
        model = AuditEvent
        fields = [
            "id",
            "action",
            "actor_type",
            "actor_user_id",
            "actor_email",
            "resource_type",
            "resource_id",
            "ip",
            "request_id",
            "metadata",
            "created_at",
        ]
        read_only_fields = fields

    def get_actor_email(self, obj: AuditEvent) -> str | None:
        return obj.actor_user.email if obj.actor_user_id and obj.actor_user else None


class AuditEventViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {"list": "audit.view", "retrieve": "audit.view"}
    serializer_class = AuditEventSerializer
    throttle_scope = "admin"

    def base_queryset(self):
        qs = AuditEvent.objects.select_related("actor_user")
        params = self.request.query_params
        for key in ALLOWED_FILTERS:
            value = params.get(key)
            if value:
                qs = qs.filter(**{key: value[:64]})
        since, until = params.get("since"), params.get("until")
        if since:
            dt = parse_datetime(since)
            if dt is None:
                raise ValidationError({"since": "Invalid datetime."})
            qs = qs.filter(created_at__gte=dt)
        if until:
            dt = parse_datetime(until)
            if dt is None:
                raise ValidationError({"until": "Invalid datetime."})
            qs = qs.filter(created_at__lte=dt)
        return qs
