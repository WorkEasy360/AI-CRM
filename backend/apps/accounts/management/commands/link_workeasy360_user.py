"""Link an existing Keel account to a person's Workeasy360 account, on an operator's word.

A Workeasy360 sign-in whose address matches an existing Keel account is refused (``account_conflict``): the
same address is not proof of the same person (``WORKEASY360_LINK_BY_VERIFIED_EMAIL`` is off by default). An
operator who has confirmed who the person is links the two here, for one organization::

    python manage.py link_workeasy360_user --email ada@example.com --subject <workeasy360-sub> \\
        --organization <workeasy360-org-uuid> --actor "Priya (support)" --reason "ticket 4711"           # dry run
    python manage.py link_workeasy360_user ... --apply                                                 # link

``--subject`` is the person's Workeasy360 user id (the ``sub`` of their ID token, shown in Workeasy360
Accounts). ``--organization`` is a Workeasy360 organization already linked to a Keel organization
(``link_workeasy360_organization``) in which the account is an active member. The link is made at the
configured issuer (``WORKEASY360_ISSUER``) and audited (``auth.sso_identity_linked``: who vouched, why, which
accounts and organizations). Refused when the account already has a Workeasy360 identity, or the Workeasy360
identity already belongs to another account; never merges or moves a link. The account's password is left as
it is: ``WORKEASY360_SSO_ONLY`` ends password sign-in (docs/workeasy360-sso.md, "Existing accounts").
"""

from __future__ import annotations

import uuid

from allauth.account.models import EmailAddress
from django.core.management.base import BaseCommand, CommandError
from django.db import IntegrityError, transaction

from apps.accounts.models import ExternalIdentity, Membership, Organization, User
from apps.accounts.workeasy360 import config, provisioning
from apps.core.tenancy.context import system_context


class Command(BaseCommand):
    help = "Link an existing Keel account to a Workeasy360 account (issuer, sub) for one organization. Audited."

    def add_arguments(self, parser):
        who = parser.add_mutually_exclusive_group(required=True)
        who.add_argument("--email", help="The Keel account's email address")
        who.add_argument("--user-id", help="The Keel account's id (UUID)")
        parser.add_argument("--subject", required=True, help="The person's Workeasy360 user id (sub)")
        parser.add_argument(
            "--organization", required=True, help="Workeasy360 organization id (UUID), linked to a Keel organization"
        )
        parser.add_argument("--actor", required=True, help="Who confirmed that both accounts are the same person")
        parser.add_argument("--reason", required=True, help="Why (a ticket, a request); recorded in the audit log")
        parser.add_argument("--apply", action="store_true", help="Make the link. Without it, only report.")

    def handle(self, *args, **options):
        issuer = config.issuer()
        if not issuer:
            raise CommandError("WORKEASY360_ISSUER is not configured.")
        subject = str(options["subject"] or "").strip()
        if not subject or len(subject) > 255:
            raise CommandError("--subject must be the Workeasy360 user id (1-255 characters).")
        actor = " ".join(str(options["actor"] or "").split())
        reason = " ".join(str(options["reason"] or "").split())
        if not actor or not reason:
            raise CommandError("--actor and --reason must not be blank.")
        try:
            w360_org_id = uuid.UUID(str(options["organization"]))
        except ValueError:
            raise CommandError("--organization must be a Workeasy360 organization id (UUID).") from None

        with system_context(reason="accounts.link_workeasy360_user"), transaction.atomic():
            organization = Organization.objects.filter(workeasy360_organization_id=w360_org_id).first()
            if organization is None:
                raise CommandError(
                    f"Workeasy360 organization {w360_org_id} is not linked to a Keel organization "
                    "(link_workeasy360_organization first)."
                )
            user = self._user(options)
            if not user.is_active:
                raise CommandError(f"The Keel account {user.pk} is deactivated.")
            memberships = list(
                Membership.identity.for_user(user).select_related("organization").order_by("organization__slug")
            )
            here = next((m for m in memberships if m.organization_id == organization.pk), None)
            if here is None or here.status != Membership.Status.ACTIVE:
                state = "not a member" if here is None else f"{here.status}"
                raise CommandError(f"The Keel account {user.pk} is {state} in {organization.slug}.")
            linked = ExternalIdentity.objects.filter(user=user).first()
            if linked is not None:
                raise CommandError(
                    f"The Keel account {user.pk} is already linked to a Workeasy360 identity "
                    f"({linked.issuer}, sub={linked.subject}); unlink it first."
                )
            holder = ExternalIdentity.objects.filter(issuer=issuer, subject=subject).first()
            if holder is not None:
                raise CommandError(
                    f"The Workeasy360 identity sub={subject} is already linked to the Keel account {holder.user_id}."
                )
            others = [f"{m.organization.slug} ({m.status})" for m in memberships if m is not here]
            verified = EmailAddress.objects.filter(user=user, email__iexact=user.email, verified=True).exists()

            self.stdout.write(f"Keel account {user.pk} -> Workeasy360 ({issuer}, sub={subject})")
            self.stdout.write(f"organization={organization.slug} ({organization.pk}) workeasy360={w360_org_id}")
            self.stdout.write(f"other organizations it opens: {', '.join(others) if others else 'none'}")
            self.stdout.write(
                f"address verified in Keel: {'yes' if verified else 'no'}; "
                f"password kept: {'yes' if user.has_usable_password() else 'no (none set)'}"
            )
            if not options["apply"]:
                self.stdout.write("dry run: nothing changed (add --apply to link)")
                return
            try:
                provisioning.link_identity(
                    user,
                    issuer=issuer,
                    subject=subject,
                    organization=organization,
                    by_operator=True,
                    metadata={
                        "method": "workeasy360",
                        "link": "operator",
                        "actor": actor,
                        "reason": reason,
                        "source": "management_command",
                        "other_organizations": others,
                        "keel_address_verified": verified,
                    },
                )
            except IntegrityError:
                raise CommandError("Nothing linked: one side was linked concurrently.") from None
            except provisioning.LinkNotAuditedError:
                raise CommandError("Nothing linked: the audit record could not be written.") from None
            provisioning.sync_federated_identity(user, issuer=issuer, subject=subject, email=user.email)
        self.stdout.write(self.style.SUCCESS(f"Linked the Keel account {user.pk} to sub={subject} at {issuer}."))

    def _user(self, options) -> User:
        if options.get("user_id"):
            try:
                user = User.objects.filter(pk=uuid.UUID(str(options["user_id"]))).first()
            except ValueError:
                raise CommandError("--user-id must be a UUID.") from None
        else:
            email = str(options["email"] or "").strip()
            user = User.objects.filter(email__iexact=email).first() if email else None
        if user is None:
            raise CommandError("No Keel account matches.")
        return user
