from django.core.cache import cache
from django.db import connection
from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET


@require_GET
def health(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"status": "ok"})


@require_GET
def ready(request: HttpRequest) -> JsonResponse:
    """Readiness probe: checks database and cache but reveals nothing about them."""
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT 1")
        cache.set("readiness-probe", "1", 5)
        ok = cache.get("readiness-probe") == "1"
    except Exception:
        ok = False
    return JsonResponse({"status": "ok" if ok else "unavailable"}, status=200 if ok else 503)
