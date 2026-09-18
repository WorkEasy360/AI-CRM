# User Management and Password Reset

Settings → **Users & Teams**. Builds on the authentication design (`authentication.md`) and the central
authorization model (`rbac.md`); it adds no second user, role or organization system.

## 1. Statuses

| Shown as | Stored | Meaning | Reversible by |
|---|---|---|---|
| Invited | pending `Invitation` | Email sent, not accepted | Resend / revoke |
| Active | `Membership.status = active` | Full access with the role's grants | — |
| Suspended | `Membership.status = suspended` | Signed out everywhere, no access; role and teams kept | **Reactivate** |
| Disabled | `Membership.status = disabled`, or `User.is_active = false` | Removed from the organization (row kept for ownership and audit history), or the account is disabled platform-wide | A new invitation |

Migration `accounts.0004` renamed the earlier reversible `disabled` state to `suspended`.

## 2. Actions and who may perform them

| Action | Endpoint | Permission | Recent auth | Audit |
|---|---|---|---|---|
| Invite user | `POST /api/v1/invitations/` | `members.invite` (+ `teams.manage` with a team) | when inviting Owner/Admin | `members.invited` |
| Resend invitation | `POST /api/v1/invitations/{id}/resend/` | `members.invite` | — | `members.invitation_resent` |
| Revoke invitation | `DELETE /api/v1/invitations/{id}/` | `members.invite` | — | `members.invitation_revoked` |
| Change role | `PATCH /api/v1/members/{id}/role/` | `members.update_role` | yes | `members.role_changed` |
| Assign teams | `PUT /api/v1/members/{id}/teams/` | `teams.manage` | — | `members.teams_changed` |
| Suspend / reactivate | `POST /api/v1/members/{id}/suspend|reactivate/` | `members.disable` | yes | `members.suspended` / `members.reactivated` |
| Revoke sessions | `POST /api/v1/members/{id}/revoke-sessions/` | `members.disable` | — | `auth.sessions_revoked` |
| Remove user | `POST /api/v1/members/{id}/remove/` | `members.remove` | yes | `members.removed` |

Invariants enforced in `apps/accounts/services.py` (never only in the UI): nobody changes, suspends or removes
themselves; only owners act on owners; the organization always keeps one active owner; nobody grants a role
above their own (Admins cannot grant Owner). Every suspension, removal and role change revokes the member's
sessions (session salt rotation plus allauth session purge). Removal also drops team memberships and wipes the
member's mailbox tokens; API credentials and integrations the member created stop working because each machine
request and sync job re-checks that the acting membership is active.

## 3. Invitation flow

```
Admin → Invite (name, email, role, optional team)
  server: role check → seat check → token = 256-bit random, only SHA-256 stored → email link
Invitee opens /invitations/accept?token=…
  GET  /invitations/preview/   organization, role, inviter (from the invitation row)
  new person:      POST /invitations/register/  {token, name, password}
  existing account: sign in → POST /invitations/accept/ {token}
→ lands on /pipeline (or /settings/security first when the organization requires MFA)
```

`register` (`services.register_with_invitation`) runs in one transaction: lock the invitation row
(`SELECT … FOR UPDATE`), re-check it is pending, validate the password with Django's validators (length 12,
common passwords, numeric, similarity to email/name), create the user, mark the email verified (the token proves
control of the address), create the membership with the invitation's role and team, mark the invitation accepted,
write the audit event. Any failure rolls all of it back. Then the browser is signed in the same way a password
login does it (session key rotation, allauth `user_logged_in` signal, active membership, `auth.login` audit).

Security properties: organization, role and team come only from the invitation row (request fields are ignored);
tokens are single use (a concurrent second request waits on the lock and then sees the invitation consumed),
expire after `INVITATION_EXPIRY_DAYS`, and resending issues a new token so older links stop working; the email of
the signed-in user must match the invitation; `register` refuses signed-in browsers and existing accounts
(`409 account_exists`) and enforces the CSRF token itself (login CSRF); preview/accept/register share the
`invitation_public` throttle.

## 4. Seat limits

`apps/accounts/limits.py` is the only place that knows about plans: `PLAN_USER_LIMITS` (settings/env, per
`Organization.plan`) or `organization.settings["max_users"]` (contract override). Active and suspended members
plus pending invitations take seats. Invitation and acceptance call `assert_seat_available`; a future billing
module only updates `plan` or the override.

## 5. Forgot / reset password

Served by allauth headless (no custom token code):

| Step | Behaviour |
|---|---|
| `POST /_allauth/browser/v1/auth/password/request` | Always `200` with the same body. Registered addresses get a reset link; unknown addresses get an "unknown account" notice (`ACCOUNT_PREVENT_ENUMERATION = "strict"`), so both paths do the same work. Rate limited `20/min per IP, 3/min per address`. |
| Link | `FRONTEND_ORIGIN/reset-password/<key>`; Django's token generator: bound to the user, invalidated by any password or login change (single use), valid `PASSWORD_RESET_TIMEOUT = 3600` s. Not stored anywhere. |
| `POST …/auth/password/reset` | New password validated by the same validators. Does **not** sign the browser in. |
| After reset | `password_changed_at` set, every session revoked, `auth.password_reset` audited, "your password was changed" email sent. MFA authenticators are untouched: the next login still asks for the second factor. |

UI: `/login` → "Forgot password?" → email → generic confirmation ("If an account exists for this email, password
reset instructions have been sent.") → link → new + confirm password → "Password updated" → sign in.

## 6. Tests

`tests/accounts/test_user_management.py`, `test_password_reset.py`, `test_members_and_invitations.py`, the
authz matrix and generated tenant-isolation suites; frontend `members-page.test.tsx`,
`accept-invitation.test.tsx`; browser flows in `frontend/tests/e2e/users-and-integrations.spec.ts`.
