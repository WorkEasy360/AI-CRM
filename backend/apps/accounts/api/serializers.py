from __future__ import annotations

from drf_spectacular.utils import extend_schema_field
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


class TeamRefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)


class MembershipSerializer(serializers.ModelSerializer):
    user = UserPublicSerializer(read_only=True)
    role = RoleRefSerializer(read_only=True)
    teams = serializers.SerializerMethodField()
    # A globally deactivated account shows as disabled whatever its membership says.
    display_status = serializers.SerializerMethodField()
    mfa_enabled = serializers.BooleanField(read_only=True, default=False)
    last_login = serializers.DateTimeField(source="user.last_login", read_only=True, allow_null=True)

    class Meta:
        model = Membership
        fields = [
            "id",
            "user",
            "role",
            "status",
            "display_status",
            "teams",
            "mfa_enabled",
            "last_login",
            "joined_at",
            "last_active_at",
            "created_at",
        ]
        read_only_fields = fields

    @extend_schema_field(TeamRefSerializer(many=True))
    def get_teams(self, obj: Membership) -> list[dict[str, str]]:
        # Uses the ``team_memberships`` prefetch from MemberViewSet.base_queryset (no per-row query).
        return [{"id": str(tm.team_id), "name": tm.team.name} for tm in obj.team_memberships.all()]

    @extend_schema_field(serializers.ChoiceField(choices=Membership.Status.choices))
    def get_display_status(self, obj: Membership) -> str:
        if not obj.user.is_active:
            return Membership.Status.DISABLED
        return obj.status


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
    team = TeamRefSerializer(read_only=True, allow_null=True)
    status = serializers.SerializerMethodField()
    invited_by = UserPublicSerializer(source="invited_by.user", read_only=True)

    class Meta:
        model = Invitation
        fields = [
            "id",
            "email",
            "name",
            "role",
            "team",
            "status",
            "expires_at",
            "invited_by",
            "send_count",
            "last_sent_at",
            "created_at",
        ]
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
    name = serializers.CharField(max_length=120, required=False, allow_blank=True, default="")
    team_id = serializers.UUIDField(required=False, allow_null=True, default=None)


class InvitationTokenSerializer(serializers.Serializer):
    token = serializers.CharField(max_length=128)


class InvitationRegisterSerializer(serializers.Serializer):
    """Everything else about the new account comes from the invitation row, never from the request."""

    token = serializers.CharField(max_length=128)
    name = serializers.CharField(max_length=120, required=False, allow_blank=True, default="")
    password = serializers.CharField(max_length=128, trim_whitespace=False, write_only=True)


class MemberTeamsSerializer(serializers.Serializer):
    team_ids = serializers.ListField(child=serializers.UUIDField(), max_length=50, allow_empty=True)
