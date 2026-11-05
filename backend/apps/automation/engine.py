"""Runs automation rules when CRM records change.

    service save -> publish(RecordChanged) -> on_record_changed (inside the request's tenant context)
        -> only if the organization has an enabled rule for that kind of change: queue run_rules
           on commit (so a rolled-back save never fires a rule)
    run_rules (Celery, tenant context) -> work out the trigger from the record's committed state
        -> for each enabled rule: claim an AutomationRun row (unique per rule and record), PENDING with
           the time it is due; act on the ones due now
    run_due (beat) -> act on PENDING runs whose time has come (delayed rules, paused organizations)

Acting always happens as the record's owner, through the owner's own permissions, after re-reading the
record and the rule: a deal that is no longer won, a rule turned off, or a contact who replied in the
meantime ends the run as SKIPPED with the reason.

The engine never takes ids from a client: it only ever sees ids from RecordChanged (or its own rows),
and loads every record through the tenant-scoped managers of the organization the event came from.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections import defaultdict
from typing import Any

import structlog
from celery import shared_task
from django.db import IntegrityError, transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.automation.models import AutomationRule, AutomationRun
from apps.core.domain_events import RecordChanged
from apps.core.tenancy.context import system_context, tenant_context

log = structlog.get_logger(__name__)

# Which (entity_type, change) pairs can fire which triggers. Won/lost is decided from the deal's
# committed status when the task runs, not from the event.
_CANDIDATES: dict[tuple[str, str], tuple[str, ...]] = {
    ("contact", "created"): (AutomationRule.Trigger.CONTACT_CREATED,),
    ("deal", "created"): (
        AutomationRule.Trigger.DEAL_CREATED,
        AutomationRule.Trigger.DEAL_WON,
        AutomationRule.Trigger.DEAL_LOST,
    ),
    ("deal", "stage_changed"): (AutomationRule.Trigger.DEAL_WON, AutomationRule.Trigger.DEAL_LOST),
    ("deal", "updated"): (AutomationRule.Trigger.DEAL_WON, AutomationRule.Trigger.DEAL_LOST),
}
MAX_IDS_PER_EVENT = 200
DUE_BATCH = 500
RUN_RULES_TASK = "automation.run_rules"
RUN_DUE_TASK = "automation.run_due"


def on_record_changed(event: RecordChanged) -> None:
    triggers = _CANDIDATES.get((event.entity_type, event.change))
    if not triggers:
        return
    # Cheap guard so organizations without rules never queue anything.
    if not AutomationRule.objects.filter(is_enabled=True, trigger__in=triggers).exists():
        return
    org_id = str(event.organization_id)
    ids = [str(i) for i in event.entity_ids[:MAX_IDS_PER_EVENT]]
    transaction.on_commit(lambda: run_rules.delay(org_id, event.entity_type, ids, event.change))


@shared_task(name=RUN_RULES_TASK, ignore_result=True, soft_time_limit=60, time_limit=90)
def run_rules(organization_id: str, entity_type: str, entity_ids: list[str], change: str) -> int:
    from apps.accounts.workeasy360 import background

    fired = 0
    with tenant_context(uuid.UUID(organization_id), reason=f"task:{RUN_RULES_TASK}"):
        # Recording which rules fired is not a customer effect; acting is. A paused organization's runs
        # stay PENDING and the sweep acts on them once access is renewed.
        act_now = background.allowed(organization_id, task=RUN_RULES_TASK)
        for raw in entity_ids[:MAX_IDS_PER_EVENT]:
            try:
                for run_id in _schedule_for_record(entity_type, uuid.UUID(raw), change):
                    if act_now:
                        fired += execute_run(run_id)
            except Exception as exc:  # one bad record must not stop the batch
                log.warning("automation.run_failed", entity_type=entity_type, error=str(exc)[:200])
    return fired


@shared_task(name=RUN_DUE_TASK, ignore_result=True, soft_time_limit=240, time_limit=300)
def run_due() -> int:
    """Beat: act on PENDING runs that are due. Reads ids across organizations; acts inside each one."""
    from apps.accounts.workeasy360 import background

    now = timezone.now()

    def fetch(excluded: set[uuid.UUID]) -> list:
        with system_context(RUN_DUE_TASK):
            return list(
                AutomationRun.all_objects.filter(outcome=AutomationRun.Outcome.PENDING, due_at__lte=now)
                .exclude(organization_id__in=excluded)
                .order_by("due_at")
                .values_list("organization_id", "id")[:DUE_BATCH]
            )

    by_org: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for org_id, run_id in background.fetch_allowed(fetch, task=RUN_DUE_TASK):
        by_org[org_id].append(run_id)
    fired = 0
    for org_id, run_ids in by_org.items():
        with tenant_context(org_id, reason=f"task:{RUN_DUE_TASK}"):
            for run_id in run_ids:
                try:
                    fired += execute_run(run_id)
                except Exception as exc:
                    log.warning("automation.run_failed", run_id=str(run_id), error=str(exc)[:200])
    return fired


# ----------------------------------------------------------------------------- scheduling


def _load(entity_type: str, entity_id: uuid.UUID) -> Any:
    if entity_type == "contact":
        from apps.contacts.models import Contact

        return (
            Contact.objects.select_related("owner__user", "company")
            .filter(pk=entity_id, archived_at__isnull=True)
            .first()
        )
    if entity_type == "deal":
        from apps.deals.models import Deal

        return (
            Deal.objects.select_related("owner__user", "company", "primary_contact")
            .filter(pk=entity_id, archived_at__isnull=True)
            .first()
        )
    return None


def _triggers_for(entity_type: str, record: Any, change: str) -> list[str]:
    if entity_type == "contact":
        return [AutomationRule.Trigger.CONTACT_CREATED] if change == "created" else []
    out: list[str] = []
    if change == "created":
        out.append(AutomationRule.Trigger.DEAL_CREATED)
    if record.status == "won":
        out.append(AutomationRule.Trigger.DEAL_WON)
    elif record.status == "lost":
        out.append(AutomationRule.Trigger.DEAL_LOST)
    return out


def _waits(rule: AutomationRule) -> bool:
    """A task is created at once (due later) unless it waits for a reply; other actions happen later."""
    return rule.delay_days > 0 and (rule.only_if_no_reply or rule.action != AutomationRule.Action.CREATE_TASK)


def _schedule_for_record(entity_type: str, entity_id: uuid.UUID, change: str) -> list[uuid.UUID]:
    """Claim one PENDING run per matching rule; return the ids of the claimed runs that are due now."""
    record = _load(entity_type, entity_id)
    if record is None:
        return []
    triggers = _triggers_for(entity_type, record, change)
    if not triggers:
        return []
    now = timezone.now()
    due_now: list[uuid.UUID] = []
    for rule in AutomationRule.objects.filter(is_enabled=True, trigger__in=triggers).order_by("created_at"):
        due_at = now + dt.timedelta(days=rule.delay_days) if _waits(rule) else now
        try:
            with transaction.atomic():
                run = AutomationRun.objects.create(
                    rule=rule,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    outcome=AutomationRun.Outcome.PENDING,
                    due_at=due_at,
                )
        except IntegrityError:
            continue  # already fired for this record (a re-delivered or duplicate event)
        if due_at <= now:
            due_now.append(run.pk)
    return due_now


# ----------------------------------------------------------------------------- acting


def execute_run(run_id: uuid.UUID) -> int:
    """Act on one PENDING run, exactly once: the row is locked, acted on and settled in one transaction,
    so a crash rolls the effect back with it and a second worker skips the locked row."""
    with transaction.atomic():
        run = (
            AutomationRun.objects.select_for_update(skip_locked=True)
            .filter(pk=run_id, outcome=AutomationRun.Outcome.PENDING)
            .first()
        )
        if run is None:
            return 0
        rule = AutomationRule.objects.select_related("whatsapp_template").filter(pk=run.rule_id).first()
        outcome, detail = _decide(rule, run)
        run.outcome, run.detail = outcome, detail[:200]
        run.save(update_fields=["outcome", "detail", "updated_at"])
        AutomationRule.objects.filter(pk=run.rule_id).update(run_count=F("run_count") + 1, last_run_at=timezone.now())
    return 1 if outcome == AutomationRun.Outcome.DONE else 0


def _decide(rule: AutomationRule | None, run: AutomationRun) -> tuple[str, str]:
    skipped = AutomationRun.Outcome.SKIPPED
    if rule is None or not rule.is_enabled:
        return skipped, "The rule was turned off."
    record = _load(run.entity_type, run.entity_id)
    if record is None:
        return skipped, "The record was archived or deleted."
    if rule.trigger == AutomationRule.Trigger.DEAL_WON and record.status != "won":
        return skipped, "The deal is no longer won."
    if rule.trigger == AutomationRule.Trigger.DEAL_LOST and record.status != "lost":
        return skipped, "The deal is no longer lost."
    contact = _contact_of(run.entity_type, record)
    if rule.only_if_no_reply and contact is not None and replied_since(contact, run.created_at):
        return skipped, "The contact replied."
    try:
        # A savepoint: a failed action leaves nothing behind and keeps the run's transaction usable.
        with transaction.atomic():
            return _act(rule, run, record, contact)
    except Exception as exc:  # out of the owner's scope, consent missing, WhatsApp not connected, ...
        return skipped, f"Not done: {_reason(exc)}"


def _reason(exc: Exception) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, dict):
        detail = " ".join(str(v[0] if isinstance(v, list) and v else v) for v in detail.values())
    return str(detail or getattr(exc, "message", None) or exc)[:180]


def _contact_of(entity_type: str, record: Any) -> Any:
    if entity_type == "contact":
        return record
    return getattr(record, "primary_contact", None)


def replied_since(contact: Any, since: dt.datetime) -> bool:
    """Whether the contact wrote back (WhatsApp or email) at or after ``since``."""
    from apps.messaging.models import EmailMessage, MessageDirection, WhatsAppMessage
    from apps.messaging.services import normalise_phone

    match = Q(contact=contact)
    try:
        wa_id = normalise_phone(contact.phone) if contact.phone else ""
    except Exception:
        wa_id = ""
    if wa_id:
        match |= Q(wa_id=wa_id)
    if WhatsAppMessage.objects.filter(match, direction=MessageDirection.INBOUND, received_at__gte=since).exists():
        return True
    return EmailMessage.objects.filter(
        contact=contact, direction=MessageDirection.INBOUND, received_at__gte=since
    ).exists()


def _act(rule: AutomationRule, run: AutomationRun, record: Any, contact: Any) -> tuple[str, str]:
    from apps.accounts.models import Membership
    from apps.authz.actor import build_actor

    owner = record.owner
    if owner is None or owner.status != Membership.Status.ACTIVE:
        return AutomationRun.Outcome.SKIPPED, "The record has no active owner."
    entity_type = run.entity_type
    label = getattr(record, "display_name", None) or getattr(record, "name", "") or ""
    text = rule.message or rule.name
    if rule.action == AutomationRule.Action.CREATE_TASK:
        from apps.activities import services as activities

        actor = build_actor(owner)
        if not actor.has("activities.create"):
            return AutomationRun.Outcome.SKIPPED, "The owner may not create tasks."
        due = timezone.localdate(run.created_at) + dt.timedelta(days=rule.delay_days)
        start = timezone.make_aware(dt.datetime.combine(due, dt.time(10, 0)))
        activities.create_activity(
            actor,
            {
                "kind": "task",
                "title": f"{text}: {label}"[:200] if label else text,
                "start_at": start,
                entity_type: record,
            },
        )
        return AutomationRun.Outcome.DONE, ""
    if rule.action == AutomationRule.Action.NOTIFY_OWNER:
        from apps.notifications import service as notifications

        notifications.notify(
            owner.pk, kind="automation", title=text, body=label, entity_type=entity_type, entity_id=record.pk
        )
        return AutomationRun.Outcome.DONE, ""
    if rule.action == AutomationRule.Action.SEND_WHATSAPP:
        return _send_whatsapp(rule, run, record, contact, owner)
    return AutomationRun.Outcome.SKIPPED, "Unknown action."


def _send_whatsapp(rule: AutomationRule, run: AutomationRun, record: Any, contact: Any, owner: Any) -> tuple[str, str]:
    """Queue one approved-template message from the owner, through the same service a person uses: it
    checks ``whatsapp.send``, the plan, the connection, the owner's view of the contact and the contact's
    WhatsApp consent."""
    from apps.authz.actor import build_actor
    from apps.messaging import services as messaging

    skipped = AutomationRun.Outcome.SKIPPED
    template = rule.whatsapp_template
    if template is None:
        return skipped, "The WhatsApp template was removed."
    if contact is None:
        return skipped, "There is no contact to message."
    if not contact.phone:
        return skipped, "The contact has no phone number."
    actor = build_actor(owner)
    if not actor.has("whatsapp.send"):
        return skipped, "The owner may not send WhatsApp messages."
    deal = record if run.entity_type == "deal" else None
    company = getattr(record, "company", None)
    params = [
        messaging.render_template(str(p), contact=contact, company=company, deal=deal, sender=owner).strip()
        for p in rule.template_params or []
    ]
    if any(not p for p in params):
        return skipped, "A template value came out empty for this contact."
    data: dict[str, Any] = {
        "contact_id": str(contact.pk),
        "message_type": "template",
        "template_id": str(template.pk),
        "template_params": params,
    }
    if deal is not None:
        data["deal_id"] = str(deal.pk)
    messaging.send_whatsapp(actor, data)
    return AutomationRun.Outcome.DONE, ""
