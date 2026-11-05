from __future__ import annotations

from django.db import models

from apps.core.models import TenantModel

MAX_DELAY_DAYS = 90


class AutomationRule(TenantModel):
    """When <trigger> happens to a record, do <action> for the record's owner.

    Rules act *as the record owner*: tasks and WhatsApp messages go through the activities and messaging
    services with the owner's own permissions, so an automation can never do more than the person it
    works for. WhatsApp sends also keep every messaging rule: an approved template, the contact's
    recorded consent, the plan's WhatsApp feature.
    """

    class Trigger(models.TextChoices):
        CONTACT_CREATED = "contact_created", "A contact is created"
        DEAL_CREATED = "deal_created", "A deal is created"
        DEAL_WON = "deal_won", "A deal is won"
        DEAL_LOST = "deal_lost", "A deal is lost"
        DEAL_STAGE_ENTERED = "deal_stage_entered", "A deal enters a stage"

    class Action(models.TextChoices):
        CREATE_TASK = "create_task", "Create a follow-up task for the owner"
        NOTIFY_OWNER = "notify_owner", "Notify the owner"
        NOTIFY_TEAM = "notify_team", "Notify the owner's team"
        SEND_WHATSAPP = "send_whatsapp", "Send a WhatsApp template to the contact"

    name = models.CharField(max_length=120)
    description = models.CharField(max_length=255, blank=True)
    trigger = models.CharField(max_length=32, choices=Trigger.choices)
    # For DEAL_STAGE_ENTERED: the stage the deal has to enter (and still be in when the rule acts).
    stage = models.ForeignKey(
        "pipelines.PipelineStage", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    action = models.CharField(max_length=32, choices=Action.choices)
    # Task title, or the notification's text. Plain text, no templating.
    message = models.CharField(max_length=200, blank=True)
    # Tasks: due this many days after the trigger. Notifications and WhatsApp: sent this many days after.
    delay_days = models.PositiveSmallIntegerField(default=0)
    # When set, the action waits ``delay_days`` and is skipped if the contact has written back meanwhile.
    only_if_no_reply = models.BooleanField(default=False)
    whatsapp_template = models.ForeignKey(
        "messaging.WhatsAppTemplate", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    # One value per {{n}} of the template; may use {{first_name}}-style merge fields.
    template_params = models.JSONField(default=list, blank=True)
    is_enabled = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    run_count = models.PositiveIntegerField(default=0)
    last_run_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=models.Q(delay_days__lte=MAX_DELAY_DAYS), name="automation_delay_range"),
        ]
        indexes = [models.Index(fields=["organization", "trigger", "is_enabled"], name="automation_org_trigger_idx")]
        ordering = ["created_at"]


class AutomationRun(TenantModel):
    """One rule fired for one record. The unique key makes a re-delivered event a no-op.

    A run starts PENDING with the time it is due; it is acted on then (by the triggering task, or by the
    ``automation.run_due`` sweep for delayed rules and for organizations whose access was paused).
    """

    class Outcome(models.TextChoices):
        PENDING = "pending", "Pending"
        DONE = "done", "Done"
        SKIPPED = "skipped", "Skipped"

    rule = models.ForeignKey(AutomationRule, on_delete=models.CASCADE, related_name="runs")
    entity_type = models.CharField(max_length=16)
    entity_id = models.UUIDField()
    outcome = models.CharField(max_length=16, choices=Outcome.choices)
    due_at = models.DateTimeField(null=True, blank=True)
    detail = models.CharField(max_length=200, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "rule", "entity_id"], name="uniq_automation_run"),
        ]
        indexes = [
            models.Index(fields=["due_at"], condition=models.Q(outcome="pending"), name="automation_run_due_idx"),
        ]
