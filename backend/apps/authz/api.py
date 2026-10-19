from __future__ import annotations

from django.db.models import Count, Q
from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts.models import Membership
from apps.authz import fields as field_rules
from apps.authz import hierarchy, profiles
from apps.authz.catalogue import PERMISSIONS, SCOPES
from apps.authz.models import FieldPermission, HierarchyRole, Role
from apps.authz.roles import ROLE_ORDER, SYSTEM_ROLES
from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.request import ActorRequest
from apps.core.api.viewsets import TenantAPIView, TenantViewSet


def _role_payload(role: Role, member_count: int = 0) -> dict:
    if role.is_system:
        definition = SYSTEM_ROLES[role.key]
        return {
            "key": role.key,
            "name": definition.name,
            "description": definition.description,
            "is_system": True,
            "grants": dict(definition.grants),
            "member_count": member_count,
        }
    return {
        "key": role.key,
        "name": role.name,
        "description": role.description,
        "is_system": False,
        "grants": {g.permission: g.scope for g in role.grants.all()},
        "member_count": member_count,
    }


def _get_role(request: ActorRequest, key: str) -> Role:
    role = (
        Role.objects.filter(key=key)
        .filter(Q(organization__isnull=True) | Q(organization_id=request.actor.organization.pk))
        .prefetch_related("grants")
        .first()
    )
    if role is None:
        raise Http404
    return role


class PermissionSetSerializer(serializers.Serializer):
    key = serializers.CharField()
    name = serializers.CharField()
    description = serializers.CharField()
    is_system = serializers.BooleanField()
    grants = serializers.DictField(child=serializers.ChoiceField(choices=list(SCOPES)))
    member_count = serializers.IntegerField()


class PermissionSetListSerializer(serializers.Serializer):
    results = PermissionSetSerializer(many=True)
    permissions = serializers.ListField(child=serializers.CharField())
    scopes = serializers.ListField(child=serializers.ChoiceField(choices=list(SCOPES)))


class ProfileInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    grants = serializers.DictField(child=serializers.ChoiceField(choices=list(SCOPES)), required=False)
    clone_from = serializers.SlugField(max_length=40, required=False)


class RolesView(TenantAPIView):
    """System roles and the organization's custom permission sets ("profiles")."""

    permission_map = {"GET": "roles.view", "POST": "roles.manage"}

    @extend_schema(responses=PermissionSetListSerializer, summary="System and custom permission sets")
    def get(self, request: ActorRequest) -> Response:
        counts = dict(Membership.objects.active().values("role_id").annotate(n=Count("id")).values_list("role_id", "n"))
        system = {r.key: r for r in Role.objects.filter(organization__isnull=True, is_system=True)}
        data = [_role_payload(system[k], counts.get(system[k].pk, 0)) for k in ROLE_ORDER if k in system]
        custom = (
            Role.objects.filter(organization_id=request.actor.organization.pk, is_system=False)
            .prefetch_related("grants")
            .order_by("name")
        )
        data += [_role_payload(r, counts.get(r.pk, 0)) for r in custom]
        return Response({"results": data, "permissions": sorted(PERMISSIONS), "scopes": list(SCOPES)})

    @extend_schema(request=ProfileInputSerializer, responses=PermissionSetSerializer, summary="Create a permission set")
    def post(self, request: ActorRequest) -> Response:
        ser = ProfileInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if not data.get("name"):
            raise serializers.ValidationError({"name": "Name is required."})
        role = profiles.create_profile(
            request.actor,
            name=data["name"],
            description=data.get("description", ""),
            grants=data.get("grants"),
            clone_from=data.get("clone_from", ""),
            request=request._request,
        )
        return Response(_role_payload(role), status=status.HTTP_201_CREATED)


