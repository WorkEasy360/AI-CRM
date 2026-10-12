# Sign in with Workeasy360

Keel is the Workeasy360 product **Easy CRM** (product code `easy_crm`). People sign in to it with
their Workeasy360 account; Workeasy360 is the identity provider ([ADR-0013](adr/ADR-0013-workeasy360-identity-provider.md)).
With `WORKEASY360_SSO_ONLY` on (the default outside local development) it is the **only** way in.

## How it works

```
Workeasy360 app launcher ── https://crm.workeasy360.com/?organization=<uuid>
        │  frontend middleware (src/lib/launcher.ts)
        ▼
GET /api/auth/workeasy360/start?organization=<uuid>&next=<path>
        │  state, nonce, PKCE verifier, organization, next  -> Django session
        ▼  302
Workeasy360 /authorize  (sign-in, MFA, organization choice, entitlement and seat checks)
        │  302
        ▼
GET /api/auth/callback/workeasy360?code=…&state=…
        │  state matched (constant time) and spent; code exchanged with a private_key_jwt
        │  client assertion; ID token verified offline (7 steps); claims -> user/org/membership
        │  django_login + allauth authentication record + user_logged_in signal
        ▼  302
next (default "/")          — or /login?sso_error=<code> on any failure
```

* Protocol: OpenID Connect authorization code + PKCE (S256), `private_key_jwt` client authentication,
  no refresh tokens. Only the issuer is configured; endpoints come from
  `{issuer}/.well-known/openid-configuration`, whose `issuer` must equal ours exactly. Discovery and
  the key set are cached for an hour; an unknown `kid` refreshes the key set once, then fails.
* ID token checks (`apps/accounts/workeasy360/oidc.py`): key by `kid` from the cached key set,
  algorithm from the key (RS256/ES256, never from the header), `aud` = client id, `iss`, `exp`/`nbf`
  with 30 s leeway, `typ == "id_token"`, `nonce` matches the session, `organization_id` present. Then
  `product_code` must be `easy_crm` when present, and when the launcher named an organization the
  token must be for that organization.
* Keel's session is the product session after that: Workeasy360 is not called per request.

### Who signs in (`apps/accounts/workeasy360/provisioning.py`)

| Situation | Result |
|---|---|
| (issuer, `sub`) already linked | that Keel user (email changes at Workeasy360 do not matter) |
| a Keel account has the address, `email_verified` true, no Workeasy360 identity yet | **linked**. If Keel itself never verified that address, the account's password is removed and its sessions revoked (it may have been pre-registered by someone else) |
| the address exists but Workeasy360 has not verified it | refused: `email_unverified` (no takeover) |
| the Keel account is linked to a different Workeasy360 account | refused: `account_conflict` |
| unknown address, verified | new account: no usable password, verified `EmailAddress`, name from `name` |
| unknown address, unverified | refused: `email_unverified` (an unverified address must not squat an account) |
| no `email` claim | refused: `email_missing` |

### Which organization

The Keel organization whose `workeasy360_organization_id` equals the token's `organization_id`. If
none exists, the sign-in creates it through `services.create_organization` (so the default pipeline
and `OrganizationCreated` subscribers run; the per-user owned-organization cap does not apply) and
that person becomes its **owner**. `organization_name` is only its starting name. Two simultaneous
first sign-ins collide on the unique column; the loser joins the winner's organization.

A suspended or deleting Keel organization is refused (`organization_unavailable`).

### Which membership

* active -> used as is (role unchanged);
* suspended or removed by a Keel admin -> refused (`membership_inactive`); signing in through
  Workeasy360 never undoes a Keel admin's decision;
* none -> created with `WORKEASY360_DEFAULT_ROLE` (default `sales_rep`), subject to the Keel plan's
  seat limit (`seat_limit`).

The session lands in that membership's organization (`active_membership_id`). Audit events:
`auth.sso_account_created`, `auth.sso_identity_linked`, `org.created` (source `workeasy360`),
`members.joined` (source `workeasy360`), `auth.login` (metadata `method: workeasy360`, `aal`), and
`auth.login_failed` (metadata `reason`) on every refusal.

### MFA

