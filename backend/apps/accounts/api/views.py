from __future__ import annotations

from allauth.account.internal.flows.reauthentication import did_recently_authenticate
from allauth.mfa.models import Authenticator
from django.db.models import Exists, OuterRef, Prefetch
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import mixins, status
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts import services
from apps.accounts.api import serializers as s
from apps.accounts.models import Invitation, Membership, Organization
from apps.authz.actor import build_actor
from apps.authz.permissions import IsAuthenticatedUser
from apps.core.api.request import ActorRequest, authenticated_user, enforce_csrf
from apps.core.api.viewsets import TenantAPIView, TenantViewSet
from apps.teams.models import TeamMembership


def _session_payload(request: Request) -> dict:
    user = authenticated_user(request)
    actor = getattr(request, "actor", None)
    memberships = (
        Membership.identity.for_user(user)
        .active()
        .filter(organization__status=Organization.Status.ACTIVE)
        .select_related("organization", "role")
        .order_by("organization__name")
    )
    # The actor caches the same lookup for ``mfa_required``; reuse it rather than query twice.
    mfa_enabled = (
        actor.mfa_enabled
        if actor is not None
        else Authenticator.objects.filter(
            user=user, type__in=[Authenticator.Type.TOTP, Authenticator.Type.WEBAUTHN]
        ).exists()
    )
    payload = {
        "user": s.UserPublicSerializer(user).data,
        "mfa_enabled": mfa_enabled,
        "recently_authenticated": did_recently_authenticate(request._request),
        "memberships": s.MembershipSummarySerializer(memberships, many=True).data,
        "active": None,
    }
    if actor is not None:
        payload["active"] = {
            "membership_id": str(actor.membership.pk),
            "organization": s.OrganizationSerializer(actor.organization).data,
            "role": {"key": actor.role_key, "name": actor.membership.role.name},
            "permissions": dict(actor.grants),
            "mfa_required": actor.mfa_required,
        }
    return payload


# The CSRF cookie must be issued on dispatch, not on get(): the permission check
# rejects signed-out visitors before get() runs, and the login page relies on
# this endpoint's 403 to seed the cookie the login POST then has to present.
@method_decorator(ensure_csrf_cookie, name="dispatch")
class SessionView(APIView):
    permission_classes = [IsAuthenticatedUser]

    def get(self, request: Request) -> Response:
        return Response(_session_payload(request))


class SessionBootstrapView(APIView):
    """Give a signed-in session an active organization without any client input.

    Creates the user's personal workspace when they have none, then activates their default
    membership. Idempotent: calling it twice, refreshing, or racing two tabs yields one workspace.
    The request body is ignored on purpose; nothing here can be steered from the client.
    """

    permission_classes = [IsAuthenticatedUser]
    throttle_scope = "sensitive"

    def post(self, request: Request) -> Response:
        if getattr(request, "actor", None) is None:
            membership = services.bootstrap_session(request._request, authenticated_user(request))
            if membership is not None:
                request._request.actor = build_actor(membership)  # type: ignore[attr-defined]
        return Response(_session_payload(request))


class SwitchOrganizationView(APIView):
    permission_classes = [IsAuthenticatedUser]
    throttle_scope = "sensitive"

    def post(self, request: Request) -> Response:
        ser = s.SwitchOrganizationSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        membership = services.switch_organization(
            request._request, authenticated_user(request), ser.validated_data["membership_id"]
        )
        return Response(
            {
                "active_membership_id": str(membership.pk),
                "organization": s.OrganizationSerializer(membership.organization).data,
            }
        )


class OrganizationCreateView(APIView):
    permission_classes = [IsAuthenticatedUser]
    throttle_scope = "sensitive"

    def post(self, request: Request) -> Response:
        ser = s.OrganizationCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        membership = services.create_organization(
            authenticated_user(request),
            name=data["name"],
            base_currency=data["base_currency"],
            timezone_name=data["timezone"],
            request=request._request,
        )
        return Response(
            {
                "membership_id": str(membership.pk),
                "organization": s.OrganizationSerializer(membership.organization).data,
            },
            status=status.HTTP_201_CREATED,
        )


class OrganizationCurrentView(TenantAPIView):
    permission_map = {"GET": "org.view", "PATCH": "org.update"}

    def get(self, request: ActorRequest) -> Response:
        return Response(s.OrganizationSerializer(request.actor.organization).data)

    def patch(self, request: ActorRequest) -> Response:
        ser = s.OrganizationUpdateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        org = services.update_organization(request.actor, request=request._request, **ser.validated_data)
        return Response(s.OrganizationSerializer(org).data)


class MemberViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "members.view",
        "retrieve": "members.view",
        "change_role": "members.update_role",
        "suspend": "members.disable",
        "reactivate": "members.disable",
        "remove": "members.remove",
        "revoke_sessions": "members.disable",
        "teams": "teams.manage",
    }
    serializer_class = s.MembershipSerializer
    throttle_scope = "admin"

    def base_queryset(self):
        mfa = Authenticator.objects.filter(
            user_id=OuterRef("user_id"), type__in=[Authenticator.Type.TOTP, Authenticator.Type.WEBAUTHN]
        )
        qs = (
            Membership.objects.select_related("user", "role")
            .annotate(mfa_enabled=Exists(mfa))
            .prefetch_related(
                Prefetch(
                    "team_memberships", queryset=TeamMembership.objects.select_related("team").order_by("team__name")
                )
            )
            .order_by("-created_at")
        )
        status_filter = self.request.query_params.get("status") if self.action == "list" else None
        if status_filter in Membership.Status.values:
            qs = qs.filter(status=status_filter)
        return qs

    def _read(self, membership: Membership) -> Response:
        return Response(s.MembershipSerializer(self.base_queryset().get(pk=membership.pk)).data)

    @action(detail=True, methods=["patch"], url_path="role")
    def change_role(self, request: ActorRequest, pk=None) -> Response:
        membership = self.get_object()
        ser = s.RoleChangeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.change_member_role(
            request.actor, membership, role_key=ser.validated_data["role"], request=request._request
        )
        return self._read(membership)

    @action(detail=True, methods=["post"])
    def suspend(self, request: ActorRequest, pk=None) -> Response:
        membership = self.get_object()
        services.suspend_member(request.actor, membership, request=request._request)
        return self._read(membership)

    @action(detail=True, methods=["post"])
    def reactivate(self, request: ActorRequest, pk=None) -> Response:
        membership = self.get_object()
        services.reactivate_member(request.actor, membership, request=request._request)
        return self._read(membership)

    @action(detail=True, methods=["post"])
    def remove(self, request: ActorRequest, pk=None) -> Response:
        membership = self.get_object()
        services.remove_member(request.actor, membership, request=request._request)
        return self._read(membership)

    @action(detail=True, methods=["post"], url_path="revoke-sessions")
    def revoke_sessions(self, request: ActorRequest, pk=None) -> Response:
        membership = self.get_object()
        revoked = services.revoke_member_sessions(request.actor, membership, request=request._request)
        return Response({"sessions_revoked": revoked})

    @action(detail=True, methods=["put"])
    def teams(self, request: ActorRequest, pk=None) -> Response:
        membership = self.get_object()
        ser = s.MemberTeamsSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.set_member_teams(
            request.actor, membership, team_ids=ser.validated_data["team_ids"], request=request._request
        )
        return self._read(membership)


class InvitationViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    permission_map = {
        "list": "members.invite",
        "retrieve": "members.invite",
        "create": "members.invite",
        "destroy": "members.invite",
        "resend": "members.invite",
    }
    # Actions reachable without an active organization: explicit, reviewed exceptions.
    public_actions = {"preview": [AllowAny], "accept": [IsAuthenticatedUser], "register": [AllowAny]}
    serializer_class = s.InvitationSerializer
    throttle_scope = "admin"

    def get_permissions(self):
        if self.action in self.public_actions:
            return [cls() for cls in self.public_actions[self.action]]
        return super().get_permissions()

    def get_throttles(self):
        if self.action in self.public_actions:
            self.throttle_scope = "invitation_public"
        return super().get_throttles()

    def base_queryset(self):
        return Invitation.objects.select_related("role", "team", "invited_by__user").order_by("-created_at")

    def create(self, request: ActorRequest) -> Response:
        ser = s.InvitationCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        invitation = services.invite_member(
            request.actor,
            email=ser.validated_data["email"],
            role_key=ser.validated_data["role"],
            name=ser.validated_data["name"],
            team_id=ser.validated_data["team_id"],
            request=request._request,
        )
        invitation = self.get_queryset().get(pk=invitation.pk)
        return Response(s.InvitationSerializer(invitation).data, status=status.HTTP_201_CREATED)

    def destroy(self, request: ActorRequest, pk=None) -> Response:
        invitation = self.get_object()
        services.revoke_invitation(request.actor, invitation, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def resend(self, request: ActorRequest, pk=None) -> Response:
        invitation = services.resend_invitation(request.actor, self.get_object(), request=request._request)
        return Response(s.InvitationSerializer(self.get_queryset().get(pk=invitation.pk)).data)

    @action(detail=False, methods=["get"])
    def preview(self, request: Request) -> Response:
        ser = s.InvitationTokenSerializer(data=request.query_params)
        ser.is_valid(raise_exception=True)
        data = services.preview_invitation(ser.validated_data["token"])
        if data is None:
            return Response({"type": "invitation_invalid", "title": "Not found", "status": 404}, status=404)
        return Response(data)

    @action(detail=False, methods=["post"])
    def accept(self, request: Request) -> Response:
        ser = s.InvitationTokenSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        membership = services.accept_invitation(
            authenticated_user(request), ser.validated_data["token"], request=request._request
        )
        return Response(
            {
                "membership_id": str(membership.pk),
                "organization": s.OrganizationSerializer(membership.organization).data,
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["post"])
    def register(self, request: Request) -> Response:
        """Create the invitee's account from the link and sign them in (new users only).

        Anonymous, so DRF's session authentication does not check CSRF; this endpoint signs a browser
        in, so it enforces the CSRF token itself (no login CSRF into an account someone else controls).
        """
        enforce_csrf(request)
        if request.user and request.user.is_authenticated:
            return Response(
                {"type": "already_authenticated", "title": "Sign out before creating a new account.", "status": 409},
                status=409,
            )
        ser = s.InvitationRegisterSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        membership = services.register_with_invitation(
            request._request,
            token=ser.validated_data["token"],
            name=ser.validated_data["name"],
            password=ser.validated_data["password"],
        )
        return Response(
            {
                "membership_id": str(membership.pk),
                "organization": s.OrganizationSerializer(membership.organization).data,
            },
            status=status.HTTP_201_CREATED,
        )
