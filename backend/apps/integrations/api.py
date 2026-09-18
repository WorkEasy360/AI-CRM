"""Integration Hub API. Administration lives under Settings; every route declares its permission."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from django.conf import settings
from django.http import HttpResponseRedirect
from rest_framework import mixins, status
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authz.service import has
from apps.core.api.request import ActorRequest
from apps.core.api.viewsets import TenantAPIView, TenantViewSet
from apps.core.exceptions import DomainError
from apps.integrations import errors, events, fields, scopes, services, webhooks
from apps.integrations import serializers as s
from apps.integrations import sync as sync_service
from apps.integrations.delivery import send_test
from apps.integrations.models import (
    ApiCredential,
    ConflictStrategy,
    Direction,
    FieldMapping,
    IntegrationConnection,
    OutboundDelivery,
    SharingPolicy,
    SyncConflict,
    SyncJob,
    WebhookSubscription,
)
from apps.integrations.providers import all_providers


class IntegrationCatalogView(TenantAPIView):
    """Cards for Settings → Integrations: connected and available integrations."""

    permission_map = {"GET": "integrations.view"}
    throttle_scope = "admin"

    def get(self, request: ActorRequest) -> Response:
        connections = list(IntegrationConnection.objects.select_related("connected_by__user").order_by("name"))
        items: list[dict[str, Any]] = []
        for provider in all_providers():
            item: dict[str, Any] = {
                "key": provider.key,
                "name": provider.name,
                "description": provider.description,
                "category": provider.category,
                "auth_types": list(provider.auth_types),
                "manage_url": provider.managed_elsewhere,
                "supports_sync": provider.supports_sync,
                "supports_inbound_webhooks": provider.supports_inbound_webhooks,
            }
            if provider.managed_elsewhere:
                item.update(provider.summary(request.actor))  # type: ignore[attr-defined]
                item["connections"] = []
            else:
                mine = [c for c in connections if c.provider == provider.key]
                item["connections"] = s.ConnectionSerializer(mine, many=True).data
                item["status"] = "connected" if mine else "available"
                item["connected_count"] = len(mine)
            items.append(item)
        return Response(
            {
                "results": items,
                "can_manage": has(request.actor, "integrations.manage"),
                "can_manage_webhooks": has(request.actor, "webhooks.manage"),
            }
        )


class IntegrationOptionsView(TenantAPIView):
    """Everything the mapping editor may offer. Fields come from the server allowlist, never the client."""

    permission_map = {"GET": "integrations.view"}
    throttle_scope = "admin"

    def get(self, request: ActorRequest) -> Response:
        entities = []
        for key, spec in fields.ENTITIES.items():
            entry: dict[str, Any] = {
                "key": key,
                "label": spec.label,
                "shareable": spec.shareable,
                "reason": spec.reason,
            }
            if spec.shareable:
                entry.update(
                    outbound_fields=fields.allowed_fields(key, direction="outbound"),
                    inbound_fields=fields.allowed_fields(key, direction="inbound"),
                    inbound_create=spec.inbound_create,
                )
            entities.append(entry)
        return Response(
            {
                "entities": entities,
                "directions": [{"key": k, "label": label} for k, label in Direction.choices],
                "conflict_strategies": [{"key": k, "label": label} for k, label in ConflictStrategy.choices],
                "sync_intervals": list(settings.INTEGRATIONS_SYNC_INTERVALS),
                "webhook_event_types": list(events.WEBHOOK_EVENT_TYPES),
                "api_scopes": [{"key": sc.key, "label": sc.label} for sc in scopes.API_SCOPES.values()],
                "api_key_max_days": settings.INTEGRATIONS_API_KEY_MAX_DAYS,
                "oauth_redirect_uri": services.oauth_redirect_uri(),
            }
        )


class ConnectionViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "integrations.view",
        "retrieve": "integrations.view",
        "jobs": "integrations.view",
        "conflicts": "integrations.view",
        "deliveries": "integrations.view",
        "sharing": "integrations.manage",
        "create": "integrations.manage",
        "partial_update": "integrations.manage",
        "destroy": "integrations.manage",
        "test": "integrations.manage",
        "sync": "integrations.manage",
        "pause": "integrations.manage",
        "resume": "integrations.manage",
        "disconnect": "integrations.manage",
        "credentials": "integrations.manage",
        "oauth_start": "integrations.manage",
        "inbound": "integrations.manage",
        "rotate_inbound_secret": "integrations.manage",  # nosec B105 - action name, not a secret
        "resolve_conflict": "integrations.manage",
    }
    serializer_class = s.ConnectionSerializer
    throttle_scope = "admin"

    def base_queryset(self):
        return IntegrationConnection.objects.select_related("connected_by__user").order_by("name")

    def _detail(self, connection: IntegrationConnection) -> dict[str, Any]:
        connection = self.base_queryset().get(pk=connection.pk)
        data = dict(s.ConnectionSerializer(connection).data)
        mappings: dict[str, list[dict[str, str]]] = {}
        for m in FieldMapping.objects.filter(connection=connection).order_by("crm_field"):
            mappings.setdefault(m.entity_type, []).append(
                {"crm_field": m.crm_field, "external_field": m.external_field}
            )
        data["sharing"] = [
            {
                "entity_type": p.entity_type,
                "direction": p.direction,
                "external_resource": p.external_resource,
                "mappings": mappings.get(p.entity_type, []),
            }
            for p in SharingPolicy.objects.filter(connection=connection).order_by("entity_type")
        ]
        latest = (
            SyncJob.objects.select_related("connection").filter(connection=connection).order_by("-created_at").first()
        )
        data["latest_job"] = s.SyncJobSerializer(latest).data if latest else None
        data["open_conflicts"] = SyncConflict.objects.filter(
            connection=connection, status=SyncConflict.Status.OPEN
        ).count()
        data["failed_deliveries"] = OutboundDelivery.objects.filter(
            connection=connection, status__in=[OutboundDelivery.Status.FAILED, OutboundDelivery.Status.DEAD]
        ).count()
        return data

    def retrieve(self, request, *args, **kwargs) -> Response:
        return Response(self._detail(self.get_object()))

    def create(self, request: ActorRequest) -> Response:
        ser = s.ConnectionCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        connection = services.create_connection(request.actor, request=request._request, **ser.validated_data)
        return Response(self._detail(connection), status=status.HTTP_201_CREATED)

    def partial_update(self, request: ActorRequest, pk=None) -> Response:
        connection = self.get_object()
        ser = s.ConnectionUpdateSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        services.update_connection(request.actor, connection, request=request._request, **ser.validated_data)
        return Response(self._detail(connection))

    def destroy(self, request: ActorRequest, pk=None) -> Response:
        services.delete_connection(request.actor, self.get_object(), request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def test(self, request: ActorRequest, pk=None) -> Response:
        return Response(services.test_connection(request.actor, self.get_object()))

    @action(detail=True, methods=["post"])
    def sync(self, request: ActorRequest, pk=None) -> Response:
        job = services.start_sync(request.actor, self.get_object(), request=request._request)
        job = SyncJob.objects.select_related("connection").get(pk=job.pk)
        return Response(s.SyncJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["post"])
    def pause(self, request: ActorRequest, pk=None) -> Response:
        connection = services.set_paused(request.actor, self.get_object(), paused=True, request=request._request)
        return Response(self._detail(connection))

    @action(detail=True, methods=["post"])
    def resume(self, request: ActorRequest, pk=None) -> Response:
        connection = services.set_paused(request.actor, self.get_object(), paused=False, request=request._request)
        return Response(self._detail(connection))

    @action(detail=True, methods=["post"])
    def disconnect(self, request: ActorRequest, pk=None) -> Response:
        connection = services.disconnect(request.actor, self.get_object(), request=request._request)
        return Response(self._detail(connection))

    @action(detail=True, methods=["post"])
    def credentials(self, request: ActorRequest, pk=None) -> Response:
        connection = self.get_object()  # 404 for foreign ids before anything about the body is revealed
        ser = s.CredentialsSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        connection = services.rotate_credentials(
            request.actor, connection, credentials=ser.validated_data["credentials"], request=request._request
        )
        return Response(self._detail(connection))

    @action(detail=True, methods=["post"], url_path="oauth/start")
    def oauth_start(self, request: ActorRequest, pk=None) -> Response:
        url = services.start_oauth(request.actor, self.get_object(), request=request._request)
        return Response({"authorization_url": url})

    @action(detail=True, methods=["put"])
    def sharing(self, request: ActorRequest, pk=None) -> Response:
        connection = self.get_object()
        ser = s.SharingInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.set_sharing(request.actor, connection, request=request._request, **ser.validated_data)
        return Response(self._detail(connection))

    @action(detail=True, methods=["post"])
    def inbound(self, request: ActorRequest, pk=None) -> Response:
        """Enable (or re-create) the inbound webhook endpoint. URL and secret are shown only in this response."""
        return Response(services.enable_inbound(request.actor, self.get_object(), request=request._request))

    @action(detail=True, methods=["post"], url_path="inbound/rotate-secret")
    def rotate_inbound_secret(self, request: ActorRequest, pk=None) -> Response:
        return Response(services.rotate_inbound_secret(request.actor, self.get_object(), request=request._request))

    @action(detail=True, methods=["get"])
    def jobs(self, request: ActorRequest, pk=None) -> Response:
        connection = self.get_object()
        qs = SyncJob.objects.select_related("connection").filter(connection=connection).order_by("-created_at")[:20]
        return Response({"results": s.SyncJobSerializer(qs, many=True).data})

    @action(detail=True, methods=["get"])
    def deliveries(self, request: ActorRequest, pk=None) -> Response:
        connection = self.get_object()
        qs = OutboundDelivery.objects.filter(connection=connection).order_by("-created_at")[:50]
        return Response({"results": s.DeliverySerializer(qs, many=True).data})

    @action(detail=True, methods=["get"])
    def conflicts(self, request: ActorRequest, pk=None) -> Response:
        connection = self.get_object()
        qs = SyncConflict.objects.filter(connection=connection, status=SyncConflict.Status.OPEN).order_by(
            "-created_at"
        )[:100]
        return Response({"results": s.ConflictSerializer(qs, many=True).data})

    @action(detail=True, methods=["post"], url_path=r"conflicts/(?P<conflict_id>[0-9a-f-]{36})/resolve")
    def resolve_conflict(self, request: ActorRequest, pk=None, conflict_id=None) -> Response:
        connection = self.get_object()
        conflict = (
            SyncConflict.objects.select_related("connection").filter(connection=connection, pk=conflict_id).first()
        )
        if conflict is None:
            return Response({"type": "not_found", "title": "Not found", "status": 404}, status=404)
        ser = s.ConflictResolutionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        conflict = sync_service.resolve_conflict(
            request.actor, conflict, resolution=ser.validated_data["resolution"], request=request._request
        )
        return Response(s.ConflictSerializer(conflict).data)


class IntegrationOAuthCallbackView(TenantAPIView):
    """The provider redirects the browser here. The session identifies the member; ``state`` must match."""

    permission_map = {"GET": "integrations.manage"}
    throttle_scope = "sensitive"

    def get(self, request: ActorRequest) -> HttpResponseRedirect:
        state = request.query_params.get("state", "")
        code = request.query_params.get("code", "")
        target = f"{settings.FRONTEND_ORIGIN}/settings/integrations"
        if request.query_params.get("error"):
            return HttpResponseRedirect(f"{target}?{urlencode({'oauth': 'denied'})}")
        try:
            connection = services.complete_oauth(request.actor, state=state, code=code, request=request._request)
        except DomainError as exc:
            return HttpResponseRedirect(f"{target}?{urlencode({'oauth': 'error', 'code': exc.code})}")
        return HttpResponseRedirect(f"{target}/{connection.pk}?{urlencode({'oauth': 'connected'})}")


class WebhookSubscriptionViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "webhooks.manage",
        "retrieve": "webhooks.manage",
        "create": "webhooks.manage",
        "partial_update": "webhooks.manage",
        "destroy": "webhooks.manage",
        "rotate_secret": "webhooks.manage",  # nosec B105 - action name, not a secret
        "pause": "webhooks.manage",
        "resume": "webhooks.manage",
        "test": "webhooks.manage",
        "deliveries": "webhooks.manage",
    }
    serializer_class = s.WebhookSubscriptionSerializer
    throttle_scope = "admin"

    def base_queryset(self):
        return WebhookSubscription.objects.select_related("created_by__user").order_by("name")

    def _read(self, subscription: WebhookSubscription) -> dict[str, Any]:
        return dict(s.WebhookSubscriptionSerializer(self.base_queryset().get(pk=subscription.pk)).data)

    def create(self, request: ActorRequest) -> Response:
        ser = s.WebhookCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        subscription, secret = webhooks.create_subscription(
            request.actor, request=request._request, **ser.validated_data
        )
        # The signing secret is returned exactly once.
        return Response({**self._read(subscription), "secret": secret}, status=status.HTTP_201_CREATED)

    def partial_update(self, request: ActorRequest, pk=None) -> Response:
        subscription = self.get_object()
        ser = s.WebhookUpdateSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        webhooks.update_subscription(request.actor, subscription, request=request._request, **ser.validated_data)
        return Response(self._read(subscription))

    def destroy(self, request: ActorRequest, pk=None) -> Response:
        webhooks.delete_subscription(request.actor, self.get_object(), request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="rotate-secret")
    def rotate_secret(self, request: ActorRequest, pk=None) -> Response:
        subscription = self.get_object()
        secret = webhooks.rotate_subscription_secret(request.actor, subscription, request=request._request)
        return Response({**self._read(subscription), "secret": secret})

    @action(detail=True, methods=["post"])
    def pause(self, request: ActorRequest, pk=None) -> Response:
        subscription = webhooks.set_subscription_status(
            request.actor, self.get_object(), active=False, request=request._request
        )
        return Response(self._read(subscription))

    @action(detail=True, methods=["post"])
    def resume(self, request: ActorRequest, pk=None) -> Response:
        subscription = webhooks.set_subscription_status(
            request.actor, self.get_object(), active=True, request=request._request
        )
        return Response(self._read(subscription))

    @action(detail=True, methods=["post"])
    def test(self, request: ActorRequest, pk=None) -> Response:
        subscription = self.get_object()
        if subscription.status != WebhookSubscription.Status.ACTIVE:
            return Response(
                {"type": "webhook_inactive", "title": "Turn the webhook on before testing it.", "status": 409},
                status=409,
            )
        delivery = send_test(subscription)
        ok = delivery.status == OutboundDelivery.Status.SUCCEEDED
        return Response(
            {
                "ok": ok,
                "response_status": delivery.response_status,
                "error_code": delivery.error_code,
                "message": "Test event delivered." if ok else errors.message_for(delivery.error_code, "The endpoint"),
            }
        )

    @action(detail=True, methods=["get"])
    def deliveries(self, request: ActorRequest, pk=None) -> Response:
        subscription = self.get_object()
        qs = OutboundDelivery.objects.filter(subscription=subscription).order_by("-created_at")[:50]
        return Response({"results": s.DeliverySerializer(qs, many=True).data})


class ApiCredentialViewSet(mixins.ListModelMixin, TenantViewSet):
    permission_map = {
        "list": "integrations.manage",
        "retrieve": "integrations.manage",
        "create": "integrations.manage",
        "destroy": "integrations.manage",
    }
    serializer_class = s.ApiCredentialSerializer
    throttle_scope = "admin"

    def base_queryset(self):
        return ApiCredential.objects.select_related("created_by__user").order_by("-created_at")

    def create(self, request: ActorRequest) -> Response:
        ser = s.ApiCredentialCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        credential, key = services.create_api_credential(
            request.actor,
            name=ser.validated_data["name"],
            scope_keys=ser.validated_data["scopes"],
            expires_in_days=ser.validated_data["expires_in_days"],
            request=request._request,
        )
        data = dict(s.ApiCredentialSerializer(self.base_queryset().get(pk=credential.pk)).data)
        return Response({**data, "key": key}, status=status.HTTP_201_CREATED)

    def destroy(self, request: ActorRequest, pk=None) -> Response:
        services.revoke_api_credential(request.actor, self.get_object(), request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class InboundWebhookView(APIView):
    """Public, signature-authenticated receiver (reviewed: tests/authz_matrix/test_route_coverage.py)."""

    # Reviewed public endpoint. It is listed in ALLOWED_PUBLIC in tests/authz_matrix/test_route_coverage.py,
    # which asserts these exact permission classes. There is no session or organization to authenticate
    # against: the caller is an external provider, authenticated instead by the HMAC signature that
    # webhooks.receive() verifies against the connection's own secret, per-connection rate limited, and
    # replay-protected by the unique (connection, event_id) constraint on InboundEvent.
    # nosemgrep: security.semgrep.keel-allow-any
    permission_classes = [AllowAny]
    authentication_classes: list = []  # no session, no CSRF: authenticated by HMAC signature
    throttle_scope = "integration_inbound"

    def post(self, request, key: str) -> Response:
        content_length = request.META.get("CONTENT_LENGTH") or "0"
        if content_length.isdigit() and int(content_length) > webhooks.MAX_INBOUND_BODY_BYTES:
            return Response({"status": "rejected", "code": "payload_too_large"}, status=413)
        headers = {
            "keel-signature": request.META.get("HTTP_KEEL_SIGNATURE", ""),
            "keel-event-id": request.META.get("HTTP_KEEL_EVENT_ID", ""),
        }
        try:
            code, body = webhooks.receive(key, body=request.body, headers=headers, request=request._request)
        except webhooks.InboundRejected as exc:
            # Only a stable code; nothing about the connection or why a signature failed.
            return Response({"status": "rejected", "code": exc.code}, status=exc.status)
        return Response(body, status=code)
