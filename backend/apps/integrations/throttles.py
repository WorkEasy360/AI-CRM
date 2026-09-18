"""Rate limits for machine credentials: per credential, per organization and per credential + endpoint.

They apply only to requests authenticated with an API credential (``request.api_credential_id``); for
session requests ``get_cache_key`` returns None and DRF skips them.
"""

from __future__ import annotations

from rest_framework.throttling import SimpleRateThrottle


def _machine(request):
    return getattr(request._request, "integration_actor", None)


class MachineCredentialThrottle(SimpleRateThrottle):
    scope = "machine_credential"

    def get_cache_key(self, request, view):
        actor = _machine(request)
        return f"throttle_machine_cred_{actor.credential_id}" if actor is not None else None


class MachineOrganizationThrottle(SimpleRateThrottle):
    scope = "machine_org"

    def get_cache_key(self, request, view):
        actor = _machine(request)
        return f"throttle_machine_org_{actor.organization.pk}" if actor is not None else None


class MachineEndpointThrottle(SimpleRateThrottle):
    scope = "machine_endpoint"

    def get_cache_key(self, request, view):
        actor = _machine(request)
        if actor is None:
            return None
        endpoint = f"{type(view).__name__}:{getattr(view, 'action', None) or request.method}"
        return f"throttle_machine_ep_{actor.credential_id}_{endpoint}"
