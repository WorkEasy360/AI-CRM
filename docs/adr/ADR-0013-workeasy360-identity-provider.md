# ADR-0013 — Workeasy360 is the identity provider

**Status:** Accepted (2026-10-12)

## Context
Keel ships inside the Workeasy360 ecosystem as **Easy CRM** (product code `easy_crm`). The product owner
decided that every Workeasy360 product signs in with the same credentials as the Workeasy360 account,
and that Workeasy360 becomes the only sign-in. Workeasy360 is an OpenID Provider with a published
product integration contract: authorization code + PKCE, `private_key_jwt` client authentication,
offline ID token verification, claims `sub`, `organization_id`, `product_code`, `aal`, `email`,
`email_verified`, `name`, `organization_name`. The app launcher opens our launch URL with
`?organization=<uuid>`.

The security rules say "do not create custom auth flows unless explicitly required". This one is
explicitly required by the product owner; it is kept as small as the contract allows and reuses Keel's
existing session, allauth authentication records, login signal, audit and MFA machinery.

## Decision
- Implement the OIDC relying party in `apps/accounts/workeasy360/` with a framework-free protocol
  module (the same verification code as the sibling products; PyJWT + cryptography, httpx transport)
  rather than allauth's socialaccount: the contract's `private_key_jwt`, `organization` parameter,
  claim handling and tenant mapping would all need custom code inside allauth anyway, and a small
  explicit module is easier to certify against the contract's seven verification steps.
- Two plain Django GET views (`/api/auth/workeasy360/start`, `/api/auth/callback/workeasy360`); the
  callback path equals the redirect URI already registered in Workeasy360. Flow state lives in the
  server-side session; CSRF protection for the callback is state + nonce + PKCE.
- After verification, Keel's own session takes over (ADR-0003 is unchanged): `django_login`,
  `record_authentication(method="workeasy360")`, the existing `user_logged_in` hook.
- Identity is (issuer, `sub`) in `ExternalIdentity`; tenants map 1:1 by
  `Organization.workeasy360_organization_id`. Existing accounts link by email only when Workeasy360
  says the address is verified; a first sign-in into an unknown Workeasy360 organization creates its
  Keel counterpart with that person as owner; later members join with `WORKEASY360_DEFAULT_ROLE`.
- Keel keeps authority over what happens inside Keel: a membership a Keel admin suspended or removed
  stays refused; roles are Keel's; the plan's seat limit applies.
- `aal >= 2` from Workeasy360 satisfies an organization's Require MFA for that session; a Workeasy360
  session must re-run the sign-in for `require_recent_auth`.
- `WORKEASY360_SSO_ONLY` (default on; off in development and tests) closes every allauth way in
  (password, sign-up, passkey, password reset), invitation sign-up and self-service organization
  creation. Production refuses to start when it is on and Workeasy360 is not configured.

## Consequences
- Keel's availability for *new* sign-ins depends on Workeasy360; existing sessions do not.
- A user disabled in Workeasy360, a removed member or an unassigned seat is refused within one entitlement
  window (15 minutes): requests ask Workeasy360 per person, background jobs per organization (see the
  doc below). Consuming Workeasy360 platform events (suspension, purge) is a follow-up.
- PyJWT becomes a runtime dependency (note in `docs/security/dependency-notes.md`).
- Password-based flows stay in the code for local development and as a rollback switch.
- Details and operations: [docs/workeasy360-sso.md](../workeasy360-sso.md).