class RoleDetailView(TenantAPIView):
    permission_map = {"GET": "roles.view", "PATCH": "roles.manage", "DELETE": "roles.manage"}

    @extend_schema(responses=PermissionSetSerializer, operation_id="roles_detail_retrieve")
    def get(self, request: ActorRequest, key: str) -> Response:
        return Response(_role_payload(_get_role(request, key)))

    @extend_schema(request=ProfileInputSerializer, responses=PermissionSetSerializer)
    def patch(self, request: ActorRequest, key: str) -> Response:
        ser = ProfileInputSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        changes = {k: v for k, v in ser.validated_data.items() if k in {"name", "description", "grants"}}
        role = profiles.update_profile(request.actor, _get_role(request, key), request=request._request, **changes)
        return Response(_role_payload(_get_role(request, role.key)))

    @extend_schema(responses={204: None})
    def delete(self, request: ActorRequest, key: str) -> Response:
        profiles.delete_profile(request.actor, _get_role(request, key), request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class FieldRuleSerializer(serializers.Serializer):
    field = serializers.CharField(max_length=80)
    access = serializers.ChoiceField(choices=[field_rules.HIDDEN, field_rules.READ_ONLY])


class FieldRulesInputSerializer(serializers.Serializer):
    entity_type = serializers.ChoiceField(choices=list(field_rules.ENTITY_TYPES))
    rules = serializers.ListField(child=FieldRuleSerializer(), max_length=200)


class FieldPermissionsView(TenantAPIView):
    """Field-level read/write restrictions of one permission set."""

    permission_map = {"GET": "roles.view", "PUT": "roles.manage"}

    @extend_schema(responses=FieldRulesInputSerializer(many=True), summary="Field rules of a permission set")
    def get(self, request: ActorRequest, key: str) -> Response:
        role = _get_role(request, key)
        rows = FieldPermission.objects.filter(role_id=role.pk).order_by("entity_type", "field")
        result: dict[str, list[dict[str, str]]] = {e: [] for e in field_rules.ENTITY_TYPES}
        for row in rows:
            result.setdefault(row.entity_type, []).append({"field": row.field, "access": row.access})
        return Response({"role": role.key, "rules": result})

    @extend_schema(
        request=FieldRulesInputSerializer, responses=FieldRulesInputSerializer, summary="Replace field rules"
    )
    def put(self, request: ActorRequest, key: str) -> Response:
        ser = FieldRulesInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        cleaned = field_rules.set_rules(
            request.actor,
            _get_role(request, key),
            entity_type=ser.validated_data["entity_type"],
            rules=ser.validated_data["rules"],
            request=request._request,
        )
        return Response(
            {"entity_type": ser.validated_data["entity_type"], "rules": [{"field": f, "access": a} for f, a in cleaned]}
        )


# ----------------------------------------------------------------------------- hierarchy


def _hierarchy_roles():
    return HierarchyRole.objects.all()


class HierarchyRoleSerializer(serializers.ModelSerializer):
    parent_id = TenantPrimaryKeyRelatedField(
        source="parent", model=HierarchyRole, queryset_fn=_hierarchy_roles, allow_null=True, required=False
    )
    member_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = HierarchyRole
        fields = ["id", "name", "description", "parent_id", "share_with_peers", "member_count", "created_at"]
        read_only_fields = ["id", "member_count", "created_at"]


class HierarchyAssignSerializer(serializers.Serializer):
    membership_id = TenantPrimaryKeyRelatedField(model=Membership, queryset_fn=lambda: Membership.objects.all())
    hierarchy_role_id = TenantPrimaryKeyRelatedField(model=HierarchyRole, queryset_fn=_hierarchy_roles, allow_null=True)


class HierarchyRoleViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """The reporting hierarchy that the "subordinates" scope follows."""

    permission_map = {
        "list": "roles.view",
        "retrieve": "roles.view",
        "create": "roles.manage",
        "partial_update": "roles.manage",
        "destroy": "roles.manage",
        "assign": "roles.manage",
    }
    serializer_class = HierarchyRoleSerializer
    pagination_class = None

    def base_queryset(self):
        return HierarchyRole.objects.annotate(member_count=Count("memberships")).order_by("name")

    def list(self, request):
        # The whole tree in one response (at most MAX_HIERARCHY_ROLES rows): the UI renders it as a tree.
        return Response({"results": HierarchyRoleSerializer(self.get_queryset(), many=True).data})

    def create(self, request):
        ser = HierarchyRoleSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        role = hierarchy.create_role(
            request.actor,
            name=data["name"],
            parent=data.get("parent"),
            description=data.get("description", ""),
            share_with_peers=data.get("share_with_peers", False),
            request=request._request,
        )
        return Response(HierarchyRoleSerializer(self.base_queryset().get(pk=role.pk)).data, status=201)

    def partial_update(self, request, pk=None):
        role = self.get_object()
        ser = HierarchyRoleSerializer(role, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        hierarchy.update_role(request.actor, role, request=request._request, **ser.validated_data)
        return Response(HierarchyRoleSerializer(self.base_queryset().get(pk=role.pk)).data)

    def destroy(self, request, pk=None):
        hierarchy.delete_role(request.actor, self.get_object(), request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @extend_schema(request=HierarchyAssignSerializer, responses=HierarchyAssignSerializer)
    @action(detail=False, methods=["post"])
    def assign(self, request):
        ser = HierarchyAssignSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        membership = hierarchy.assign_member(
            request.actor,
            ser.validated_data["membership_id"],
            ser.validated_data["hierarchy_role_id"],
            request=request._request,
        )
        return Response({"membership_id": str(membership.pk), "hierarchy_role_id": membership.hierarchy_role_id})
