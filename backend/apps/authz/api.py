from rest_framework.request import Request
from rest_framework.response import Response

from apps.authz.roles import ROLE_ORDER, SYSTEM_ROLES
from apps.core.api.viewsets import TenantAPIView


class RolesView(TenantAPIView):
    permission_map = {"GET": "roles.view"}

    def get(self, request: Request) -> Response:
        data = [
            {
                "key": key,
                "name": SYSTEM_ROLES[key].name,
                "description": SYSTEM_ROLES[key].description,
                "is_system": True,
                "grants": dict(SYSTEM_ROLES[key].grants),
            }
            for key in ROLE_ORDER
        ]
        return Response({"results": data})
