from __future__ import annotations

from django.conf import settings
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.response import Response

from apps.billing import entitlements, services
from apps.billing.editions import ADDONS, FEATURES, METRICS
from apps.billing.models import AddonPurchase, Subscription
from apps.core.api.request import ActorRequest
from apps.core.api.viewsets import TenantAPIView


class EditionRefSerializer(serializers.Serializer):
    key = serializers.CharField()
    name = serializers.CharField()


class SubscriptionOutSerializer(serializers.Serializer):
    edition = EditionRefSerializer(help_text="The edition in force now (a lapsed trial resolves to Free).")
    subscribed_edition = serializers.CharField()
    status = serializers.ChoiceField(choices=Subscription.Status.choices)
    billing_cycle = serializers.ChoiceField(choices=Subscription.Cycle.choices)
    seats = serializers.IntegerField()
    seat_limit = serializers.IntegerField(allow_null=True)
    trial_ends_at = serializers.DateTimeField(allow_null=True)
    current_period_end = serializers.DateTimeField(allow_null=True)
    grandfathered = serializers.BooleanField()
    features = serializers.ListField(child=serializers.CharField())
    self_service = serializers.BooleanField()


class EditionOutSerializer(EditionRefSerializer):
    rank = serializers.IntegerField()
    tagline = serializers.CharField()
    price_monthly_cents = serializers.IntegerField()
    price_annual_cents = serializers.IntegerField()
    limits = serializers.DictField(child=serializers.IntegerField(allow_null=True))
    features = serializers.ListField(child=serializers.CharField())


class AddonOutSerializer(serializers.Serializer):
    key = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]
    metric = serializers.CharField(allow_null=True)
    feature = serializers.CharField(allow_null=True)
    unit_amount = serializers.IntegerField()
    price_cents = serializers.IntegerField()
    recurring = serializers.BooleanField()


class KeyLabelSerializer(serializers.Serializer):
    key = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]


class EditionCatalogOutSerializer(serializers.Serializer):
    editions = EditionOutSerializer(many=True)
    features = KeyLabelSerializer(many=True)
    metrics = serializers.ListField(child=serializers.DictField())
    addons = AddonOutSerializer(many=True)


class UsageMetricSerializer(serializers.Serializer):
    key = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]
    period = serializers.ChoiceField(choices=["count", "monthly", "daily"])
    unit = serializers.CharField()
    used = serializers.IntegerField()
    limit = serializers.IntegerField(allow_null=True)
    addon_amount = serializers.IntegerField()
    modules = serializers.ListField(child=serializers.DictField(), allow_null=True)
    state = serializers.ChoiceField(choices=["ok", "warning", "at_limit", "unlimited", "not_included"])
    upgrade_edition = EditionRefSerializer(allow_null=True)
    addon = serializers.CharField(allow_null=True)


class UsageReportSerializer(serializers.Serializer):
    edition = EditionRefSerializer()
    features = serializers.ListField(child=serializers.CharField())
    metrics = UsageMetricSerializer(many=True)
    record_definition = serializers.CharField(help_text="What counts towards the record limit.")


def _subscription_payload(request: ActorRequest) -> dict:
    org = request.actor.organization
    ent = entitlements.resolve(org)
    sub = ent.subscription
    return {
        "edition": {"key": ent.edition.key, "name": ent.edition.name},
        "subscribed_edition": sub.edition if sub else ent.edition.key,
        "status": sub.status if sub else Subscription.Status.ACTIVE,
        "billing_cycle": sub.billing_cycle if sub else Subscription.Cycle.ANNUAL,
        "seats": sub.seats if sub else 0,
        "seat_limit": ent.seat_limit,
        "trial_ends_at": sub.trial_ends_at if sub else None,
        "current_period_end": sub.current_period_end if sub else None,
        "grandfathered": bool(sub and sub.grandfathered),
        "features": sorted(ent.features),
        "self_service": bool(getattr(settings, "BILLING_SELF_SERVICE", False)),
    }


