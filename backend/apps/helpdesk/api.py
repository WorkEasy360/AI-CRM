from __future__ import annotations

from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.contacts.models import Contact
from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import MembershipRefSerializer, owner_field
from apps.core.api.viewsets import TenantViewSet
from apps.core.concurrency import expected_version
from apps.helpdesk import services
from apps.helpdesk.models import MAX_DESCRIPTION_LENGTH, MAX_SUBJECT_LENGTH, Ticket


class TicketContactSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    display_name = serializers.CharField(read_only=True)


class TicketSerializer(serializers.ModelSerializer):
    owner = MembershipRefSerializer(read_only=True)
    contact = TicketContactSerializer(read_only=True)
    requester = serializers.SerializerMethodField()

    class Meta:
        model = Ticket
        fields = [
            "id",
            "number",
            "subject",
            "description",
            "status",
            "priority",
            "contact",
            "requester_name",
            "requester",
            "owner",
            "rating",
            "resolved_at",
            "version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_requester(self, obj: Ticket) -> str:
        return obj.contact.display_name if obj.contact is not None else obj.requester_name


class TicketWriteSerializer(serializers.Serializer):
    subject = serializers.CharField(max_length=MAX_SUBJECT_LENGTH, required=False)
    description = serializers.CharField(max_length=MAX_DESCRIPTION_LENGTH, required=False, allow_blank=True)
    status = serializers.ChoiceField(choices=Ticket.Status.choices, required=False)
    priority = serializers.ChoiceField(choices=Ticket.Priority.choices, required=False)
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
    search_fields=("subject", "requester_name", "contact__first_name", "contact__last_name"),
)


class TicketViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Support tickets. Viewing and editing follow the ``tickets.*`` scopes on the assignee."""

    permission_map = {
        "list": "tickets.view",
        "retrieve": "tickets.view",
        "summary": "tickets.view",
        "create": "tickets.create",
        "partial_update": "tickets.update",
        "destroy": "tickets.delete",
    }
    serializer_class = TicketSerializer

    def base_queryset(self):
        return Ticket.objects.select_related("owner__user", "contact")

    def filter_queryset(self, queryset):
        if self.action != "list":
            return queryset
        queryset, ordering = FILTERS.apply(queryset, self.request.query_params, actor=self.request.actor)
        return queryset.order_by(*ordering)

    def _read(self, ticket: Ticket) -> dict:
        return TicketSerializer(self.base_queryset().get(pk=ticket.pk)).data

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
