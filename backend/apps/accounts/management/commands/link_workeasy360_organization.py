"""Attach an existing Keel organization to its Workeasy360 organization.

Without this, the first Workeasy360 sign-in into that Workeasy360 organization creates a new, empty Keel
organization. Run it before switching an existing customer to Workeasy360 sign-in:

    python manage.py link_workeasy360_organization <keel-org-id-or-slug> <workeasy360-org-uuid>

Existing members are then matched to their Workeasy360 accounts by verified email on their first
Workeasy360 sign-in and keep their roles. Refuses if either side is already linked.
"""

from __future__ import annotations

import uuid

from django.core.management.base import BaseCommand, CommandError
from django.db import IntegrityError, transaction

from apps.accounts.models import Organization
from apps.audit import actions
from apps.audit import service as audit
from apps.core.tenancy.context import system_context


class Command(BaseCommand):
    help = "Link a Keel organization (id or slug) to a Workeasy360 organization id."

    def add_arguments(self, parser):
        parser.add_argument("organization", help="Keel organization id (UUID) or slug")
        parser.add_argument("workeasy360_organization_id", help="Workeasy360 organization id (UUID)")

    def handle(self, *args, **options):
        try:
            w360_id = uuid.UUID(options["workeasy360_organization_id"])
        except ValueError:
            raise CommandError("workeasy360_organization_id must be a UUID.") from None
        ref = options["organization"].strip()

        with system_context(reason="accounts.link_workeasy360_organization"), transaction.atomic():
            organizations = Organization.objects.select_for_update()
            try:
                org = organizations.get(pk=uuid.UUID(ref))
            except (ValueError, Organization.DoesNotExist):
                org = organizations.filter(slug=ref).first()
            if org is None:
                raise CommandError(f"No Keel organization with id or slug {ref!r}.")
            if org.workeasy360_organization_id is not None:
                raise CommandError(
                    f"{org.slug} is already linked to Workeasy360 organization {org.workeasy360_organization_id}."
                )
            other = Organization.objects.filter(workeasy360_organization_id=w360_id).first()
            if other is not None:
                raise CommandError(f"Workeasy360 organization {w360_id} is already linked to {other.slug}.")
            try:
                with transaction.atomic():
                    Organization.objects.filter(pk=org.pk).update(workeasy360_organization_id=w360_id)
            except IntegrityError:
                raise CommandError(f"Workeasy360 organization {w360_id} was linked concurrently.") from None
            audit.record(
                actions.ORG_WORKEASY360_LINKED,
                organization_id=org.pk,
                actor_type="system",
                resource=org,
                metadata={"workeasy360_organization_id": str(w360_id), "source": "management_command"},
            )
        self.stdout.write(self.style.SUCCESS(f"Linked {org.slug} ({org.pk}) to Workeasy360 organization {w360_id}."))
