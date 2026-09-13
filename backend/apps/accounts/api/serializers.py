from __future__ import annotations

from rest_framework import serializers

from apps.accounts.models import Invitation, Membership, Organization
from apps.authz.roles import ROLE_ORDER


class UserPublicSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    email = serializers.EmailField(read_only=True)
    display_name = serializers.CharField(read_only=True)


class OrganizationSerializer(serializers.ModelSerializer):
    require_mfa = serializers.BooleanField(read_only=True)

    class Meta:
        model = Organization
        fields = ["id", "name", "slug", "base_currency", "timezone", "plan", "status", "require_mfa", "created_at"]
        read_only_fields = fields


class OrganizationCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    base_currency = serializers.CharField(max_length=3, required=False, default="INR")
    timezone = serializers.CharField(max_length=64, required=False, default="Asia/Kolkata")


class OrganizationUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, required=False)
    base_currency = serializers.CharField(max_length=3, required=False)
    timezone = serializers.CharField(max_length=64, required=False)
    require_mfa = serializers.BooleanField(required=False)


class RoleRefSerializer(serializers.Serializer):
    key = serializers.CharField(read_only=True)
    name = serializers.CharField(read_only=True)


class MembershipSerializer(serializers.ModelSerializer):
    user = UserPublicSerializer(read_only=True)
    role = RoleRefSerializer(read_only=True)

    class Meta:
        model = Membership
        fields = ["id", "user", "role", "status", "joined_at", "last_active_at", "created_at"]
        read_only_fields = fields


class MembershipSummarySerializer(serializers.ModelSerializer):
    organization = OrganizationSerializer(read_only=True)
    role = RoleRefSerializer(read_only=True)

    class Meta:
        model = Membership
        fields = ["id", "organization", "role", "status"]
        read_only_fields = fields


class RoleChangeSerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=[(k, k) for k in ROLE_ORDER])


class SwitchOrganizationSerializer(serializers.Serializer):
    membership_id = serializers.UUIDField()


class InvitationSerializer(serializers.ModelSerializer):
    role = RoleRefSerializer(read_only=True)
    status = serializers.SerializerMethodField()
    invited_by = UserPublicSerializer(source="invited_by.user", read_only=True)

    class Meta:
        model = Invitation
        fields = ["id", "email", "role", "status", "expires_at", "invited_by", "created_at"]
        read_only_fields = fields

    def get_status(self, obj: Invitation) -> str:
        if obj.accepted_at:
            return "accepted"
        if obj.revoked_at:
            return "revoked"
        return "pending" if obj.is_pending else "expired"


class InvitationCreateSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)
    role = serializers.ChoiceField(choices=[(k, k) for k in ROLE_ORDER])


class InvitationTokenSerializer(serializers.Serializer):
    token = serializers.CharField(max_length=128)
