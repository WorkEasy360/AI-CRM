"""API v1 router. Every registered view must declare its permissions (enforced by tests)."""

from django.conf import settings
from django.urls import path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.routers import DefaultRouter

from apps.accounts.api import views as account_views
from apps.audit.api import AuditEventViewSet
from apps.authz.api import RolesView
from apps.teams.api import TeamViewSet

router = DefaultRouter(trailing_slash=True)
router.include_root_view = False
router.include_format_suffixes = False  # JSON only; no `.format` URL variants
router.register("members", account_views.MemberViewSet, basename="member")
router.register("invitations", account_views.InvitationViewSet, basename="invitation")
router.register("teams", TeamViewSet, basename="team")
router.register("audit-events", AuditEventViewSet, basename="audit-event")

_schema_permission = [AllowAny] if settings.DEBUG else [IsAuthenticated]

urlpatterns = [
    path("session/", account_views.SessionView.as_view(), name="session"),
    path("session/switch-organization/", account_views.SwitchOrganizationView.as_view(), name="session-switch"),
    path("organizations/", account_views.OrganizationCreateView.as_view(), name="organization-create"),
    path("organizations/current/", account_views.OrganizationCurrentView.as_view(), name="organization-current"),
    path("roles/", RolesView.as_view(), name="roles"),
    path("schema/", SpectacularAPIView.as_view(permission_classes=_schema_permission), name="schema"),
    path(
        "docs/",
        SpectacularSwaggerView.as_view(url_name="schema", permission_classes=_schema_permission),
        name="docs",
    ),
    *router.urls,
]
