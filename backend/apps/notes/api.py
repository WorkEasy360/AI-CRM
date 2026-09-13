from __future__ import annotations

from rest_framework import mixins, serializers, status
from rest_framework.response import Response

from apps.core.api.serializers import MembershipRefSerializer
from apps.core.api.viewsets import TenantAPIView, TenantViewSet
from apps.notes import services, timeline
from apps.notes.models import MAX_NOTE_LENGTH, NOTE_ENTITY_TYPES, Note
from apps.notes.registry import resolve_viewable


class NoteSerializer(serializers.ModelSerializer):
    author = MembershipRefSerializer(read_only=True)

    class Meta:
        model = Note
        fields = ["id", "entity_type", "entity_id", "body", "author", "pinned", "edited_at", "created_at", "updated_at"]
        read_only_fields = fields


class NoteCreateSerializer(serializers.Serializer):
    entity_type = serializers.ChoiceField(choices=[(e, e) for e in NOTE_ENTITY_TYPES])
    entity_id = serializers.UUIDField()
    body = serializers.CharField(max_length=MAX_NOTE_LENGTH)
    pinned = serializers.BooleanField(required=False, default=False)


class NoteUpdateSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=MAX_NOTE_LENGTH, required=False)
    pinned = serializers.BooleanField(required=False)


class EntityQuerySerializer(serializers.Serializer):
    entity_type = serializers.ChoiceField(choices=[(e, e) for e in NOTE_ENTITY_TYPES])
    entity_id = serializers.UUIDField()


class NoteViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Notes are visible to anyone who can view the parent record; editing follows ``notes.update``
    scopes (a rep edits own notes, managers edit all)."""

    permission_map = {
        "list": "notes.view",
        "retrieve": "notes.view",
        "create": "notes.create",
        "partial_update": "notes.update",
        "destroy": "notes.delete",
    }
    serializer_class = NoteSerializer
    resolved_ordering = ("-pinned", "-created_at", "-id")

    def base_queryset(self):
        return Note.objects.select_related("author__user")

    def get_queryset(self):
        # Viewing notes is gated by the *record*, not by note ownership: resolve the record within the
        # actor's view scope first, then list its notes.
        if self.action == "list":
            params = self.request.query_params
            if not params.get("entity_type") and not params.get("entity_id"):
                # No record given: the actor's own notes (always visible to their author).
                return self.base_queryset().filter(author=self.request.actor.membership)
            ser = EntityQuerySerializer(data=params)
            ser.is_valid(raise_exception=True)
            record = resolve_viewable(
                self.request.actor, ser.validated_data["entity_type"], ser.validated_data["entity_id"]
            )
            return self.base_queryset().filter(entity_type=ser.validated_data["entity_type"], entity_id=record.pk)
        if self.action == "retrieve":
            return self.base_queryset()
        return super().get_queryset()

    def get_object(self):
        """A note is addressable only if its record is within the actor's view scope (404 otherwise);
        the action's permission is then checked against the note's author (403)."""
        from django.shortcuts import get_object_or_404

        from apps.authz.service import check

        note = get_object_or_404(self.base_queryset(), pk=self.kwargs["pk"])
        resolve_viewable(self.request.actor, note.entity_type, note.entity_id)
        check(self.request.actor, self.current_permission(), note)
        return note

    def create(self, request):
        ser = NoteCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        note = services.create_note(request.actor, request=request._request, **ser.validated_data)
        return Response(NoteSerializer(self.base_queryset().get(pk=note.pk)).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        note = self.get_object()
        ser = NoteUpdateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.update_note(request.actor, note, request=request._request, **ser.validated_data)
        return Response(NoteSerializer(self.base_queryset().get(pk=note.pk)).data)

    def destroy(self, request, pk=None):
        note = self.get_object()
        services.delete_note(request.actor, note, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TimelineView(TenantAPIView):
    permission_map = {"GET": "notes.view"}

    def get(self, request):
        ser = EntityQuerySerializer(data=request.query_params)
        ser.is_valid(raise_exception=True)
        entity_type = ser.validated_data["entity_type"]
        record = resolve_viewable(request.actor, entity_type, ser.validated_data["entity_id"])
        raw_kinds = (request.query_params.get("kinds") or "").strip()
        kinds = {k.strip() for k in raw_kinds.split(",") if k.strip()} if raw_kinds else None
        if kinds is not None and (len(kinds) > 20 or any(len(k) > 40 for k in kinds)):
            raise serializers.ValidationError({"kinds": "Too many or too long kind filters."})
        return Response({"results": timeline.build(request.actor, entity_type, record, kinds=kinds)})
