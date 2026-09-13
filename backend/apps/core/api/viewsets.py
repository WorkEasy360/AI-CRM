"""Base view classes. Every view must declare ``permission_map``; the default permission denies."""

from __future__ import annotations

from typing import Any, ClassVar

from django.db.models import QuerySet
from rest_framework import viewsets
from rest_framework.views import APIView

from apps.authz.permissions import RequirePermissions
from apps.authz.service import check, scope
from apps.core.api.request import ActorRequest


class TenantAPIView(APIView):
    """APIView keyed by HTTP method: ``permission_map = {"GET": "x.view", "PATCH": "x.update"}``."""

    request: ActorRequest
    permission_classes = [RequirePermissions]
    permission_map: ClassVar[dict[str, str]] = {}


class TenantViewSet(viewsets.GenericViewSet):
    """GenericViewSet keyed by action.

    - ``list`` is scoped by the action's permission.
    - Detail actions look the object up within the *view* scope (so a record the actor may see but
      not modify answers 403, and a record outside the view scope answers 404), then ``check()`` the
      action's permission against the object.
    """

    request: ActorRequest
    permission_classes = [RequirePermissions]
    permission_map: ClassVar[dict[str, str]] = {}

    def base_queryset(self) -> QuerySet:  # pragma: no cover - overridden
        raise NotImplementedError

    def current_permission(self) -> str:
        return self.permission_map[self.action]

    def view_permission(self) -> str:
        return self.permission_map.get("retrieve", self.current_permission())

    def get_queryset(self) -> QuerySet:
        permission = self.current_permission() if self.action == "list" else self.view_permission()
        return scope(self.request.actor, permission, self.base_queryset())

    def get_object(self) -> Any:
        obj = super().get_object()
        check(self.request.actor, self.current_permission(), obj)
        return obj