Workeasy360's `aal` claim (1 or 2) is stored in the session (`workeasy360_aal`). For a Workeasy360
session an organization's **Require MFA** setting is satisfied only by `aal >= 2`; a Keel
authenticator does not count, because Keel did not perform that sign-in. Password sessions keep the
existing rule (an enrolled authenticator). An `aal 1` user of such an organization sees a banner
asking them to turn on two-step verification in Workeasy360 and sign in again.

### Re-authentication

Sensitive actions call `require_recent_auth`. For a Workeasy360 session the newest authentication
record (a Workeasy360 sign-in, or a Keel MFA re-authentication) must be younger than
`ACCOUNT_REAUTHENTICATION_TIMEOUT` (10 minutes). allauth would otherwise treat a password-less account
as always recently authenticated. The "Confirm it's you" dialog offers **Confirm with Workeasy360**,
which runs the sign-in again and returns to the same page; the user then repeats the action.

Known gap: allauth's own MFA management endpoints (add/remove TOTP, passkeys) still use allauth's rule,
under which a password-less account without authenticators counts as recently authenticated.

### `WORKEASY360_SSO_ONLY`

When on:

* allauth password sign-in and password re-authentication are refused before the password is checked
  (`password_login_disabled`), sign-up answers 403, any other allauth sign-in (passkey) is refused in
  `pre_login`, and password-reset requests send nothing (to known or unknown addresses);
* `POST /api/v1/invitations/register/` (invitation sign-up with a password) answers 403
  `password_sign_in_disabled` — invitees sign in with Workeasy360 instead;
* `POST /api/v1/organizations/` answers 403 `organizations_managed_externally`;
* no personal workspace is created on login or email verification;
* the frontend hides the password form, sign-up and forgot-password (those pages redirect to `/login`)
  and the password card in Settings -> Security.

`GET /api/v1/auth/methods/` (public) returns `{"password": bool, "workeasy360": bool}`.

The development auto-login middleware is unchanged (it is not an allauth sign-in).

### Error codes (`/login?sso_error=`)

`cancelled`, `expired`, `unavailable`, `refused`, `rate_limited`, `not_entitled`, `no_seat`,
`provider_membership_inactive`, `organization_inactive`, `access_policy`, `email_missing`,
`email_unverified`, `account_conflict`, `account_disabled`, `membership_inactive`,
`organization_unavailable`, `seat_limit`, `wrong_product`. Nothing else is ever put in the URL;
details are logged (`workeasy360.sign_in_failed`). Workeasy360 authorize errors map as:
`access_denied` -> `cancelled`; `login_required`, `organization_required` -> `expired`;
`product_not_entitled` -> `not_entitled`; `product_no_seat` -> `no_seat`; `membership_inactive` ->
`provider_membership_inactive` (the Workeasy360 membership, distinct from Keel's
`membership_inactive`); `organization_inactive` -> `organization_inactive`; `access_policy_denied` ->
`access_policy`; `integration_suspended`, `invalid_scope`, `server_error`, `temporarily_unavailable`
-> `unavailable`; anything else -> `refused`.

## Settings

| Setting | Default | |
|---|---|---|
| `WORKEASY360_ISSUER` | — | e.g. `https://app.workeasy360.com`; https required in production |
| `WORKEASY360_CLIENT_ID` | — | from the Workeasy360 integration |
| `WORKEASY360_REDIRECT_URI` | — | `https://crm.workeasy360.com/api/auth/callback/workeasy360` (exact match) |
| `WORKEASY360_KEY_ID` | — | the credential id Workeasy360 returned for our public key |
| `WORKEASY360_PRIVATE_KEY` / `WORKEASY360_PRIVATE_KEY_FILE` | — | PEM (RSA or EC P-256), from the secret store; inline `\n` escapes allowed |
| `WORKEASY360_SCOPES` | `openid email profile organization` | |
| `WORKEASY360_PRODUCT_CODE` | `easy_crm` | ID tokens for another product are refused; empty disables |
| `WORKEASY360_DEFAULT_ROLE` | `sales_rep` | role for people joining an existing organization; never `owner` |
| `WORKEASY360_SSO_ONLY` | `true` (`false` in dev and test) | |

Sign-in is offered when issuer, client id, redirect URI, key id and a private key are all set.
`config.settings.prod` refuses to start when `WORKEASY360_SSO_ONLY` is on and sign-in is not
configured (nobody could sign in), when the issuer or redirect URI is not https, or when the key file
does not exist.

