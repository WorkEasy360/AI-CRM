from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET

from apps.core import health as probes


@require_GET
def health(request: HttpRequest) -> JsonResponse:
    """Liveness: the process accepts requests."""
    return probes.liveness(request)


@require_GET
def ready(request: HttpRequest) -> JsonResponse:
    """Readiness: the process can serve traffic (database reachable). Reveals nothing about dependencies."""
    return probes.readiness(request)