class EditionCatalogView(TenantAPIView):
    permission_map = {"GET": "org.view"}

    @extend_schema(responses=EditionCatalogOutSerializer, summary="Editions, limits, features and add-ons")
    def get(self, request: ActorRequest) -> Response:
        return Response(
            {
                "editions": services.edition_catalogue(),
                "features": [{"key": k, "label": v} for k, v in FEATURES.items()],
                "metrics": [
                    {"key": m.key, "label": m.label, "period": m.period, "unit": m.unit} for m in METRICS.values()
                ],
                "addons": [
                    {
                        "key": a.key,
                        "label": a.label,
                        "metric": a.metric,
                        "feature": a.feature,
                        "unit_amount": a.unit_amount,
                        "price_cents": a.price_cents,
                        "recurring": a.recurring,
                    }
                    for a in ADDONS.values()
                ],
            }
        )


class ChangePlanSerializer(serializers.Serializer):
    edition = serializers.CharField(max_length=24)
    billing_cycle = serializers.ChoiceField(choices=Subscription.Cycle.values, required=False)
    seats = serializers.IntegerField(required=False, min_value=1, max_value=services.MAX_SEATS)


class SubscriptionView(TenantAPIView):
    permission_map = {"GET": "org.view", "POST": "org.billing"}

    @extend_schema(responses=SubscriptionOutSerializer, summary="The organization's subscription")
    def get(self, request: ActorRequest) -> Response:
        return Response(_subscription_payload(request))

    @extend_schema(request=ChangePlanSerializer, responses=SubscriptionOutSerializer, summary="Change plan")
    def post(self, request: ActorRequest) -> Response:
        ser = ChangePlanSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.change_plan(request.actor, request=request._request, **ser.validated_data)
        return Response(_subscription_payload(request))


class UsageView(TenantAPIView):
    permission_map = {"GET": "org.view"}

    @extend_schema(responses=UsageReportSerializer, summary="Every metered counter against its limit")
    def get(self, request: ActorRequest) -> Response:
        return Response(entitlements.usage_report(request.actor.organization))


class AddonPurchaseSerializer(serializers.ModelSerializer):
    class Meta:
        model = AddonPurchase
        fields = ["id", "addon", "quantity", "status", "period_key", "created_at", "cancelled_at"]
        read_only_fields = fields


class AddonInputSerializer(serializers.Serializer):
    addon = serializers.ChoiceField(choices=list(ADDONS))
    quantity = serializers.IntegerField(min_value=1, max_value=services.MAX_ADDON_QUANTITY, default=1)


class AddonListView(TenantAPIView):
    permission_map = {"GET": "org.view", "POST": "org.billing"}

    @extend_schema(responses=AddonPurchaseSerializer(many=True), summary="Add-on purchases")
    def get(self, request: ActorRequest) -> Response:
        qs = AddonPurchase.objects.order_by("-created_at")[:200]
        return Response({"results": AddonPurchaseSerializer(qs, many=True).data})

    @extend_schema(request=AddonInputSerializer, responses=AddonPurchaseSerializer, summary="Buy an add-on")
    def post(self, request: ActorRequest) -> Response:
        ser = AddonInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        purchase = services.purchase_addon(request.actor, request=request._request, **ser.validated_data)
        return Response(AddonPurchaseSerializer(purchase).data, status=status.HTTP_201_CREATED)


class AddonCancelView(TenantAPIView):
    permission_map = {"POST": "org.billing"}

    @extend_schema(request=None, responses=AddonPurchaseSerializer, summary="Cancel an add-on")
    def post(self, request: ActorRequest, addon_id) -> Response:
        purchase = get_object_or_404(AddonPurchase.objects.all(), pk=addon_id)
        purchase = services.cancel_addon(request.actor, purchase, request=request._request)
        return Response(AddonPurchaseSerializer(purchase).data)
