"""Test URL configuration: the real project URLs plus a test-only tenant resource (widgets)."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from config.urls import handler400, handler403, handler404, handler500  # noqa: F401 - re-exported
from config.urls import urlpatterns as project_urlpatterns
from tests.testapp.api import WidgetViewSet

test_router = DefaultRouter(trailing_slash=True)
test_router.include_root_view = False
test_router.include_format_suffixes = False
test_router.register("widgets", WidgetViewSet, basename="widget")

urlpatterns = [
    *project_urlpatterns,
    path("api/v1/", include(test_router.urls)),
]