## Registering Easy CRM in Workeasy360

1. Generate a key pair (keep the private key out of the repository; gitleaks will block it):

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out easy-crm-w360.key
   openssl pkey -in easy-crm-w360.key -pubout -out easy-crm-w360.pub
   ```

   (or EC P-256: `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out easy-crm-w360.key`).
2. In Workeasy360, on the Easy CRM integration (product `easy_crm`): token endpoint authentication
   `private_key_jwt`; redirect URI `https://crm.workeasy360.com/api/auth/callback/workeasy360`; launch URL
   `https://crm.workeasy360.com/`; scopes **`openid email profile organization`** (all four must be
   registered, or Workeasy360 answers `invalid_scope`). Upload `easy-crm-w360.pub`.
3. Set `WORKEASY360_KEY_ID` to the credential id Workeasy360 returns for that key, and
   `WORKEASY360_CLIENT_ID` to the client id. Put the private key in the secret store and expose it as
   `WORKEASY360_PRIVATE_KEY` or a mounted `WORKEASY360_PRIVATE_KEY_FILE`.
4. Rotation: register a second public key, switch `WORKEASY360_KEY_ID`/the private key, then retire
   the old credential in Workeasy360.

Local development: Workeasy360 accepts `http://localhost:*` redirect URIs outside production, e.g.
`http://localhost:4000/api/auth/callback/workeasy360` (the Next.js dev server proxies `/api/` to
Django). Register that URI on a development integration and set `WORKEASY360_ISSUER` to the local
Workeasy360 backend.

## Moving an existing customer to Workeasy360 sign-in

Before the first sign-in, attach their Keel organization to their Workeasy360 organization, or a new
empty one is created:

```sh
python manage.py link_workeasy360_organization <keel-org-id-or-slug> <workeasy360-org-uuid>
```

It refuses when either side is already linked and writes `org.workeasy360_linked` to the audit log.
Existing members are then linked by verified email on their first Workeasy360 sign-in and keep their
roles and data.

## Universal sign-in: what the person controls (2026-10-12)

Workeasy360 now lets each person choose how it signs them in to products (Workeasy360 ADR-044):
automatically, after asking ("Ask me each time", the default), or by preferring the product's own sign-in.
Nothing about that choice lives in Keel; what it means here:

* **The sign-in page** asks "Already a Workeasy360 user?" with **Access Easy CRM**. When password sign-in
  is also on, Keel's own form sits behind **Use another sign-in method**.
* **Workeasy360's access chooser.** When the person's preference is to be asked, Workeasy360 shows its
  own "How would you like to access Easy CRM?" page before returning a code. Keel sees nothing new: either
  the usual callback with a code, the product's own sign-in page (if registered and chosen), or
  `error=access_denied` when the person chose Cancel (shown as `cancelled`).
* **Error codes added on the Workeasy360 side:** `unauthorized_client` (Easy CRM is registered there as
  not using Workeasy360 sign-in) maps to `unavailable`; `interaction_required` (only an answer to
  `prompt=none`, which Keel never sends) maps to `expired`.
* **"Confirm it's you" is a real confirmation.** Before, a round trip on a still-open Workeasy360 session
  counted as re-authentication. Now `start?reauth=1` sends `prompt=login` for the current organization (so
  Workeasy360 shows no organization chooser), Workeasy360 asks for the password again, and the callback
  refuses an ID token whose `auth_time` is older than the request (`reauthentication_failed`) or whose
  `sub` is not the Workeasy360 account signed in here (`reauthentication_wrong_account`). Someone else's
  password confirms nothing about the person at the keyboard, and the session is left exactly as it was -
  no silent account switch in the middle of a confirmation. For any Workeasy360 session, "recently
  authenticated" is measured from `auth_time` - when the password was entered at Workeasy360 - not from
  when Keel received the token.
