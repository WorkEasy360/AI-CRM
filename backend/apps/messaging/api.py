from __future__ import annotations

from typing import Any

from django.http import HttpResponseRedirect
from django.utils import timezone
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.authz.reauth import require_recent_auth
from apps.core.api.serializers import MembershipRefSerializer
from apps.core.api.viewsets import TenantAPIView, TenantViewSet
from apps.messaging import providers, services
from apps.messaging.models import (
    ConnectionStatus,
    EmailAccount,
    EmailAttachment,
    EmailMessage,
    EmailProvider,
    EmailTemplate,
    WhatsAppAccount,
    WhatsAppMessage,
    WhatsAppTemplate,
)
from apps.notes.registry import resolve_viewable

MAX_UPLOAD_PARTS = 5


class RefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)


class ContactRefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(source="display_name", read_only=True)


# ----------------------------------------------------------------------------- email accounts


class EmailAccountSerializer(serializers.ModelSerializer):
    membership = MembershipRefSerializer(read_only=True)

    class Meta:
        model = EmailAccount
        fields = [
            "id",
            "provider",
            "email_address",
            "display_name",
            "status",
            "error_message",
            "last_sync_at",
            "connected_at",
            "membership",
        ]
        read_only_fields = fields


class EmailAccountViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """The caller's mailbox connections (never tokens). Connect via OAuth, disconnect explicitly."""

    permission_map = {
        "list": "email.view",
        "retrieve": "email.view",
        "destroy": "email.connect",
        "connect": "email.connect",
        "callback": "email.connect",
        "providers": "email.view",
    }
    serializer_class = EmailAccountSerializer
    throttle_scope = "sensitive"

    def base_queryset(self):
        # Own accounts only: connections are personal, whatever the actor's scope elsewhere.
        return EmailAccount.objects.filter(membership_id=self.request.actor.membership.id).select_related(
            "membership__user"
        )

    def get_queryset(self):
        return self.base_queryset()

    def destroy(self, request, pk=None):
        account = self.get_object()
        services.disconnect_account(request.actor, account, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["get"])
    def providers(self, request):
        return Response(
            {
                "results": [
                    {"key": p, "label": label, "configured": providers.email_provider_configured(p)}
                    for p, label in EmailProvider.choices
                ]
            }
        )

    @action(detail=False, methods=["post"])
    def connect(self, request):
        require_recent_auth(request._request)
        provider = (request.data or {}).get("provider", "")
        url = services.start_oauth(request.actor, provider, request=request._request)
        return Response({"authorization_url": url})

    @action(detail=False, methods=["get"])
    def callback(self, request):
        state = request.query_params.get("state", "")
        code = request.query_params.get("code", "")
        from django.conf import settings

        target = f"{settings.FRONTEND_ORIGIN}/settings/email"
        if not code or request.query_params.get("error"):
            return HttpResponseRedirect(f"{target}?connected=0")
        try:
            services.complete_oauth(request.actor, state=state, code=code, request=request._request)
        except Exception:  # never leak provider errors into a redirect; the settings page re-fetches state
            return HttpResponseRedirect(f"{target}?connected=0")
        return HttpResponseRedirect(f"{target}?connected=1")


# ----------------------------------------------------------------------------- email templates


class EmailTemplateSerializer(serializers.ModelSerializer):
    created_by = MembershipRefSerializer(read_only=True)

    class Meta:
        model = EmailTemplate
        fields = ["id", "name", "subject", "body", "is_shared", "created_by", "created_at", "updated_at"]
        read_only_fields = fields


class EmailTemplateInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    subject = serializers.CharField(max_length=255, required=False, allow_blank=True)
    body = serializers.CharField(max_length=services.MAX_BODY, required=False, allow_blank=True)
    is_shared = serializers.BooleanField(required=False)


class EmailTemplateViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "email.view",
        "retrieve": "email.view",
        "create": "email.templates_manage",
        "partial_update": "email.templates_manage",
        "destroy": "email.templates_manage",
        "render": "email.view",
    }
    serializer_class = EmailTemplateSerializer
    resolved_ordering = ("name", "id")

    def base_queryset(self):
        return EmailTemplate.objects.select_related("created_by__user")

    def get_queryset(self):
        # Shared templates are readable by anyone with email.view; private ones by their author.
        from django.db.models import Q

        return self.base_queryset().filter(Q(is_shared=True) | Q(created_by_id=self.request.actor.membership.id))

    def get_object(self):
        from django.shortcuts import get_object_or_404

        from apps.authz.service import check

        obj = get_object_or_404(self.get_queryset(), pk=self.kwargs["pk"])
        check(self.request.actor, self.current_permission(), obj)
        return obj

    def create(self, request):
        ser = EmailTemplateInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if "name" not in data or "body" not in data:
            raise ValidationError({"name": "Name and body are required."})
        template = services.create_template(
            request.actor,
            name=data["name"],
            subject=data.get("subject", ""),
            body=data["body"],
            is_shared=data.get("is_shared", True),
            request=request._request,
        )
        return Response(
            EmailTemplateSerializer(self.base_queryset().get(pk=template.pk)).data, status=status.HTTP_201_CREATED
        )

    def partial_update(self, request, pk=None):
        template = self.get_object()
        ser = EmailTemplateInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.update_template(request.actor, template, request=request._request, **ser.validated_data)
        return Response(EmailTemplateSerializer(self.base_queryset().get(pk=template.pk)).data)

    def destroy(self, request, pk=None):
        template = self.get_object()
        services.delete_template(request.actor, template, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"])
    def render(self, request, pk=None):
        """The template with placeholders filled from a contact/deal the caller may view."""
        template = self.get_object()
        contact = deal = None
        if request.query_params.get("contact"):
            contact = resolve_viewable(request.actor, "contact", request.query_params["contact"])
        if request.query_params.get("deal"):
            deal = resolve_viewable(request.actor, "deal", request.query_params["deal"])
        company = (
            getattr(contact, "company", None)
            if contact and contact.company_id
            else getattr(deal, "company", None)
            if deal and deal.company_id
            else None
        )
        return Response(
            {
                "subject": services.render_template(
                    template.subject, contact=contact, company=company, deal=deal, sender=request.actor.membership
                ),
                "body": services.render_template(
                    template.body, contact=contact, company=company, deal=deal, sender=request.actor.membership
                ),
            }
        )


# ----------------------------------------------------------------------------- email messages


class EmailAttachmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = EmailAttachment
        fields = ["id", "filename", "content_type", "size_bytes"]
        read_only_fields = fields


class EmailMessageSerializer(serializers.ModelSerializer):
    sent_by = MembershipRefSerializer(read_only=True)
    contact = ContactRefSerializer(read_only=True)
    company = RefSerializer(read_only=True)
    deal = RefSerializer(read_only=True)
    attachments = EmailAttachmentSerializer(many=True, read_only=True)

    class Meta:
        model = EmailMessage
        fields = [
            "id",
            "direction",
            "status",
            "from_address",
            "to_addresses",
            "cc_addresses",
            "bcc_addresses",
            "subject",
            "body_text",
            "snippet",
            "provider_thread_id",
            "contact",
            "company",
            "deal",
            "sent_by",
            "sent_at",
            "received_at",
            "error_message",
            "ai_assisted",
            "attachments",
            "created_at",
        ]
        read_only_fields = fields


class EmailSendSerializer(serializers.Serializer):
    to = serializers.ListField(child=serializers.CharField(max_length=254), max_length=20)
    cc = serializers.ListField(child=serializers.CharField(max_length=254), required=False, max_length=20)
    bcc = serializers.ListField(child=serializers.CharField(max_length=254), required=False, max_length=20)
    subject = serializers.CharField(max_length=255, required=False, allow_blank=True)
    body = serializers.CharField(max_length=services.MAX_BODY)
    contact_id = serializers.UUIDField(required=False, allow_null=True)
    company_id = serializers.UUIDField(required=False, allow_null=True)
    deal_id = serializers.UUIDField(required=False, allow_null=True)
    template_id = serializers.UUIDField(required=False, allow_null=True)
    in_reply_to_id = serializers.UUIDField(required=False, allow_null=True)
    ai_assisted = serializers.BooleanField(required=False, default=False)


class EmailMessageViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Email history per record (visible when the record is), plus sending from the caller's mailbox."""

    permission_map = {"list": "email.view", "retrieve": "email.view", "create": "email.send"}
    serializer_class = EmailMessageSerializer
    parser_classes = [JSONParser, MultiPartParser]
    throttle_scope = "sensitive"
    resolved_ordering = ("-created_at", "-id")

    def base_queryset(self):
        return EmailMessage.objects.select_related("sent_by__user", "contact", "company", "deal").prefetch_related(
            "attachments"
        )

    def get_queryset(self):
        params = self.request.query_params
        qs = self.base_queryset()
        for key in ("contact", "company", "deal"):
            if params.get(key):
                record = resolve_viewable(self.request.actor, key, params[key])
                return qs.filter(**{key: record})
        if params.get("thread"):
            thread = str(params["thread"])[:255]
            return qs.filter(provider_thread_id=thread, sent_by_id=self.request.actor.membership.id) | qs.filter(
                provider_thread_id=thread, account__membership_id=self.request.actor.membership.id
            )
        return qs.filter(sent_by_id=self.request.actor.membership.id)

    def get_object(self):
        from django.http import Http404
        from django.shortcuts import get_object_or_404

        message = get_object_or_404(self.base_queryset(), pk=self.kwargs["pk"])
        if not services.can_view_message(self.request.actor, message):
            raise Http404
        return message

    def create(self, request):
        data: dict[str, Any] = dict(request.data.items()) if hasattr(request.data, "items") else dict(request.data)
        for key in ("to", "cc", "bcc"):
            value = data.get(key)
            if isinstance(value, str):
                data[key] = [v for v in value.replace(";", ",").split(",") if v.strip()]
        ser = EmailSendSerializer(data=data)
        ser.is_valid(raise_exception=True)
        attachments: list[tuple[str, str, bytes]] = []
        files = request.FILES.getlist("attachments") if hasattr(request, "FILES") else []
        if len(files) > MAX_UPLOAD_PARTS:
            raise ValidationError({"attachments": f"At most {MAX_UPLOAD_PARTS} attachments."})
        for f in files:
            attachments.append((f.name, f.content_type or "application/octet-stream", f.read()))
        message = services.send_email(
            request.actor, dict(ser.validated_data), attachments=attachments, request=request._request
        )
        return Response(
            EmailMessageSerializer(self.base_queryset().get(pk=message.pk)).data, status=status.HTTP_201_CREATED
        )


# ----------------------------------------------------------------------------- whatsapp


class WhatsAppAccountView(TenantAPIView):
    permission_map = {"GET": "whatsapp.view", "POST": "whatsapp.manage", "DELETE": "whatsapp.manage"}
    throttle_scope = "sensitive"

    @staticmethod
    def _payload(account: WhatsAppAccount | None) -> dict[str, Any]:
        from django.conf import settings

        if account is None or account.status != ConnectionStatus.CONNECTED:
            return {
                "connected": False,
                "webhook_configured": bool(settings.WHATSAPP_APP_SECRET and settings.WHATSAPP_VERIFY_TOKEN),
            }
        return {
            "connected": True,
            "phone_number_id": account.phone_number_id,
            "display_phone": account.display_phone,
            "display_name": account.display_name,
            "connected_at": account.connected_at,
            "webhook_configured": bool(settings.WHATSAPP_APP_SECRET and settings.WHATSAPP_VERIFY_TOKEN),
        }

    def get(self, request):
        return Response(self._payload(WhatsAppAccount.objects.first()))

    def post(self, request):
        require_recent_auth(request._request)
        data = request.data or {}
        account = services.connect_whatsapp(
            request.actor,
            phone_number_id=str(data.get("phone_number_id", "")),
            access_token=str(data.get("access_token", "")),
            business_account_id=str(data.get("business_account_id", "")),
            request=request._request,
        )
        return Response(self._payload(account), status=status.HTTP_201_CREATED)

    def delete(self, request):
        require_recent_auth(request._request)
        services.disconnect_whatsapp(request.actor, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class WhatsAppTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = WhatsAppTemplate
        fields = ["id", "name", "language", "category", "body", "parameter_count", "status", "created_at"]
        read_only_fields = fields


class WhatsAppTemplateInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    language = serializers.CharField(max_length=16, required=False, default="en")
    category = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")
    body = serializers.CharField(max_length=2000, required=False, allow_blank=True, default="")


class WhatsAppTemplateViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "whatsapp.view",
        "retrieve": "whatsapp.view",
        "create": "whatsapp.manage",
        "destroy": "whatsapp.manage",
    }
    serializer_class = WhatsAppTemplateSerializer
    resolved_ordering = ("name", "id")

    def base_queryset(self):
        return WhatsAppTemplate.objects.all()

    def get_queryset(self):
        return self.base_queryset()

    def get_object(self):
        from django.shortcuts import get_object_or_404

        from apps.authz.service import check

        obj = get_object_or_404(self.base_queryset(), pk=self.kwargs["pk"])
        check(self.request.actor, self.current_permission(), obj)
        return obj

    def create(self, request):
        ser = WhatsAppTemplateInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        template = services.upsert_whatsapp_template(request.actor, request=request._request, **ser.validated_data)
        return Response(WhatsAppTemplateSerializer(template).data, status=status.HTTP_201_CREATED)

    def destroy(self, request, pk=None):
        template = self.get_object()
        services.delete_whatsapp_template(request.actor, template, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class WhatsAppMessageSerializer(serializers.ModelSerializer):
    sent_by = MembershipRefSerializer(read_only=True)
    contact = ContactRefSerializer(read_only=True)
    deal = RefSerializer(read_only=True)
    template = WhatsAppTemplateSerializer(read_only=True)

    class Meta:
        model = WhatsAppMessage
        fields = [
            "id",
            "direction",
            "status",
            "wa_id",
            "message_type",
            "body",
            "template",
            "template_params",
            "contact",
            "deal",
            "sent_by",
            "sent_at",
            "received_at",
            "error_message",
            "ai_assisted",
            "created_at",
        ]
        read_only_fields = fields


class WhatsAppSendSerializer(serializers.Serializer):
    contact_id = serializers.UUIDField()
    deal_id = serializers.UUIDField(required=False, allow_null=True)
    company_id = serializers.UUIDField(required=False, allow_null=True)
    message_type = serializers.ChoiceField(choices=WhatsAppMessage.Type.choices, required=False)
    body = serializers.CharField(max_length=4096, required=False, allow_blank=True)
    template_id = serializers.UUIDField(required=False, allow_null=True)
    template_params = serializers.ListField(child=serializers.CharField(max_length=200), required=False, max_length=20)
    ai_assisted = serializers.BooleanField(required=False, default=False)


class WhatsAppMessageViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Conversation history for a contact (or deal) the caller may view, and sending."""

    permission_map = {
        "list": "whatsapp.view",
        "retrieve": "whatsapp.view",
        "create": "whatsapp.send",
        "window": "whatsapp.view",
    }
    serializer_class = WhatsAppMessageSerializer
    throttle_scope = "sensitive"
    resolved_ordering = ("created_at", "id")

    def base_queryset(self):
        return WhatsAppMessage.objects.select_related("sent_by__user", "contact", "deal", "template")

    def get_queryset(self):
        params = self.request.query_params
        qs = self.base_queryset()
        for key in ("contact", "deal", "company"):
            if params.get(key):
                record = resolve_viewable(self.request.actor, key, params[key])
                return qs.filter(**{key: record})
        return qs.filter(sent_by_id=self.request.actor.membership.id)

    def get_object(self):
        from django.http import Http404
        from django.shortcuts import get_object_or_404

        message = get_object_or_404(self.base_queryset(), pk=self.kwargs["pk"])
        if not services.can_view_message(self.request.actor, message):
            raise Http404
        return message

    def create(self, request):
        ser = WhatsAppSendSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        message = services.send_whatsapp(request.actor, dict(ser.validated_data), request=request._request)
        return Response(
            WhatsAppMessageSerializer(self.base_queryset().get(pk=message.pk)).data, status=status.HTTP_201_CREATED
        )

    @action(detail=False, methods=["get"])
    def window(self, request):
        """Whether a free-form message may be sent to this contact right now (24-hour service window)."""
        contact = resolve_viewable(request.actor, "contact", request.query_params.get("contact", ""))
        try:
            wa_id = services.normalise_phone(contact.phone)
        except ValidationError:
            return Response(
                {
                    "open": False,
                    "reason": "no_phone",
                    "opt_in": contact.whatsapp_opt_in,
                    "connected": services.whatsapp_account() is not None,
                }
            )
        last = (
            WhatsAppMessage.objects.filter(wa_id=wa_id, direction="inbound")
            .order_by("-received_at")
            .values_list("received_at", flat=True)
            .first()
        )
        return Response(
            {
                "open": services.within_service_window(wa_id),
                "reason": "",
                "last_inbound_at": last,
                "opt_in": contact.whatsapp_opt_in,
                "connected": services.whatsapp_account() is not None,
                "now": timezone.now(),
            }
        )
