from django.http import JsonResponse
from django.urls import include, path

from apps.core.api import views as core_views


def _problem(status: int, title: str, type_: str):
    def handler(request, exception=None):
        return JsonResponse(
            {"type": type_, "title": title, "status": status, "request_id": getattr(request, "request_id", None)},
            status=status,
        )

    return handler


handler400 = _problem(400, "Bad request", "bad_request")
handler403 = _problem(403, "Forbidden", "forbidden")
handler404 = _problem(404, "Not found", "not_found")
handler500 = _problem(500, "Internal server error", "server_error")

urlpatterns = [
    path("health/", core_views.health, name="health"),
    path("ready/", core_views.ready, name="ready"),
    path("_allauth/", include("allauth.headless.urls")),
    path("api/v1/", include("config.api_v1")),
]
