from __future__ import annotations

import re

from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.authz.service import scope
from apps.contacts.models import Contact
from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import MembershipRefSerializer, owner_field
from apps.core.api.viewsets import TenantViewSet
from apps.core.concurrency import expected_version
from apps.helpdesk import services
from apps.helpdesk.models import MAX_DESCRIPTION_LENGTH, MAX_MESSAGE_LENGTH, MAX_SUBJECT_LENGTH, Ticket, TicketMessage
from apps.products.models import Product

# "#TK-1045", "TK1045" or "1045" in the search box finds the ticket by number.
_NUMBER_QUERY = re.compile(r"^#?(?:tk-?)?(\d{1,9})$", re.IGNORECASE)


class TicketContactSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    display_name = serializers.CharField(read_only=True)


class NamedRefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)


class TicketSerializer(serializers.ModelSerializer):
    owner = MembershipRefSerializer(read_only=True)
    contact = TicketContactSerializer(read_only=True)
    product = NamedRefSerializer(read_only=True)
    requester = serializers.SerializerMethodField()
    company = serializers.SerializerMethodField()
    due_at = serializers.SerializerMethodField()
    is_overdue = serializers.SerializerMethodField()

    class Meta:
        model = Ticket
        fields = [
            "id",
            "number",
            "subject",
            "description",
            "status",
            "priority",
            "category",
            "product",
            "contact",
            "company",
            "requester_name",
            "requester",
            "owner",
            "due_at",
            "is_overdue",
            "rating",
            "resolved_at",
            "version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_requester(self, obj: Ticket) -> str:
        return obj.contact.display_name if obj.contact is not None else obj.requester_name

    def get_company(self, obj: Ticket) -> dict | None:
        # The requester's company, named only for members who may see companies at all.
        if not self.context.get("show_company") or obj.contact is None or obj.contact.company is None:
            return None
        return {"id": str(obj.contact.company.pk), "name": obj.contact.company.name}

    def _hours(self) -> dict[str, int]:
        return self.context.get("sla_hours") or services.DEFAULT_SLA_HOURS

    def get_due_at(self, obj: Ticket) -> str | None:
        due = services.due_at(obj, self._hours())
        return due.isoformat() if due else None

    def get_is_overdue(self, obj: Ticket) -> bool:
        if obj.status not in services.ACTIVE_STATUSES:
            return False
        due = services.due_at(obj, self._hours())
        now = self.context.get("now")
        return bool(due is not None and now is not None and due < now)


class TicketMessageSerializer(serializers.ModelSerializer):
    author = MembershipRefSerializer(read_only=True)

    class Meta:
        model = TicketMessage
        fields = ["id", "kind", "channel", "author", "author_name", "body", "created_at"]
        read_only_fields = fields


class TicketMessageWriteSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=TicketMessage.Kind.choices, default=TicketMessage.Kind.REPLY)
    body = serializers.CharField(max_length=MAX_MESSAGE_LENGTH)
    send_via = serializers.ChoiceField(
        choices=[("", "Do not send"), ("email", "Email"), ("whatsapp", "WhatsApp")], required=False, default=""
    )


class TicketMergeSerializer(serializers.Serializer):
    into = serializers.UUIDField()


class TicketSlaSerializer(serializers.Serializer):
    low = serializers.IntegerField(min_value=1, max_value=services.MAX_SLA_HOURS, required=False)
    medium = serializers.IntegerField(min_value=1, max_value=services.MAX_SLA_HOURS, required=False)
    high = serializers.IntegerField(min_value=1, max_value=services.MAX_SLA_HOURS, required=False)
    urgent = serializers.IntegerField(min_value=1, max_value=services.MAX_SLA_HOURS, required=False)


class TicketWriteSerializer(serializers.Serializer):
    subject = serializers.CharField(max_length=MAX_SUBJECT_LENGTH, required=False)
    description = serializers.CharField(max_length=MAX_DESCRIPTION_LENGTH, required=False, allow_blank=True)
    status = serializers.ChoiceField(choices=Ticket.Status.choices, required=False)
    priority = serializers.ChoiceField(choices=Ticket.Priority.choices, required=False)
    category = serializers.ChoiceField(choices=Ticket.Category.choices, required=False)
    product_id = TenantPrimaryKeyRelatedField(
        source="product", model=Product, queryset_fn=lambda: Product.objects.all(), required=False, allow_null=True
    )
    # Tenant-scoped: an id from another organization does not validate. The service then checks
    # that the actor may see the contact.
    contact_id = TenantPrimaryKeyRelatedField(
        source="contact", model=Contact, queryset_fn=lambda: Contact.objects.all(), required=False, allow_null=True
    )
    requester_name = serializers.CharField(max_length=160, required=False, allow_blank=True)
    owner_id = owner_field()
    rating = serializers.IntegerField(min_value=1, max_value=5, required=False, allow_null=True)


