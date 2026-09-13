"""Test data helpers plus the registry the generated cross-tenant tests use.

Every tenant-owned model exposed through the API must have a factory here; the generated test
fails otherwise, which forces new resources to be covered by isolation tests.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from allauth.account.models import EmailAddress

from apps.accounts import services as account_services
from apps.accounts.models import Invitation, Membership, Organization, User
from apps.activities.models import Activity
from apps.ai.models import AIUsage
from apps.audit import service as audit
from apps.audit.models import AuditEvent
from apps.authz.models import Role
from apps.companies.models import Company
from apps.contacts.models import Contact
from apps.core.tenancy.context import tenant_context
from apps.customfields.models import CustomFieldDefinition
from apps.deals.models import Deal, DealStageHistory
from apps.importexport.models import ExportJob, ImportJob
from apps.lifecycle.models import LifecycleHistory
from apps.messaging.models import (
    EmailAccount,
    EmailMessage,
    EmailTemplate,
    WhatsAppAccount,
    WhatsAppMessage,
    WhatsAppTemplate,
)
from apps.notes.models import Note
from apps.notifications.models import Notification, NotificationPreference
from apps.pipelines.models import Pipeline, PipelineStage
from apps.pipelines.services import ensure_default_pipeline
from apps.products.models import Product
from apps.tagging.models import Tag
from apps.teams.models import Team
from tests.testapp.models import Widget

DEFAULT_PASSWORD = "Str0ng-Passw0rd-123!"


@dataclass
class OrgBundle:
    org: Organization
    owner: User
    owner_membership: Membership


def make_user(
    email: str | None = None, *, password: str = DEFAULT_PASSWORD, verified: bool = True, first_name: str = "Test"
) -> User:
    email = email or f"user-{uuid.uuid4().hex[:10]}@example.com"
    user = User.objects.create_user(email=email, password=password, first_name=first_name)
    EmailAddress.objects.create(user=user, email=user.email, verified=verified, primary=True)
    return user


def make_org(name: str | None = None, *, owner: User | None = None) -> OrgBundle:
    owner = owner or make_user()
    membership = account_services.create_organization(owner, name=name or f"Org {uuid.uuid4().hex[:6]}")
    return OrgBundle(org=membership.organization, owner=owner, owner_membership=membership)


def make_member(bundle: OrgBundle, role_key: str = "sales_rep", *, user: User | None = None) -> Membership:
    user = user or make_user()
    with tenant_context(bundle.org.pk, user_id=bundle.owner.pk, reason="test.make_member"):
        role = Role.objects.get(key=role_key, is_system=True, organization__isnull=True)
        return Membership.objects.create(user=user, role=role)


def make_widget(bundle: OrgBundle, *, owner: Membership | None = None, name: str = "widget") -> Widget:
    with tenant_context(bundle.org.pk, reason="test.make_widget"):
        return Widget.objects.create(name=name, owner=owner or bundle.owner_membership)


def make_team(bundle: OrgBundle, name: str = "Team A") -> Team:
    with tenant_context(bundle.org.pk, reason="test.make_team"):
        return Team.objects.create(name=name)


def make_invitation(bundle: OrgBundle, email: str | None = None, role_key: str = "sales_rep") -> Invitation:
    from apps.authz.actor import build_actor

    with tenant_context(
        bundle.org.pk, user_id=bundle.owner.pk, membership_id=bundle.owner_membership.pk, reason="test.make_invitation"
    ):
        membership = Membership.objects.select_related("user", "role", "organization").get(
            pk=bundle.owner_membership.pk
        )
        return account_services.invite_member(
            build_actor(membership), email=email or f"inv-{uuid.uuid4().hex[:8]}@example.com", role_key=role_key
        )


def make_audit_event(bundle: OrgBundle) -> AuditEvent:
    with tenant_context(bundle.org.pk, reason="test.make_audit_event"):
        event = audit.record("test.event", organization_id=bundle.org.pk, metadata={"k": "v"})
    assert event is not None
    return event


# ----------------------------------------------------------------------------- CRM core (Phase 2)


def _ctx(bundle: OrgBundle, reason: str):
    return tenant_context(
        bundle.org.pk, user_id=bundle.owner.pk, membership_id=bundle.owner_membership.pk, reason=reason
    )


def make_company(bundle: OrgBundle, *, owner: Membership | None = None, name: str | None = None, **extra) -> Company:
    with _ctx(bundle, "test.make_company"):
        return Company.objects.create(
            name=name or f"Company {uuid.uuid4().hex[:6]}", owner=owner or bundle.owner_membership, **extra
        )


def make_contact(
    bundle: OrgBundle, *, owner: Membership | None = None, company: Company | None = None, **extra
) -> Contact:
    with _ctx(bundle, "test.make_contact"):
        extra.setdefault("first_name", "Ada")
        extra.setdefault("last_name", uuid.uuid4().hex[:6])
        extra.setdefault("email", f"{uuid.uuid4().hex[:8]}@example.com")
        return Contact.objects.create(owner=owner or bundle.owner_membership, company=company, **extra)


def make_product(bundle: OrgBundle, *, owner: Membership | None = None, **extra) -> Product:
    with _ctx(bundle, "test.make_product"):
        extra.setdefault("name", f"Product {uuid.uuid4().hex[:6]}")
        extra.setdefault("unit_price", "100.00")
        extra.setdefault("currency", bundle.org.base_currency)
        return Product.objects.create(owner=owner or bundle.owner_membership, **extra)


def make_pipeline(bundle: OrgBundle) -> Pipeline:
    """The organization's default pipeline (created on organization creation)."""
    with _ctx(bundle, "test.make_pipeline"):
        pipeline = ensure_default_pipeline()
        return Pipeline.objects.prefetch_related("stages").get(pk=pipeline.pk)


