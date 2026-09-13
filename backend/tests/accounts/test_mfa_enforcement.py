"""Organization-wide MFA requirement is enforced on the server, not only reported to the UI."""

import pytest
from allauth.mfa.models import Authenticator

pytestmark = pytest.mark.django_db


def test_require_mfa_blocks_tenant_routes_until_enrolled(org_a, owner_client, make_member, client_for, reauthenticate):
    member = make_member(org_a, "viewer")
    member_client = client_for(member.user, member)
    assert member_client.get("/api/v1/members/").status_code == 200

    reauthenticate(owner_client)
    resp = owner_client.patch("/api/v1/organizations/current/", {"require_mfa": True}, format="json")
    assert resp.status_code == 200 and resp.json()["require_mfa"] is True

    # tenant routes are now refused for a member without a second factor...
    resp = member_client.get("/api/v1/members/")
    assert resp.status_code == 403
    assert resp.json()["type"] == "mfa_required"
    # ...but the session endpoint still works so the UI can drive enrolment
    session = member_client.get("/api/v1/session/").json()
    assert session["active"]["mfa_required"] is True

    Authenticator.objects.create(user=member.user, type=Authenticator.Type.TOTP, data={})
    assert member_client.get("/api/v1/members/").status_code == 200
    assert member_client.get("/api/v1/session/").json()["active"]["mfa_required"] is False
