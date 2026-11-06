"""Automation rules are organization configuration: managed with ``automation.manage`` and audited."""

from __future__ import annotations

from typing import Any

from django.db import transaction
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.automation.models import MAX_DELAY_DAYS, AutomationRule
from apps.billing import entitlements
from apps.core import validators

MAX_TEMPLATE_PARAMS = 10


def _clean(data: dict[str, Any], *, partial: bool) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "name" in data or not partial:
        name = validators.clean_text(data.get("name"), max_length=120)
        if not name:
            raise ValidationError({"name": "Name is required."})
        out["name"] = name
    if "description" in data:
        out["description"] = validators.clean_text(data["description"], max_length=255)
    if "message" in data:
        out["message"] = validators.clean_text(data["message"], max_length=200)
    if "delay_days" in data:
        days = data["delay_days"]
        if days is None or not 0 <= int(days) <= MAX_DELAY_DAYS:
            raise ValidationError({"delay_days": f"Enter 0 to {MAX_DELAY_DAYS} days."})
        out["delay_days"] = int(days)
    for key in ("trigger", "action", "is_enabled", "only_if_no_reply"):
        if key in data and data[key] is not None:
            out[key] = data[key]
    if "stage_id" in data:
        out["stage"] = _stage(data["stage_id"])
    if "whatsapp_template_id" in data:
        out["whatsapp_template"] = _template(data["whatsapp_template_id"])
    if "template_params" in data:
        raw = data["template_params"] or []
        if not isinstance(raw, list) or len(raw) > MAX_TEMPLATE_PARAMS:
            raise ValidationError({"template_params": f"Enter at most {MAX_TEMPLATE_PARAMS} values."})
        out["template_params"] = [validators.clean_text(str(v), max_length=200) for v in raw]
    if not partial:
        for key in ("trigger", "action"):
            if key not in out:
                raise ValidationError({key: "This field is required."})
    return out


def _stage(raw: Any):
    from apps.pipelines.models import PipelineStage

    if not raw:
        return None
    # Tenant-scoped manager: another organization's stage id is simply "not found".
    stage = PipelineStage.objects.filter(pk=raw, archived_at__isnull=True).first()
    if stage is None:
        raise ValidationError({"stage_id": "Choose one of this workspace's pipeline stages."})
    return stage


def _check_trigger(final: dict[str, Any]) -> dict[str, Any]:
    """A stage rule needs its stage; other triggers drop it."""
    if final["trigger"] != AutomationRule.Trigger.DEAL_STAGE_ENTERED:
        return {"stage": None}
    if final["stage"] is None:
        raise ValidationError({"stage_id": "Choose the stage the deal has to enter."})
    return {}


def _template(raw: Any):
    from apps.messaging.models import WhatsAppTemplate

    if not raw:
        return None
    # Tenant-scoped manager: another organization's template id is simply "not found".
    template = WhatsAppTemplate.objects.filter(pk=raw).first()
    if template is None:
        raise ValidationError({"whatsapp_template_id": "Choose one of this workspace's WhatsApp templates."})
    return template


def _check_action(actor: Actor, final: dict[str, Any]) -> dict[str, Any]:
    """Validate the rule as it will be saved; WhatsApp-only settings are cleared for other actions."""
    if final["action"] != AutomationRule.Action.SEND_WHATSAPP:
        return {"whatsapp_template": None, "template_params": []}
    entitlements.check_feature(actor.organization, "whatsapp")
    template = final["whatsapp_template"]
    if template is None:
        raise ValidationError({"whatsapp_template_id": "Choose the approved WhatsApp template to send."})
    params = final["template_params"]
    if len(params) != template.parameter_count or any(not p for p in params):
        raise ValidationError(
            {"template_params": f"This template needs {template.parameter_count} value(s), none of them empty."}
        )
    return {}


@transaction.atomic
def create_rule(actor: Actor, data: dict[str, Any], *, request: Any = None) -> AutomationRule:
    check(actor, "automation.manage")
    fields = _clean(data, partial=False)
    fields.setdefault("whatsapp_template", None)
    fields.setdefault("template_params", [])
    fields.setdefault("stage", None)
    fields.update(_check_action(actor, fields))
    fields.update(_check_trigger(fields))
    # Plan limit: the edition's automation_rules allowance (counted live, see apps.py).
    entitlements.check_capacity(actor.organization, "automation_rules")
    rule = AutomationRule.objects.create(created_by=actor.membership, **fields)
    audit.record(
        "automation.created",
        request=request,
        user=actor.user,
        resource=rule,
        metadata={
            "name": rule.name,
            "trigger": rule.trigger,
            "action": rule.action,
            "whatsapp_template_id": str(rule.whatsapp_template_id) if rule.whatsapp_template_id else None,
        },
    )
    return rule


@transaction.atomic
def update_rule(actor: Actor, rule: AutomationRule, data: dict[str, Any], *, request: Any = None) -> AutomationRule:
    check(actor, "automation.manage")
    fields = _clean(data, partial=True)
    final = {
        k: fields.get(k, getattr(rule, k))
        for k in ("action", "whatsapp_template", "template_params", "trigger", "stage")
    }
    fields.update(_check_action(actor, final))
    fields.update(_check_trigger(final))
    before = {k: getattr(rule, k) for k, v in fields.items() if getattr(rule, k) != v}
    if not before:
        return rule
    for key in before:
        setattr(rule, key, fields[key])
    rule.save(update_fields=[*before, "updated_at"])
    audit.record(
        "automation.updated",
        request=request,
        user=actor.user,
        resource=rule,
        metadata={"before": _plain(before), "after": _plain({k: getattr(rule, k) for k in before})},
    )
    return rule


def _plain(values: dict[str, Any]) -> dict[str, Any]:
    """Audit metadata is JSON: a template is recorded by its id."""
    return {k: (str(v.pk) if hasattr(v, "pk") else v) for k, v in values.items()}


@transaction.atomic
def delete_rule(actor: Actor, rule: AutomationRule, *, request: Any = None) -> None:
    check(actor, "automation.manage")
    audit.record("automation.deleted", request=request, user=actor.user, resource=rule, metadata={"name": rule.name})
    rule.delete()