* **Access is re-checked after sign-in, per person** (`apps/accounts/workeasy360/entitlement.py`).
  Workeasy360 checks the trial or plan, the membership and the seat at sign-in; Keel's own session then lasts
  up to 14 days. So Keel asks Workeasy360's entitlement API, as the integration guide requires, whether each
  organization linked to Workeasy360 may still use Easy CRM. A signed-in request asks for the organization
  **and the person** (`organization_id` + `subject`, the ID token `sub` the person signed in with, kept on the
  session at sign-in so a request costs no query; a session without it looks it up once). Workeasy360 then
  also denies with `membership_inactive` (account disabled or locked, membership suspended or removed) or
  `no_seat` (per-seat product, seat unassigned): a removed member stops working within the window instead of
  when the session ends, and the app says "Your access to Easy CRM in this organization has ended. Ask an
  administrator in Workeasy360." A Keel-only account in a linked organization has no `sub` and is asked at
  organization level, as background work is - unless `WORKEASY360_SSO_ONLY` is on: Workeasy360 is then the
  only way in, an account without a Workeasy360 identity cannot be asked about, and its request is refused
  with `403 workeasy360_sign_in_required` (the app shows "Sign in with Workeasy360"; signing in links the
  account by verified e-mail, after which it is checked per person). That closes a session opened before
  SSO-only was switched on and a Keel-only account in a linked organization. The session endpoint and
  sign-out stay reachable; an API credential acts for the organization and is still asked at organization
  level; with SSO-only off (development, `sso_optional` browser checks) nothing changes. One cached answer per (organization, person) for
  `revalidate_after` (capped at 900 s, at least 30 s), a denial re-asked after 60 s, authenticated with Easy
  CRM's own `private_key_jwt` credential. Every tenant API request (`RequirePermissions`, after the MFA
  policy) is refused with `403 workeasy360_access_ended` once the answer is `deny`, and every write with
  `workeasy360_read_only` while `write_allowed` is false; API credentials included. The session and sign-out
  stay reachable, and the app shows one "Easy CRM access has ended" screen (Try again, Sign out). A
  Workeasy360 outage is never a denial: the last answer stands, with none access continues, and after a
  failure the next attempt waits 60 s. A Keel-only organization is never checked. The worst case after
  access ends is one window (15 minutes).
  A refusal is not an outage: when Workeasy360 refuses Easy CRM's own client (400/401/403 - a revoked
  credential, a suspended integration) access is refused too (`workeasy360_access_unverified`, "Easy CRM can't
  confirm your access"), logged as an error, and **client-wide**: for 60 s after one, every question (a person's, an
  organization's, a job's) fails closed without being asked, and a 429 (Workeasy360 limits failed client
  authentications) within 5 minutes of the last refusal counts as a refusal, not an outage (the one question
  asked after the 60 s can still meet that limiter); after the 60 s one question is
  asked again. The mark survives a cache outage like a denial (each process keeps its own copy). A known denial never lapses into
  access: it is cached without expiry and each process keeps its own copy, so a Redis outage (production runs
  with `CACHE_FAIL_OPEN`) or an eviction cannot hand access back. Any unexpected failure counts as an outage,
  never a 500. Starting an export stays allowed while read-only (`entitlement_read_actions` on the export
  viewsets).
