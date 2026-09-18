"""Shared CRM record services.

The layer between the core primitives and the modules. ``records`` implements create / update /
archive / restore / reassign / bulk once, so authorization, optimistic concurrency, ownership rules,
domain events and audit logging cannot drift between contacts, companies, deals and products.

Not a Django app (it owns no models); a package, deliberately, so the dependency direction is legible
from the import path alone:

    apps.core.*  (primitives: models, tenancy, concurrency, domain_events)
        ^
    apps.audit / apps.authz / apps.accounts        (platform services)
        ^
    apps.crm.records + module services             (business services)
        ^
    apps.*.api                                     (application layer)
"""
