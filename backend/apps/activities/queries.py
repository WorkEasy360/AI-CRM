"""Reusable ORM fragments for activities that other modules annotate onto their own querysets."""

from __future__ import annotations

from django.db.models import CharField, OuterRef, Subquery, Value
from django.db.models.functions import Coalesce
from django.utils import timezone

OPEN_STATUSES = ("open", "in_progress")


def next_open_activities(relation: str):
    """Open activities of the outer record (``relation``: contact, company or deal) that are still
    ahead, soonest first. Used for "next activity" annotations and stamps."""
    from apps.activities.models import Activity

    return (
        Activity.objects.filter(**{relation: OuterRef("pk")}, status__in=OPEN_STATUSES, start_at__gte=timezone.now())
        .order_by("start_at")
        .values("title")[:1]
    )


def next_activity_title_subquery(relation: str):
    return Coalesce(Subquery(next_open_activities(relation), output_field=CharField()), Value(""))
