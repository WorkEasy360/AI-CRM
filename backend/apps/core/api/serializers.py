"""Serializer building blocks shared by the CRM modules."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from apps.accounts.models import Membership
from apps.core.api.fields import TenantPrimaryKeyRelatedField


class MembershipRefSerializer(serializers.Serializer):
    """Compact owner/author reference: never exposes email or role to record readers."""

    id = serializers.UUIDField(read_only=True)
    display_name = serializers.CharField(source="user.display_name", read_only=True)


def active_memberships():
    return Membership.objects.active().select_related("user")


def owner_field(**kwargs: Any) -> TenantPrimaryKeyRelatedField:
    """Writable ``owner_id``; the service decides whether the actor may assign someone else."""
    return TenantPrimaryKeyRelatedField(
        source="owner", model=Membership, queryset_fn=active_memberships, required=False, allow_null=True, **kwargs
    )


class CustomDataField(serializers.JSONField):
    """``custom_data`` input: validated by the customfields service against the entity's definitions."""

    def __init__(self, entity_type: str, **kwargs: Any) -> None:
        self.entity_type = entity_type
        kwargs.setdefault("required", False)
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> dict[str, Any]:
        from apps.customfields import service as customfields

        parent = self.parent
        partial = bool(getattr(parent, "partial", False))
        instance = getattr(parent, "instance", None)
        existing = getattr(instance, "custom_data", None) if instance is not None else None
        try:
            return customfields.validate_values(self.entity_type, data, partial=partial, existing=existing)
        except serializers.ValidationError as exc:
            detail = exc.detail
            if isinstance(detail, dict):
                raise serializers.ValidationError(
                    {k.removeprefix("custom_data."): v for k, v in detail.items()}
                ) from exc
            raise


class CrmReadSerializer(serializers.ModelSerializer):
    """Base read serializer: owner/tag/custom-field output resolved from batch-loaded context."""

    entity_type: str = ""

    owner = MembershipRefSerializer(read_only=True)
    tags = serializers.SerializerMethodField()
    custom_data = serializers.SerializerMethodField()

    def get_tags(self, obj: Any) -> Any:
        from apps.tagging.api import TagRefSerializer

        tags_map = self.context.get("tags_map")
        if tags_map is None:
            from apps.tagging import service as tagging

            tags_map = tagging.tags_for(self.entity_type, [obj.pk])
        return TagRefSerializer(tags_map.get(obj.pk, []), many=True).data

    def get_custom_data(self, obj: Any) -> dict[str, Any]:
        from apps.customfields import service as customfields

        definitions = self.context.get("custom_definitions")
        return customfields.public_values(self.entity_type, obj.custom_data, definitions)


class BulkActionSerializer(serializers.Serializer):
    ids = serializers.ListField(child=serializers.UUIDField(), min_length=1, max_length=500)
    action = serializers.ChoiceField(
        choices=[(a, a) for a in ("archive", "restore", "reassign", "add_tag", "remove_tag")]
    )
    payload = serializers.DictField(required=False, default=dict)


class TagIdsSerializer(serializers.Serializer):
    tag_ids = serializers.ListField(child=serializers.UUIDField(), max_length=50)
