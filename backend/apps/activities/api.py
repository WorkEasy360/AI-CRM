from __future__ import annotations

import datetime as dt
from typing import Any

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts.models import Membership
from apps.activities import services
from apps.activities.models import Activity, ActivityAttendee
from apps.activities.queries import OPEN_STATUSES
from apps.companies.models import Company
from apps.contacts.models import Contact
from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import MembershipRefSerializer, active_memberships
from apps.core.api.viewsets import TenantViewSet
from apps.core.concurrency import expected_version
from apps.deals.models import Deal

MAX_CALENDAR_DAYS = 62
MAX_CALENDAR_ROWS = 1000


class RefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)


class ContactRefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(source="display_name", read_only=True)


class ActivitySerializer(serializers.ModelSerializer):
    owner = MembershipRefSerializer(read_only=True)
    contact = ContactRefSerializer(read_only=True)
    company = RefSerializer(read_only=True)
    deal = RefSerializer(read_only=True)
    attendees = serializers.SerializerMethodField()
    is_overdue = serializers.SerializerMethodField()

    class Meta:
        model = Activity
        fields = [
            "id",
            "kind",
            "title",
            "description",
            "status",
            "priority",
            "start_at",
            "end_at",
            "all_day",
            "duration_minutes",
            "timezone",
            "location",
            "meeting_url",
            "direction",
            "outcome",
            "reminder_minutes",
            "completed_at",
            "owner",
            "contact",
            "company",
            "deal",
            "attendees",
            "is_overdue",
            "version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_attendees(self, obj: Activity) -> list[dict[str, Any]]:
        attendees_map = self.context.get("attendees_map")
        if attendees_map is None:
            rows = ActivityAttendee.objects.filter(activity=obj).select_related("membership__user")
            return [{"id": str(a.membership_id), "display_name": a.membership.user.display_name} for a in rows]
        return attendees_map.get(obj.pk, [])

    def get_is_overdue(self, obj: Activity) -> bool:
        return bool(obj.is_open and obj.start_at is not None and obj.start_at < timezone.now())


def _active_contacts():
    return Contact.objects.filter(archived_at__isnull=True)


def _active_companies():
    return Company.objects.filter(archived_at__isnull=True)


def _active_deals():
    return Deal.objects.filter(archived_at__isnull=True)


class ActivityWriteSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=Activity.Kind.choices, required=False)
    title = serializers.CharField(max_length=160, required=False)
    description = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    status = serializers.ChoiceField(choices=Activity.Status.choices, required=False)
    priority = serializers.ChoiceField(choices=Activity.Priority.choices, required=False)
    start_at = serializers.DateTimeField(required=False, allow_null=True)
    end_at = serializers.DateTimeField(required=False, allow_null=True)
    all_day = serializers.BooleanField(required=False)
    duration_minutes = serializers.IntegerField(min_value=1, max_value=1440, required=False, allow_null=True)
    timezone = serializers.CharField(max_length=64, required=False, allow_blank=True)
    location = serializers.CharField(max_length=255, required=False, allow_blank=True)
    meeting_url = serializers.CharField(max_length=2048, required=False, allow_blank=True)
    direction = serializers.ChoiceField(choices=Activity.Direction.choices, required=False, allow_blank=True)
    outcome = serializers.ChoiceField(choices=Activity.Outcome.choices, required=False, allow_blank=True)
    reminder_minutes = serializers.IntegerField(min_value=0, max_value=43200, required=False, allow_null=True)
    contact_id = TenantPrimaryKeyRelatedField(
        source="contact", model=Contact, queryset_fn=_active_contacts, required=False, allow_null=True
    )
    company_id = TenantPrimaryKeyRelatedField(
        source="company", model=Company, queryset_fn=_active_companies, required=False, allow_null=True
    )
    deal_id = TenantPrimaryKeyRelatedField(
        source="deal", model=Deal, queryset_fn=_active_deals, required=False, allow_null=True
    )
    owner_id = TenantPrimaryKeyRelatedField(
        source="owner", model=Membership, queryset_fn=active_memberships, required=False, allow_null=True
    )
    attendee_ids = serializers.ListField(child=serializers.UUIDField(), required=False, max_length=50)
    completed = serializers.BooleanField(required=False)


