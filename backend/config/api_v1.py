"""API v1 router. Every registered view must declare its permissions (enforced by tests)."""

from django.conf import settings
from django.urls import path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.routers import DefaultRouter

from apps.accounts.api import views as account_views
from apps.activities.api import ActivityViewSet
from apps.ai.api import (
    AIEmailDraftView,
    AIFollowUpView,
    AISettingsView,
    AIUsageView,
    ContactScoreView,
    DealSummaryView,
)
from apps.assistant.api import AskKeelView, AssistantHomeView, ConversationView
from apps.audit.api import AuditEventViewSet
from apps.authz.api import RolesView
from apps.companies.api import CompanyViewSet
from apps.contacts.api import ContactViewSet
from apps.customfields.api import CustomFieldDefinitionViewSet
from apps.dashboards.api import DashboardSummaryView
from apps.deals.api import DealViewSet
from apps.files.api import FileAttachmentViewSet
from apps.forecasting.api import ForecastView
from apps.importexport.api import (
    CompanyExportViewSet,
    CompanyImportViewSet,
    ContactExportViewSet,
    ContactImportViewSet,
    DealExportViewSet,
    ProductExportViewSet,
    ProductImportViewSet,
)
from apps.integrations.api import (
    ApiCredentialViewSet,
    ConnectionViewSet,
    InboundWebhookView,
    IntegrationCatalogView,
    IntegrationOAuthCallbackView,
    IntegrationOptionsView,
    WebhookSubscriptionViewSet,
)
from apps.messaging.api import (
    EmailAccountViewSet,
    EmailMessageViewSet,
    EmailTemplateViewSet,
    WhatsAppAccountView,
    WhatsAppMessageViewSet,
    WhatsAppTemplateViewSet,
)
from apps.messaging.webhooks import WhatsAppWebhookView
from apps.notes.api import NoteViewSet, TimelineView
from apps.notifications.api import NotificationPreferenceView, NotificationViewSet
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
router.register("files", FileAttachmentViewSet, basename="file")
router.register("imports/contacts", ContactImportViewSet, basename="import-contact")
router.register("imports/companies", CompanyImportViewSet, basename="import-company")
router.register("imports/products", ProductImportViewSet, basename="import-product")
router.register("exports/contacts", ContactExportViewSet, basename="export-contact")
router.register("exports/companies", CompanyExportViewSet, basename="export-company")
router.register("exports/products", ProductExportViewSet, basename="export-product")
router.register("exports/deals", DealExportViewSet, basename="export-deal")
# Sales operations
router.register("activities", ActivityViewSet, basename="activity")
router.register("notifications", NotificationViewSet, basename="notification")
# Communication
router.register("email/accounts", EmailAccountViewSet, basename="email-account")
router.register("email/templates", EmailTemplateViewSet, basename="email-template")
router.register("email/messages", EmailMessageViewSet, basename="email-message")
router.register("whatsapp/templates", WhatsAppTemplateViewSet, basename="whatsapp-template")
router.register("whatsapp/messages", WhatsAppMessageViewSet, basename="whatsapp-message")
# Integration Hub (Settings → Integrations)
router.register("integrations/connections", ConnectionViewSet, basename="integration-connection")
router.register("integrations/webhooks", WebhookSubscriptionViewSet, basename="integration-webhook")
router.register("integrations/api-credentials", ApiCredentialViewSet, basename="integration-api-credential")

_schema_permission = [AllowAny] if settings.DEBUG else [IsAuthenticated]

urlpatterns = [
    path("session/", account_views.SessionView.as_view(), name="session"),
    path("session/switch-organization/", account_views.SwitchOrganizationView.as_view(), name="session-switch"),
    path("session/bootstrap/", account_views.SessionBootstrapView.as_view(), name="session-bootstrap"),
    path("organizations/", account_views.OrganizationCreateView.as_view(), name="organization-create"),
    path("organizations/current/", account_views.OrganizationCurrentView.as_view(), name="organization-current"),
    path("roles/", RolesView.as_view(), name="roles"),
    path("search/", GlobalSearchView.as_view(), name="search"),
    path("dashboard/", DashboardSummaryView.as_view(), name="dashboard"),
    path("timeline/", TimelineView.as_view(), name="timeline"),
    path("forecast/", ForecastView.as_view(), name="forecast"),
    path("notifications/preferences/", NotificationPreferenceView.as_view(), name="notification-preferences"),
    path("whatsapp/account/", WhatsAppAccountView.as_view(), name="whatsapp-account"),
    path("whatsapp/webhook/", WhatsAppWebhookView.as_view(), name="whatsapp-webhook"),
    path("integrations/catalog/", IntegrationCatalogView.as_view(), name="integration-catalog"),
    path("integrations/options/", IntegrationOptionsView.as_view(), name="integration-options"),
    path("integrations/oauth/callback/", IntegrationOAuthCallbackView.as_view(), name="integration-oauth-callback"),
    path("integrations/inbound/<str:key>/", InboundWebhookView.as_view(), name="integration-inbound-webhook"),
    path("ai/deals/<uuid:deal_id>/summary/", DealSummaryView.as_view(), name="ai-deal-summary"),
    path("ai/contacts/<uuid:contact_id>/score/", ContactScoreView.as_view(), name="ai-contact-score"),
    path("ai/follow-up/", AIFollowUpView.as_view(), name="ai-follow-up"),
    path("ai/email/", AIEmailDraftView.as_view(), name="ai-email"),
    path("ai/usage/", AIUsageView.as_view(), name="ai-usage"),
    path("ai/settings/", AISettingsView.as_view(), name="ai-settings"),
    # Ask Keel: the single assistant entry point. One endpoint answers in every mode.
    path("assistant/ask/", AskKeelView.as_view(), name="assistant-ask"),
    path("assistant/home/", AssistantHomeView.as_view(), name="assistant-home"),
    path(
        "assistant/conversations/<uuid:conversation_id>/",
        ConversationView.as_view(),
        name="assistant-conversation",
    ),
    path("schema/", SpectacularAPIView.as_view(permission_classes=_schema_permission), name="schema"),
    path(
        "docs/",
        SpectacularSwaggerView.as_view(url_name="schema", permission_classes=_schema_permission),
        name="docs",
    ),
    *router.urls,
]
