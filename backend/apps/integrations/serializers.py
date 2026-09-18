"""Integration Hub serializers. Read serializers list their fields explicitly: no ``*_enc`` column, secret
hash, token or raw provider error can ever be serialized. Error *codes* are translated into messages."""

from __future__ import annotations

from typing import Any

from django.utils import timezone
from rest_framework import serializers

from apps.integrations import credentials as sealed
from apps.integrations import errors
from apps.integrations.models import (
    ApiCredential,
    IntegrationConnection,
    OutboundDelivery,
    SyncConflict,
    SyncJob,
    WebhookSubscription,
)
from apps.integrations.providers import get_provider
from apps.integrations.providers.base import ProviderError


def _provider_name(key: str) -> str:
    try:
        return get_provider(key).name
    except ProviderError:
        return "Integration"


class MemberRefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    display_name = serializers.CharField(source="user.display_name", read_only=True)


class ConnectionSerializer(serializers.ModelSerializer):
    provider_name = serializers.SerializerMethodField()
    status_message = serializers.SerializerMethodField()
    last_error_message = serializers.SerializerMethodField()
    credentials_configured = serializers.SerializerMethodField()
    connected_by = MemberRefSerializer(read_only=True, allow_null=True)

    class Meta:
        model = IntegrationConnection
        fields = [
            "id",
            "provider",
            "provider_name",
            "name",
            "status",
            "status_message",
            "auth_type",
            "config",
            "credentials_configured",
            "conflict_strategy",
            "sync_interval_minutes",
            "next_sync_at",
            "inbound_enabled",
            "connected_by",
            "connected_at",
            "disconnected_at",
            "last_sync_at",
            "last_success_at",
            "last_error_code",
            "last_error_message",
            "last_error_at",
            "consecutive_failures",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_provider_name(self, obj: IntegrationConnection) -> str:
        return _provider_name(obj.provider)

    def get_last_error_message(self, obj: IntegrationConnection) -> str:
        return errors.message_for(obj.last_error_code, _provider_name(obj.provider))

    def get_status_message(self, obj: IntegrationConnection) -> str:
        name = _provider_name(obj.provider)
        if obj.status in ("action_required", "error") and obj.last_error_code:
            return errors.message_for(obj.last_error_code, name)
        return {
            "connected": "Connected",
            "disconnected": "Disconnected",
            "action_required": f"Finish connecting to {name}.",
            "syncing": "Syncing…",
            "error": f"{name} reported a problem.",
            "disabled": "Paused",
        }.get(obj.status, obj.status)

    def get_credentials_configured(self, obj: IntegrationConnection) -> list[str]:
        # Names of stored credential fields only ("api_key"), so the UI can show "Configured".
        return sealed.redacted_keys(obj.credentials_enc)


class ConnectionCreateSerializer(serializers.Serializer):
    provider = serializers.CharField(max_length=32)
    name = serializers.CharField(max_length=80)
    auth_type = serializers.CharField(max_length=32)
    config = serializers.JSONField(required=False, default=dict)
    credentials = serializers.JSONField(required=False, default=dict, write_only=True)


class ConnectionUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    config = serializers.JSONField(required=False)
    conflict_strategy = serializers.CharField(max_length=16, required=False)
    sync_interval_minutes = serializers.IntegerField(min_value=0, required=False)


class CredentialsSerializer(serializers.Serializer):
    credentials = serializers.JSONField(write_only=True)


class MappingSerializer(serializers.Serializer):
    crm_field = serializers.CharField(max_length=80)
    external_field = serializers.CharField(max_length=128)


class SharingInputSerializer(serializers.Serializer):
    entity_type = serializers.CharField(max_length=16)
    direction = serializers.CharField(max_length=8)
    external_resource = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")
    mappings = MappingSerializer(many=True, required=False, default=list)

    def validate_mappings(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if len(value) > 100:
            raise serializers.ValidationError("At most 100 field mappings.")
        return value


class SyncJobSerializer(serializers.ModelSerializer):
    error_message = serializers.SerializerMethodField()
    # A declared field, moved off the class by DRF's metaclass: it does not shadow Serializer.errors at runtime.
    errors = serializers.SerializerMethodField()  # type: ignore[assignment]

    class Meta:
        model = SyncJob
        fields = [
            "id",
            "trigger",
            "status",
            "processed",
            "succeeded",
            "failed",
            "conflicts",
            "errors",
            "error_code",
            "error_message",
            "started_at",
            "finished_at",
            "created_at",
        ]
        read_only_fields = fields

    def get_error_message(self, obj: SyncJob) -> str:
        return errors.message_for(obj.error_code, _provider_name(obj.connection.provider)) if obj.error_code else ""

    def get_errors(self, obj: SyncJob) -> list[dict[str, str]]:
        name = _provider_name(obj.connection.provider)
        return [
            {
                "entity_type": str(e.get("entity_type", "")),
                "record_id": str(e.get("record_id", "")),
                "code": str(e.get("code", "")),
                "message": errors.message_for(str(e.get("code", "")), name),
            }
            for e in (obj.errors or [])
        ]


class ConflictSerializer(serializers.ModelSerializer):
    class Meta:
        model = SyncConflict
        fields = [
            "id",
            "entity_type",
            "crm_record_id",
            "external_record_id",
            "fields",
            "external_values",
            "status",
            "resolved_at",
            "created_at",
        ]
        read_only_fields = fields


class ConflictResolutionSerializer(serializers.Serializer):
    resolution = serializers.ChoiceField(choices=["keep_crm", "apply_external"])


class DeliverySerializer(serializers.ModelSerializer):
    class Meta:
        model = OutboundDelivery
        fields = [
            "id",
            "event_id",
            "event_type",
            "entity_type",
            "entity_id",
            "status",
            "attempts",
            "next_attempt_at",
            "response_status",
            "error_code",
            "delivered_at",
            "created_at",
        ]
        read_only_fields = fields


class WebhookSubscriptionSerializer(serializers.ModelSerializer):
    created_by = MemberRefSerializer(read_only=True, allow_null=True)
    rotation_in_progress = serializers.SerializerMethodField()

    class Meta:
        model = WebhookSubscription
        fields = [
            "id",
            "name",
            "url",
            "event_types",
            "include_data",
            "status",
            "consecutive_failures",
            "last_success_at",
            "last_failure_at",
            "last_error_code",
            "rotation_in_progress",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_rotation_in_progress(self, obj: WebhookSubscription) -> bool:
        return bool(obj.previous_secret_expires_at and obj.previous_secret_expires_at > timezone.now())


class WebhookCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    url = serializers.CharField(max_length=2048)
    event_types = serializers.ListField(child=serializers.CharField(max_length=40), max_length=20)
    include_data = serializers.BooleanField(required=False, default=False)


class WebhookUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    url = serializers.CharField(max_length=2048, required=False)
    event_types = serializers.ListField(child=serializers.CharField(max_length=40), max_length=20, required=False)
    include_data = serializers.BooleanField(required=False)


class ApiCredentialSerializer(serializers.ModelSerializer):
    created_by = MemberRefSerializer(read_only=True, allow_null=True)
    status = serializers.SerializerMethodField()
    display_key = serializers.SerializerMethodField()

    class Meta:
        model = ApiCredential
        fields = [
            "id",
            "name",
            "display_key",
            "scopes",
            "status",
            "created_by",
            "created_at",
            "expires_at",
            "last_used_at",
            "revoked_at",
        ]
        read_only_fields = fields

    def get_status(self, obj: ApiCredential) -> str:
        if obj.revoked_at:
            return "revoked"
        if obj.expires_at and obj.expires_at <= timezone.now():
            return "expired"
        return "active"

    def get_display_key(self, obj: ApiCredential) -> str:
        return f"keel_{obj.prefix}_••••"


class ApiCredentialCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    scopes = serializers.ListField(child=serializers.CharField(max_length=40), max_length=20)
    expires_in_days = serializers.IntegerField(required=False, allow_null=True, default=90)