class CompleteSerializer(serializers.Serializer):
    outcome = serializers.ChoiceField(choices=Activity.Outcome.choices, required=False, allow_blank=True)
    note = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    version = serializers.IntegerField(min_value=1, required=False)


def _due_filter(qs, key, raw):
    now = timezone.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if raw == "overdue":
        return qs.filter(status__in=OPEN_STATUSES, start_at__lt=now)
    if raw == "today":
        return qs.filter(start_at__gte=today_start, start_at__lt=today_start + dt.timedelta(days=1))
    if raw == "week":
        return qs.filter(start_at__gte=today_start, start_at__lt=today_start + dt.timedelta(days=7))
    if raw == "upcoming":
        return qs.filter(status__in=OPEN_STATUSES, start_at__gte=now)
    if raw == "none":
        return qs.filter(start_at__isnull=True)
    from rest_framework.exceptions import ValidationError

    raise ValidationError({"due": "Allowed values: overdue, today, week, upcoming, none."})


def _open_filter(qs, key, raw):
    from apps.core.api.filters import _bool

    return qs.filter(status__in=OPEN_STATUSES) if _bool(raw) else qs.exclude(status__in=OPEN_STATUSES)


FILTERS = FilterSet(
    filters={
        "owner": Filter("owner", "owner_id"),
        "kind": Filter("choice", "kind", choices=tuple(Activity.Kind.values)),
        "status": Filter("choice", "status", choices=tuple(Activity.Status.values)),
        "priority": Filter("choice", "priority", choices=tuple(Activity.Priority.values)),
        "contact": Filter("uuid", "contact_id"),
        "company": Filter("uuid", "company_id"),
        "deal": Filter("uuid", "deal_id"),
        "from": Filter("date_from", "start_at__date"),
        "to": Filter("date_to", "start_at__date"),
        "ids": Filter("uuid_list", "id"),
    },
    sort_fields={
        "start_at": "start_at",
        "created_at": "created_at",
        "updated_at": "updated_at",
        "priority": "priority",
        "title": "title",
    },
    default_sort="start_at",
    search_fields=("title", "description"),
    extra={"due": _due_filter, "open": _open_filter},
)


class ActivityViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Tasks, calls and meetings. Visibility follows ``activities.view`` scope on the owner; members
    invited to a meeting also see it on their calendar."""

    permission_map = {
        "list": "activities.view",
        "retrieve": "activities.view",
        "create": "activities.create",
        "partial_update": "activities.update",
        "destroy": "activities.delete",
        "complete": "activities.update",
        "reopen": "activities.update",
        "calendar": "activities.view",
        "summary": "activities.view",
    }
    serializer_class = ActivitySerializer
    filterset = FILTERS
    resolved_ordering: tuple[str, ...] | None = None

    def base_queryset(self):
        return Activity.objects.select_related("owner__user", "contact", "company", "deal").defer("search_vector")

    def get_queryset(self):
        qs = super().get_queryset()
        if self.action in {"list", "calendar", "summary", "retrieve"}:
            # Attendees always see what they were invited to, whatever their owner scope says.
            invited = ActivityAttendee.objects.filter(membership_id=self.request.actor.membership.id).values(
                "activity_id"
            )
            qs = self.base_queryset().filter(Q(pk__in=qs.values("pk")) | Q(pk__in=invited))
        return qs

    def filter_queryset(self, queryset):
        if self.action == "list":
            params = self.request.query_params.dict()
            queryset, ordering = self.filterset.apply(queryset, params, actor=self.request.actor)
            self.resolved_ordering = ordering
        return queryset

    def _context(self, objs: list[Activity]) -> dict[str, Any]:
        ctx = dict(self.get_serializer_context())
        attendees: dict[Any, list[dict[str, Any]]] = {o.pk: [] for o in objs}
        if objs:
            rows = ActivityAttendee.objects.filter(activity_id__in=[o.pk for o in objs]).select_related(
                "membership__user"
            )
            for a in rows:
                attendees.setdefault(a.activity_id, []).append(
                    {"id": str(a.membership_id), "display_name": a.membership.user.display_name}
                )
        ctx["attendees_map"] = attendees
        return ctx

    def _read(self, activity: Activity) -> dict[str, Any]:
        obj = self.base_queryset().get(pk=activity.pk)
        return ActivitySerializer(obj, context=self._context([obj])).data

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        objs = list(page if page is not None else queryset)
        data = ActivitySerializer(objs, many=True, context=self._context(objs)).data
        return self.get_paginated_response(data) if page is not None else Response({"results": data})

    def retrieve(self, request, *args, **kwargs):
        obj = self.get_object()
        return Response(ActivitySerializer(obj, context=self._context([obj])).data)

    def create(self, request):
        ser = ActivityWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        activity = services.create_activity(request.actor, dict(ser.validated_data), request=request._request)
        return Response(self._read(activity), status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        activity = self.get_object()
        ser = ActivityWriteSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        version = expected_version(request._request, request.data)
        services.update_activity(
            request.actor, activity, dict(ser.validated_data), expected_version=version, request=request._request
        )
        return Response(self._read(activity))

    def destroy(self, request, pk=None):
        activity = self.get_object()
        services.delete_activity(request.actor, activity, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        activity = self.get_object()
        ser = CompleteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        version = expected_version(request._request, request.data, required=False)
        services.complete_activity(
            request.actor,
            activity,
            expected_version=version,
            outcome=ser.validated_data.get("outcome") or None,
            note=ser.validated_data.get("note") or None,
            request=request._request,
        )
        return Response(self._read(activity))

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        activity = self.get_object()
        version = expected_version(request._request, request.data, required=False)
        services.update_activity(
            request.actor,
            activity,
            {"status": Activity.Status.OPEN},
            expected_version=version,
            request=request._request,
        )
        return Response(self._read(activity))

    @action(detail=False, methods=["get"])
    def calendar(self, request):
        """Everything with a start inside ``from``..``to`` (max 62 days), for the month/week/day views."""
        from rest_framework.exceptions import ValidationError

        try:
            start = dt.date.fromisoformat(request.query_params.get("from", ""))
            end = dt.date.fromisoformat(request.query_params.get("to", ""))
        except ValueError as exc:
            raise ValidationError({"from": "Provide from and to as ISO dates (YYYY-MM-DD)."}) from exc
        if end < start or (end - start).days > MAX_CALENDAR_DAYS:
            raise ValidationError({"to": f"The range must cover at most {MAX_CALENDAR_DAYS} days."})
        qs = self.get_queryset().filter(start_at__date__gte=start, start_at__date__lte=end)
        owner = request.query_params.get("owner")
        if owner == "me":
            qs = qs.filter(
                Q(owner_id=request.actor.membership.id)
                | Q(
                    pk__in=ActivityAttendee.objects.filter(membership_id=request.actor.membership.id).values(
                        "activity_id"
                    )
                )
            )
        kinds = [k for k in (request.query_params.get("kind") or "").split(",") if k]
        if kinds:
            if any(k not in Activity.Kind.values for k in kinds):
                raise ValidationError({"kind": "Unknown kind."})
            qs = qs.filter(kind__in=kinds)
        objs = list(qs.order_by("start_at", "id")[:MAX_CALENDAR_ROWS])
        return Response({"results": ActivitySerializer(objs, many=True, context=self._context(objs)).data})

    @action(detail=False, methods=["get"])
    def summary(self, request):
        """Counters for the header and dashboard, computed inside the actor's scope in one query."""
        now = timezone.now()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week_end = today_start + dt.timedelta(days=7)
        qs = self.get_queryset()
        mine = qs.filter(owner_id=request.actor.membership.id) if request.query_params.get("owner") == "me" else qs
        agg = mine.aggregate(
            overdue=Count("id", filter=Q(status__in=OPEN_STATUSES, start_at__lt=now)),
            due_today=Count(
                "id",
                filter=Q(
                    status__in=OPEN_STATUSES, start_at__gte=today_start, start_at__lt=today_start + dt.timedelta(days=1)
                ),
            ),
            open_tasks=Count("id", filter=Q(kind=Activity.Kind.TASK, status__in=OPEN_STATUSES)),
            meetings_week=Count(
                "id",
                filter=Q(
                    kind=Activity.Kind.MEETING, status__in=OPEN_STATUSES, start_at__gte=now, start_at__lt=week_end
                ),
            ),
            calls_week=Count(
                "id",
                filter=Q(kind=Activity.Kind.CALL, status__in=OPEN_STATUSES, start_at__gte=now, start_at__lt=week_end),
            ),
        )
        return Response(agg)
