from __future__ import annotations

from django.shortcuts import get_object_or_404
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts.models import Membership
from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.viewsets import TenantViewSet
from apps.teams import services
from apps.teams.models import Team, TeamMembership


class TeamMemberSerializer(serializers.ModelSerializer):
    membership_id = serializers.UUIDField(source="membership.id", read_only=True)
    email = serializers.EmailField(source="membership.user.email", read_only=True)
    display_name = serializers.CharField(source="membership.user.display_name", read_only=True)

    class Meta:
        model = TeamMembership
        fields = ["membership_id", "email", "display_name"]
        read_only_fields = fields


def _active_memberships():
    return Membership.objects.active()


class TeamSerializer(serializers.ModelSerializer):
    manager_id = TenantPrimaryKeyRelatedField(
        source="manager", model=Membership, queryset_fn=_active_memberships, allow_null=True, required=False
    )
    member_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Team
        fields = ["id", "name", "manager_id", "member_count", "created_at", "updated_at"]
        read_only_fields = ["id", "member_count", "created_at", "updated_at"]

    def validate_name(self, value: str) -> str:
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Name is required.")
        return value


class TeamMembershipInputSerializer(serializers.Serializer):
    membership_id = TenantPrimaryKeyRelatedField(model=Membership, queryset_fn=_active_memberships)


class TeamViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "teams.view",
        "retrieve": "teams.view",
        "create": "teams.manage",
        "partial_update": "teams.manage",
        "destroy": "teams.manage",
        "add_member": "teams.manage",
        "remove_member": "teams.manage",
        "members": "teams.view",
    }
    serializer_class = TeamSerializer

    def base_queryset(self):
        from django.db.models import Count

        return Team.objects.select_related("manager__user").annotate(member_count=Count("members"))

    def create(self, request):
        ser = TeamSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        team = services.create_team(
            request.actor, name=ser.validated_data["name"], manager=ser.validated_data.get("manager"), request=request
        )
        team = self.get_queryset().get(pk=team.pk)
        return Response(TeamSerializer(team).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        team = self.get_object()
        ser = TeamSerializer(team, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        services.update_team(
            request.actor,
            team,
            name=data.get("name"),
            manager=data.get("manager"),
            clear_manager="manager" in data and data["manager"] is None,
            request=request,
        )
        team = self.get_queryset().get(pk=team.pk)
        return Response(TeamSerializer(team).data)

    def destroy(self, request, pk=None):
        team = self.get_object()
        services.delete_team(request.actor, team, request=request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"])
    def members(self, request, pk=None):
        team = self.get_object()
        qs = TeamMembership.objects.filter(team=team).select_related("membership__user")
        return Response({"results": TeamMemberSerializer(qs, many=True).data})

    @action(detail=True, methods=["post"], url_path="members/add")
    def add_member(self, request, pk=None):
        team = self.get_object()
        ser = TeamMembershipInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.add_member(request.actor, team, ser.validated_data["membership_id"], request=request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="members/remove")
    def remove_member(self, request, pk=None):
        team = self.get_object()
        ser = TeamMembershipInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        membership = get_object_or_404(Membership.objects.all(), pk=ser.validated_data["membership_id"].pk)
        services.remove_member(request.actor, team, membership, request=request)
        return Response(status=status.HTTP_204_NO_CONTENT)