def stage_named(pipeline: Pipeline, name: str) -> PipelineStage:
    return next(s for s in pipeline.stages.all() if s.name == name)


def make_deal(
    bundle: OrgBundle,
    *,
    owner: Membership | None = None,
    stage: PipelineStage | None = None,
    company: Company | None = None,
    contact: Contact | None = None,
    **extra,
) -> Deal:
    from django.utils import timezone

    pipeline = make_pipeline(bundle)
    stage = stage or stage_named(pipeline, "Qualification")
    with _ctx(bundle, "test.make_deal"):
        extra.setdefault("name", f"Deal {uuid.uuid4().hex[:6]}")
        extra.setdefault("amount", "1000.00")
        extra.setdefault("amount_base", "1000.00")
        extra.setdefault("currency", bundle.org.base_currency)
        now = timezone.now()
        deal = Deal.objects.create(
            pipeline=pipeline,
            stage=stage,
            stage_entered_at=now,
            owner=owner or bundle.owner_membership,
            company=company,
            primary_contact=contact,
            probability=stage.default_probability,
            status="open" if stage.kind == "open" else stage.kind,
            closed_at=None if stage.kind == "open" else now,
            **extra,
        )
        DealStageHistory.objects.create(
            deal=deal, to_stage=stage, changed_at=now, changed_by=owner or bundle.owner_membership
        )
        return deal


def make_custom_field(
    bundle: OrgBundle, entity_type: str = "contact", key: str | None = None, **extra
) -> CustomFieldDefinition:
    with _ctx(bundle, "test.make_custom_field"):
        extra.setdefault("field_type", "text")
        extra.setdefault("label", "Custom")
        return CustomFieldDefinition.objects.create(
            entity_type=entity_type, key=key or f"f_{uuid.uuid4().hex[:6]}", **extra
        )


def make_tag(bundle: OrgBundle, name: str | None = None) -> Tag:
    with _ctx(bundle, "test.make_tag"):
        return Tag.objects.create(name=name or f"tag-{uuid.uuid4().hex[:6]}")


def make_note(bundle: OrgBundle, *, record=None, author: Membership | None = None, body: str = "hello") -> Note:
    record = record or make_contact(bundle)
    entity_type = type(record).__name__.lower()
    with _ctx(bundle, "test.make_note"):
        return Note.objects.create(
            entity_type=entity_type, entity_id=record.pk, body=body, author=author or bundle.owner_membership
        )


def make_import_job(bundle: OrgBundle, entity_type: str = "contact") -> ImportJob:
    with _ctx(bundle, "test.make_import_job"):
        return ImportJob.objects.create(
            entity_type=entity_type,
            storage_key=f"{bundle.org.pk}/imports/{uuid.uuid4().hex}.csv",
            original_filename="x.csv",
            headers=["Email"],
            total_rows=1,
            requested_by=bundle.owner_membership,
        )


def make_export_job(bundle: OrgBundle, entity_type: str = "contact") -> ExportJob:
    with _ctx(bundle, "test.make_export_job"):
        return ExportJob.objects.create(entity_type=entity_type, requested_by=bundle.owner_membership)


# ----------------------------------------------------------------------------- sales operations / communication


def make_activity(bundle: OrgBundle, *, owner: Membership | None = None, kind: str = "task", **extra) -> Activity:
    from django.utils import timezone

    with _ctx(bundle, "test.make_activity"):
        extra.setdefault("title", f"Activity {uuid.uuid4().hex[:6]}")
        if kind != "task":
            extra.setdefault("start_at", timezone.now() + __import__("datetime").timedelta(days=1))
            extra.setdefault("direction", "outbound" if kind == "call" else "")
        return Activity.objects.create(
            kind=kind, owner=owner or bundle.owner_membership, created_by=owner or bundle.owner_membership, **extra
        )


def make_notification(bundle: OrgBundle, *, recipient: Membership | None = None) -> Notification:
    with _ctx(bundle, "test.make_notification"):
        return Notification.objects.create(
            recipient=recipient or bundle.owner_membership, kind="task_due", title="Reminder"
        )


def make_notification_preference(bundle: OrgBundle) -> NotificationPreference:
    with _ctx(bundle, "test.make_notification_preference"):
        return NotificationPreference.objects.create(membership=bundle.owner_membership)