* **Background jobs ask too** (`apps/accounts/workeasy360/background.py`; classes below). A job with a
  customer business effect checks the organization (no person) through the same module - same cache,
  single-flight, back-off and refusal rules - before the effect. A denial is trusted for 900 s, not 60 s: an
  expired organization's jobs cost one question per window. It needs `allow` **and** `write_allowed`.
  Denied: the effect is skipped, `workeasy360.background_skipped` is logged (organization, task, reason),
  nothing is raised (so nothing retries in a loop) and nothing is deleted or rescheduled; the sweepers leave
  the denied organization's rows out of their batches (so they cannot starve the others) and pick them up
  after renewal. Outage: the last answer stands, with none the job runs. Only organizations linked to
  Workeasy360 are asked.

  | Class | Task | Effect and what a denial does |
  |---|---|---|
  | A | `activities.send_reminders` (beat, 60 s) | in-app reminders; stay unsent, go out after renewal |
  | A | `notifications.deal_health_sweep` (beat, daily) | stale-deal and risk alerts (AI risk scoring); skipped for the day |
  | A | `messaging.send_email_message`, `messaging.send_whatsapp_message` | outbound customer messages; not claimed, the message stays queued |
  | A | `messaging.resume_queued_sends` (beat, 300 s) | sweeper: sends still QUEUED after 5 minutes are handed to a worker again (denied organizations left out) |
  | A | `messaging.sync_email_accounts` (beat, 300 s) and `messaging.sync_email_account` | pulls mail into the CRM; not fanned out / not synced |
  | A | `integrations.dispatch_event`, `integrations.deliver` | outbound webhooks; events and deliveries stay pending |
  | A | `integrations.run_sync_job`, `integrations.schedule_sync` | external syncs; jobs stay as they are, connections stay due |
  | A | `integrations.process_inbound_event` | applies inbound webhooks to CRM data; stays received |
  | A | `integrations.drain` (beat, 30 s) | sweeper: rows of denied organizations are left out of every batch; also hands inbound events still RECEIVED after 5 minutes to a worker again |
  | A | `rag.index_source`, `rag.rebuild_organization` | AI embedding work; index events stay pending |
  | A | `rag.drain_pending` (beat, 120 s) | sweeper, as above |
  | A | `importexport.run_import` | changes customer data; a PENDING job is marked "Paused: ... continues once access is renewed" |
  | A | `importexport.resume_stalled_imports` (beat, 300 s) | sweeper, as above; also runs those paused jobs after renewal, claiming each by clearing its marker in one UPDATE |
  | B | `importexport.run_export` | finishing an export the customer already asked for; allowed while read-only too |
  | B | `importexport.purge_expired`, `importexport.fail_stale_jobs` (beat) | expiry and quota cleanup; `fail_stale_jobs` leaves a denied organization's imports alone (they are waiting, not lost) |
  | B | `messaging.reconcile_stuck_sends` (beat) | settles sends already in flight; never a second message |
  | B | `rag.purge_organization` | deletion and erasure |
  | C | `accounts.send_email` | transactional mail (sign-in, invitations, security); no organization context |
  | C | `observability.publish_celery_metrics`, `observability.publish_dependency_health` (beat) | system monitoring |

  Skipped work resumes after renewal, once. Three kinds of work are parked when a job skips: a queued
  message, a received inbound webhook (the webhook endpoint cannot refuse it: it is not a person), a paused
  import. `messaging.resume_queued_sends` and `integrations.drain` hand QUEUED messages and RECEIVED
  inbound events older than 5 minutes to a worker again (5 minutes: well past normal queueing, so a send
  merely waiting behind others is rarely handed over twice; and if it is, the claim - QUEUED to SENDING, or
  RECEIVED under a `skip_locked` row lock - lets exactly one run apply it). Sends that reconciliation puts
  back to QUEUED are caught the same way.

  Two timing rules apply to every entitlement question: the HTTP call has a 5 s timeout (sign-in keeps
  10 s), since a request makes it inside its database transaction; and Celery's `SoftTimeLimitExceeded` is
  never swallowed as an outage.
* **"Confirm it's you" needs a Workeasy360 account to confirm.** For a Keel-only account (or nobody signed
  in) `start?reauth=1` is refused (`reauthentication_failed`), so an unbound confirmation can never sign in
  whoever answers. A Workeasy360 authentication record without `auth_time` does not count as recent.
* **No local password for a Workeasy360 account**, even with password sign-in on: setting, changing or
  resetting one is refused (`password_managed_by_workeasy360`) and no reset link is sent. A local password
  would be a second way in that skips Workeasy360's MFA, access policy and membership checks.
* **Sign-out.** "Sign out of Easy CRM" ends Keel's session only. With
  `WORKEASY360_POST_LOGOUT_REDIRECT_URI` set (and registered in Workeasy360 as a post-logout URI of the
  Easy CRM integration), the account menu also offers **Sign out of Easy CRM and Workeasy360**: Keel's
  session ends first, then `GET /api/auth/workeasy360/logout` sends the browser to Workeasy360's
  `end_session_endpoint`, which asks the person to confirm and returns them to that URI. Other products'
  sessions are not ended - no product implements a logout contract Workeasy360 could call.
* **Account switching.** A callback for a different person than the one signed in flushes the session
  (`django_login`), so nothing of the first person's session survives.

| Setting | Default | |
|---|---|---|
| `WORKEASY360_POST_LOGOUT_REDIRECT_URI` | — | e.g. `https://crm.workeasy360.com/login`; https in production; exact match with Workeasy360's registration. Empty: only Keel's own sign-out |
