"""OpenAPI description of API-credential authentication (drf-spectacular extension)."""

from __future__ import annotations

from drf_spectacular.extensions import OpenApiAuthenticationExtension


class MachineCredentialScheme(OpenApiAuthenticationExtension):
    target_class = "apps.integrations.machine_auth.MachineCredentialAuthentication"
    name = "apiCredential"

    def get_security_definition(self, auto_schema):
        return {
            "type": "http",
            "scheme": "bearer",
            "description": (
                "Scoped API credential (keel_...). "
                "Accepted only on /api/v1/contacts, /companies, /deals and /activities."
            ),
        }
