"""API v1 router. Every registered view must declare its permissions (enforced by tests)."""

from django.conf import settings
from django.urls import path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.routers import DefaultRouter

from apps.accounts.api import views as account_views
from apps.audit.api import AuditEventViewSet
from apps.authz.api import RolesView
from apps.companies.api import CompanyViewSet
from apps.contacts.api import ContactViewSet
from apps.customfields.api import CustomFieldDefinitionViewSet
from apps.deals.api import DealViewSet
from apps.importexport.api import (
    CompanyExportViewSet,
    CompanyImportViewSet,
    ContactExportViewSet,
    ContactImportViewSet,
    DealExportViewSet,
    ProductExportViewSet,
    ProductImportViewSet,
)
from apps.notes.api import NoteViewSet, TimelineView
from apps.pipelines.api import PipelineStageViewSet, PipelineViewSet
from apps.products.api import ProductViewSet
from apps.search.api import GlobalSearchView
from apps.tagging.api import TagViewSet
from apps.teams.api import TeamViewSet

router = DefaultRouter(trailing_slash=True)
router.include_root_view = False
router.include_format_suffixes = False  # JSON only; no `.format` URL variants
router.register("members", account_views.MemberViewSet, basename="member")
router.register("invitations", account_views.InvitationViewSet, basename="invitation")
router.register("teams", TeamViewSet, basename="team")
router.register("audit-events", AuditEventViewSet, basename="audit-event")
# CRM core (Phase 2)
router.register("companies", CompanyViewSet, basename="company")
router.register("contacts", ContactViewSet, basename="contact")
router.register("products", ProductViewSet, basename="product")
router.register("pipelines", PipelineViewSet, basename="pipeline")
router.register("stages", PipelineStageViewSet, basename="stage")
router.register("deals", DealViewSet, basename="deal")
router.register("custom-fields", CustomFieldDefinitionViewSet, basename="custom-field")
router.register("tags", TagViewSet, basename="tag")
router.register("notes", NoteViewSet, basename="note")
router.register("imports/contacts", ContactImportViewSet, basename="import-contact")
router.register("imports/companies", CompanyImportViewSet, basename="import-company")
router.register("imports/products", ProductImportViewSet, basename="import-product")
router.register("exports/contacts", ContactExportViewSet, basename="export-contact")
router.register("exports/companies", CompanyExportViewSet, basename="export-company")
router.register("exports/products", ProductExportViewSet, basename="export-product")
router.register("exports/deals", DealExportViewSet, basename="export-deal")

_schema_permission = [AllowAny] if settings.DEBUG else [IsAuthenticated]

urlpatterns = [
    path("session/", account_views.SessionView.as_view(), name="session"),
    path("session/switch-organization/", account_views.SwitchOrganizationView.as_view(), name="session-switch"),
    path("organizations/", account_views.OrganizationCreateView.as_view(), name="organization-create"),
    path("organizations/current/", account_views.OrganizationCurrentView.as_view(), name="organization-current"),
    path("roles/", RolesView.as_view(), name="roles"),
    path("search/", GlobalSearchView.as_view(), name="search"),
    path("timeline/", TimelineView.as_view(), name="timeline"),
    path("schema/", SpectacularAPIView.as_view(permission_classes=_schema_permission), name="schema"),
    path(
        "docs/",
        SpectacularSwaggerView.as_view(url_name="schema", permission_classes=_schema_permission),
        name="docs",
    ),
    *router.urls,
]