def make_lifecycle_history(bundle: OrgBundle) -> LifecycleHistory:
    from django.utils import timezone

    contact = make_contact(bundle)
    with _ctx(bundle, "test.make_lifecycle_history"):
        return LifecycleHistory.objects.create(
            entity_type="contact",
            entity_id=contact.pk,
            from_stage="lead",
            to_stage="prospect",
            changed_at=timezone.now(),
        )


def make_email_account(
    bundle: OrgBundle, *, membership: Membership | None = None, provider: str = "gmail"
) -> EmailAccount:
    from django.utils import timezone

    from apps.core import crypto

    with _ctx(bundle, "test.make_email_account"):
        member = membership or bundle.owner_membership
        return EmailAccount.objects.create(
            membership=member,
            provider=provider,
            email_address=f"{member.user.email}",
            access_token_enc=crypto.encrypt("access"),
            refresh_token_enc=crypto.encrypt("refresh"),
            token_expires_at=timezone.now() + __import__("datetime").timedelta(hours=1),
            connected_at=timezone.now(),
            last_sync_at=timezone.now(),
        )


def make_email_template(bundle: OrgBundle) -> EmailTemplate:
    with _ctx(bundle, "test.make_email_template"):
        return EmailTemplate.objects.create(
            name=f"Template {uuid.uuid4().hex[:6]}",
            subject="Hello {{first_name}}",
            body="Hi {{first_name}},\n\nBody",
            created_by=bundle.owner_membership,
        )


def make_email_message(bundle: OrgBundle, *, contact: Contact | None = None) -> EmailMessage:
    contact = contact or make_contact(bundle)
    with _ctx(bundle, "test.make_email_message"):
        return EmailMessage.objects.create(
            direction="outbound",
            status="sent",
            from_address="me@example.com",
            to_addresses=[contact.email],
            subject="Hello",
            body_text="Body",
            contact=contact,
            sent_by=bundle.owner_membership,
        )


def make_whatsapp_account(bundle: OrgBundle) -> WhatsAppAccount:
    from django.utils import timezone

    from apps.core import crypto

    with _ctx(bundle, "test.make_whatsapp_account"):
        return WhatsAppAccount.objects.create(
            phone_number_id="123456789",
            access_token_enc=crypto.encrypt("token"),
            connected_by=bundle.owner_membership,
            connected_at=timezone.now(),
        )


def make_whatsapp_template(bundle: OrgBundle) -> WhatsAppTemplate:
    with _ctx(bundle, "test.make_whatsapp_template"):
        return WhatsAppTemplate.objects.create(
            name=f"hello_{uuid.uuid4().hex[:6]}", body="Hello {{1}}", parameter_count=1
        )


def make_whatsapp_message(bundle: OrgBundle, *, contact: Contact | None = None) -> WhatsAppMessage:
    contact = contact or make_contact(bundle, phone="+15550100")
    with _ctx(bundle, "test.make_whatsapp_message"):
        return WhatsAppMessage.objects.create(
            direction="outbound",
            status="sent",
            wa_id="15550100",
            body="Hi",
            contact=contact,
            sent_by=bundle.owner_membership,
        )


def make_ai_usage(bundle: OrgBundle) -> AIUsage:
    from django.utils import timezone

    with _ctx(bundle, "test.make_ai_usage"):
        return AIUsage.objects.create(
            membership=bundle.owner_membership, day=timezone.now().date(), feature="followup", model="fake", requests=1
        )


# model -> callable(bundle) -> instance, used by tests/tenant_isolation/test_generated.py
CROSS_TENANT_FACTORIES = {
    Activity: lambda bundle: make_activity(bundle),
    Notification: lambda bundle: make_notification(bundle),
    NotificationPreference: lambda bundle: make_notification_preference(bundle),
    LifecycleHistory: lambda bundle: make_lifecycle_history(bundle),
    EmailAccount: lambda bundle: make_email_account(bundle),
    EmailTemplate: lambda bundle: make_email_template(bundle),
    EmailMessage: lambda bundle: make_email_message(bundle),
    WhatsAppAccount: lambda bundle: make_whatsapp_account(bundle),
    WhatsAppTemplate: lambda bundle: make_whatsapp_template(bundle),
    WhatsAppMessage: lambda bundle: make_whatsapp_message(bundle),
    AIUsage: lambda bundle: make_ai_usage(bundle),
    Membership: lambda bundle: make_member(bundle),
    Invitation: lambda bundle: make_invitation(bundle),
    Team: lambda bundle: make_team(bundle),
    AuditEvent: lambda bundle: make_audit_event(bundle),
    Widget: lambda bundle: make_widget(bundle),
    Company: lambda bundle: make_company(bundle),
    Contact: lambda bundle: make_contact(bundle),
    Product: lambda bundle: make_product(bundle),
    Pipeline: lambda bundle: make_pipeline(bundle),
    PipelineStage: lambda bundle: stage_named(make_pipeline(bundle), "Qualification"),
    Deal: lambda bundle: make_deal(bundle),
    CustomFieldDefinition: lambda bundle: make_custom_field(bundle),
    Tag: lambda bundle: make_tag(bundle),
    Note: lambda bundle: make_note(bundle),
    ImportJob: lambda bundle: make_import_job(bundle),
    ExportJob: lambda bundle: make_export_job(bundle),
}