FILTERS = FilterSet(
    filters={
        "status": Filter("choice", "status", choices=tuple(Ticket.Status.values)),
        "priority": Filter("choice", "priority", choices=tuple(Ticket.Priority.values)),
        "category": Filter("choice", "category", choices=tuple(Ticket.Category.values)),
        "product": Filter("uuid", "product_id"),
        "owner": Filter("owner", "owner_id"),
        "contact": Filter("uuid", "contact_id"),
    },
    sort_fields={
        "number": "number",
        "priority": "priority",
        "status": "status",
        "created_at": "created_at",
        "updated_at": "updated_at",
    },
    default_sort="-updated_at",
    search_fields=(
        "subject",
        "requester_name",
        "contact__first_name",
        "contact__last_name",
        "contact__company__name",
    ),
)


class TicketViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Support tickets. Viewing and editing follow the ``tickets.*`` scopes on the assignee."""

    permission_map = {
        "list": "tickets.view",
        "retrieve": "tickets.view",
        "summary": "tickets.view",
        "messages": "tickets.view",
        "activity": "tickets.view",
        "sla": "tickets.view",
        "merge": "tickets.update",
        "create": "tickets.create",
        "partial_update": "tickets.update",
        "destroy": "tickets.delete",
    }
    serializer_class = TicketSerializer

    def base_queryset(self):
        return Ticket.objects.select_related("owner__user", "contact__company", "product")

    def get_serializer_context(self):
        from django.utils import timezone

        context = super().get_serializer_context()
        actor = self.request.actor
        context["sla_hours"] = services.sla_hours(actor.organization)
        context["now"] = timezone.now()
        context["show_company"] = actor.scope_for("companies.view") is not None
        return context

    def filter_queryset(self, queryset):
        if self.action != "list":
            return queryset
        params = self.request.query_params.copy()
        number = _NUMBER_QUERY.match((params.get("q") or "").strip())
        if number:
            params.pop("q")
            queryset = queryset.filter(number=int(number.group(1)))
        if params.get("overdue") in ("1", "true"):
            queryset = queryset.filter(services.overdue_q(services.sla_hours(self.request.actor.organization)))
        params.pop("overdue", None)
        queryset, ordering = FILTERS.apply(queryset, params, actor=self.request.actor)
        return queryset.order_by(*ordering)

    def _read(self, ticket: Ticket) -> dict:
        return TicketSerializer(self.base_queryset().get(pk=ticket.pk), context=self.get_serializer_context()).data

    def create(self, request):
        ser = TicketWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        if not ser.validated_data.get("subject"):
            raise serializers.ValidationError({"subject": "Subject is required."})
        ticket = services.create_ticket(request.actor, ser.validated_data, request=request._request)
        return Response(self._read(ticket), status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        ticket = self.get_object()
        ser = TicketWriteSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        services.update_ticket(
            request.actor,
            ticket,
            ser.validated_data,
            expected_version=expected_version(request, request.data),
            request=request._request,
        )
        return Response(self._read(ticket))

    def destroy(self, request, pk=None):
        ticket = self.get_object()
        services.delete_ticket(request.actor, ticket, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["get"])
    def summary(self, request):
        return Response(services.summary(request.actor))

    @action(detail=False, methods=["get", "put"])
    def sla(self, request):
        """Hours to resolution per priority. Anyone with the helpdesk may read it; changing it needs org.update."""
        if request.method == "PUT":
            ser = TicketSlaSerializer(data=request.data)
            ser.is_valid(raise_exception=True)
            return Response(services.update_sla(request.actor, dict(ser.validated_data), request=request._request))
        return Response(services.sla_hours(request.actor.organization))

    @action(detail=True, methods=["get", "post"])
    def messages(self, request, pk=None):
        ticket = self.get_object()  # inside the actor's tickets.view scope, else 404
        if request.method == "POST":
            ser = TicketMessageWriteSerializer(data=request.data)
            ser.is_valid(raise_exception=True)
            message = services.add_message(request.actor, ticket, ser.validated_data, request=request._request)
            return Response(TicketMessageSerializer(message).data, status=status.HTTP_201_CREATED)
        rows = TicketMessage.objects.filter(ticket=ticket).select_related("author__user")[:500]
        return Response({"results": TicketMessageSerializer(rows, many=True).data})

    @action(detail=True, methods=["get"])
    def activity(self, request, pk=None):
        ticket = self.get_object()
        return Response({"results": services.activity(ticket)})

    @action(detail=True, methods=["post"])
    def merge(self, request, pk=None):
        source = self.get_object()
        ser = TicketMergeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        # The target must be a ticket the actor can see; anything else reads as not found.
        target = scope(request.actor, "tickets.view", Ticket.objects.filter(pk=ser.validated_data["into"])).first()
        if target is None:
            raise serializers.ValidationError({"into": "Ticket not found."})
        services.merge_ticket(request.actor, source, target, request=request._request)
        return Response(self._read(target))
