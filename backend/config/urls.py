from django.http import JsonResponse
from django.urls import include, path
from workeasy360_sso import views as workeasy360_sso_views
from workeasy360_sso.urls import namespaced

from apps.accounts.workeasy360 import views as workeasy360_views
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
    path("health/live/", core_views.health, name="health-live"),
    path("health/ready/", core_views.ready, name="health-ready"),
    path("health/", core_views.health, name="health"),  # alias
    path("ready/", core_views.ready, name="ready"),  # alias
    path("_allauth/", include("allauth.headless.urls")),
    # Sign in with Workeasy360 (docs/workeasy360-sso.md). Start and callback are browser navigations, not API
    # calls; the callback path is the redirect URI registered in Workeasy360, so it must not change. They are
    # the workeasy360_sso connector's routes (its checks and manifest find them by name), served by Keel's views.
    # Back-channel logout is the connector's receiver, server to server from Workeasy360; it must stay under
    # /api/ (the only prefix the production edge routes to Django) and on the redirect URI's origin.
    namespaced(
        path("api/auth/workeasy360/start", workeasy360_views.start, name="start"),
        path("api/auth/callback/workeasy360", workeasy360_views.callback, name="callback"),
        path(
            "api/auth/workeasy360/backchannel-logout",
            workeasy360_sso_views.backchannel_logout,
            name="backchannel_logout",
        ),
    ),
    path("api/auth/workeasy360/logout", workeasy360_views.end_session, name="workeasy360-end-session"),
    path("api/v1/", include("config.api_v1")),
]
