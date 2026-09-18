# Integration Hub

Settings → **Integrations** (owners and admins; never in the sales sidebar). Code: `backend/apps/integrations/`.

An external integration is a security boundary. Every operation passes, in order:

```
tenant context → integration identity → scope / sharing policy → record authorization
  → field allowlist + mapping → validation → CRM service layer → RLS
```

## 1. Components

| Module | Responsibility |
|---|---|
| `providers/base.py` | `IntegrationProvider` contract: `connect`, `authorization_url` / `complete_authorization`, `disconnect`, `refresh_credentials`, `test_connection`, `health`, `pull`, `push`, `handle_webhook`. Stateless; errors are `ProviderError(code, retryable, action_required, retry_after)`. |
| `providers/generic_rest.py` | Any JSON REST API: OAuth 2.0 (authorization code + PKCE, client credentials), API key, bearer token, signed-webhook-only. |
| `providers/messaging.py` | Google Workspace, Microsoft 365, WhatsApp: adapters over the existing `apps.messaging` connections (their credentials stay there; the hub shows status and links to their settings page). |
| `models.py` | `IntegrationConnection`, `SharingPolicy`, `FieldMapping`, `IntegrationRecordMap`, `SyncJob`, `SyncConflict`, `IntegrationEvent` (outbox), `OutboundDelivery`, `WebhookSubscription`, `InboundEvent`, `ApiCredential`. All tenant-owned with forced RLS. |
| `net.py` | The only outbound HTTP client for organization-configured destinations (SSRF defences, §6). |
| `fields.py` | Shareable entities, readable/writable field allowlists, hard denylist, mapping validation. |
| `identity.py` | `IntegrationActor`: acts through a real membership with *intersected* grants. |
| `events.py`, `signals.py` | Transactional outbox written by CRM saves. |
| `delivery.py`, `tasks.py` | Fan-out, delivery attempts with retries, sync jobs, sweeper — all on the `integrations` Celery queue. |
| `sync.py` | Outbound push, inbound apply, conflicts, batch jobs. |
| `webhooks.py` | Outbound subscriptions and the inbound receiver. |
| `machine_auth.py`, `scopes.py`, `throttles.py` | API credentials for external software calling Keel. |

## 2. Connections and credentials

- Credentials are sealed with `apps.core.crypto` (MultiFernet, `MESSAGING_ENCRYPTION_KEYS`) in `*_enc` columns.
  They are decrypted only inside provider calls, never logged, never serialized (the API shows only
  `credentials_configured: ["api_key"]`), and wiped on disconnect. API credentials Keel issues are stored as
  SHA-256 hashes of 256-bit random secrets; webhook signing secrets must be reversible (Keel signs with them) and
  are encrypted.
- Creating a connection, changing its base URL or credentials, widening sharing, enabling or rotating inbound
  secrets, disconnecting and creating API keys require a re-authentication in the last 10 minutes.
- A connection acts as `connected_by` with the intersection of that member's grants and the permissions implied
  by its sharing policies (`sync.connection_permissions`). If the member loses `integrations.manage`, is
  suspended or removed, the connection moves to **Action required** and stops.
- Disconnect: best-effort RFC 7009 token revocation, secrets wiped, pending jobs and deliveries cancelled.
  CRM data, sharing configuration and record links are kept so a reconnect resumes; delete removes the
  configuration once disconnected.

### OAuth 2.0 (authorization code + PKCE)

```
POST /integrations/connections/{id}/oauth/start/   state (256-bit) + code_verifier cached 10 min,
                                                  bound to organization + member + connection
browser → provider consent → GET /api/v1/integrations/oauth/callback/?state&code
server: state must match this session's organization and member (single use) → token exchange with
        code_verifier through net.safe_request → tokens sealed → test_connection → redirect to the connection
```

The provider's client secret never reaches the browser. Access tokens refresh 60 s before expiry; a refresh
failure sets **Action required** ("Your … connection has expired. Reconnect your account.").

## 3. Data sharing and field mapping

- `SharingPolicy` per entity: `none | outbound | inbound | two_way` plus the external API path. No row = nothing
  shared. Shareable: contacts, companies, deals (inbound deals are update-only). Never shareable: notes, email,
  WhatsApp, attachments (and anything not listed).
- `FieldMapping` rows map one CRM field to one external field. Allowed CRM fields come from
  `fields.ENTITIES[...]` (`readable` for outbound, `writable` for inbound, both for two-way) plus active custom
  fields. The **denylist** (`DENIED_FIELD_FRAGMENTS`: password, secret, token, session, csrf, mfa, key, hash,
  credential, `_enc`, …) is applied to standard and custom field names and cannot be overridden by any client.
- Outbound payloads are rebuilt from the live allowlist at send time (`fields.outbound_values`), so even a mapping
  row inserted behind the service's back cannot leak an unlisted field. Inbound values are filtered the same way
  and then validated by the module's own write serializer and saved through `records.create/update` or
  `deals.services.update_deal` (permission checks, versioning, audit).

## 4. Synchronization

- **Outbound:** CRM save → `IntegrationEvent` in the same transaction (only for organizations with a
  subscription or outbound policy; cached per organization) → after COMMIT `integrations.dispatch_event` → one
  `OutboundDelivery` per destination → `integrations.deliver`. A CRM save never waits for an external system.
- **Inbound:** signed webhook (§5) or scheduled/manual pull → `sync.apply_inbound`. Writes are attributed in the
  audit log as `actor_type=integration` with the connection id and are not echoed back to the same connection.
- **Idempotency:** a record is pushed only when the hash of its mapped values changed; creates carry an
  `Idempotency-Key`; `IntegrationRecordMap` links CRM ↔ external ids (never fuzzy matching); inbound webhook
  event ids are unique per connection; deliveries keep a stable `event_id`.
- **Conflicts (two-way):** when both sides changed since the last sync and values differ: `manual` (default,
  opens a `SyncConflict` for Keep CRM / Apply external), `crm_wins`, `external_wins`, `newest_wins` (falls back to
  manual when the provider sends no update time).
- **Retries:** at most `INTEGRATIONS_MAX_DELIVERY_ATTEMPTS` (8) with exponential backoff and full jitter (30 s
  base, 6 h cap), never sooner than `Retry-After`. 4xx other than 408/425/429, blocked destinations and lost
  access are permanent. The `integrations.drain` beat task (30 s) re-enqueues lost or due work.
- **Batch jobs:** "Sync now" or `sync_interval_minutes` creates a `SyncJob` (one active per connection) that
  processes `INTEGRATIONS_SYNC_BATCH_SIZE` records per task invocation (push phase, then pull phase with the
  provider cursor), re-enqueuing itself and exposing progress (processed / succeeded / failed / conflicts, last 20
  error codes with human messages).
- **Queue:** `integrations`, consumed by the heavy worker, so slow providers never delay notifications, email,
  RAG indexing or critical CRM work.

## 5. Webhooks

### Outbound (Keel → your URL)

Events: `contact.created|updated`, `company.created|updated`, `deal.created|updated|stage_changed`,
`task.completed`. Payloads are thin by default (`{"id","type","created_at","data":{"object","id"}}`);
"include record fields" adds `data.attributes` with allowlisted standard fields, read through the creator's
current authorization. Headers:

```
Keel-Event-Id: <uuid, stable across retries>      Keel-Event-Type: contact.updated
Keel-Timestamp: <unix seconds>                    Keel-Signature: t=<ts>,v1=<hex>[,v1=<hex previous secret>]
v1 = HMAC-SHA256(secret, "<ts>." + raw body)
```

Receivers must verify the signature in constant time, reject timestamps older than 5 minutes and de-duplicate on
`Keel-Event-Id`. Rotating the secret keeps signing with the previous one for 24 h. Subscriptions are turned off
(and admins notified once) after 15 consecutive failures. Destinations must be public https URLs.

### Inbound (your system → Keel)

`POST /api/v1/integrations/inbound/<key>/` with `Keel-Event-Id`, `Keel-Signature` (same scheme, with the
connection's inbound secret) and a JSON body `{"type": "contact.upsert"|"company.upsert"|"deal.upsert",
"data": {"id": "<external id>", ...}}`. Checks, in order: body ≤ 256 KB → URL key (stored hashed) → per-connection
rate limit (`INTEGRATIONS_INBOUND_PER_MINUTE`) → signature + ±5 min timestamp → event id → JSON schema →
duplicate event id (acknowledged, not processed) → stored and processed asynchronously; the payload is cleared
after processing. Responses carry only a status code (`202`, `200 duplicate`, `401`, `404`, `413`, `422`, `429`).

## 6. SSRF defences (`net.safe_request`)

https only (`INTEGRATIONS_ALLOW_HTTP` for local development), ports 443/8443, no userinfo, no internal suffixes
(`.internal`, `.local`, …), every resolved address must be public (loopback, RFC 1918, link-local, CGNAT,
multicast, reserved, unspecified, IPv4-mapped/6to4/Teredo embeddings and cloud metadata addresses are refused),
the connection is pinned to the checked IP with the original Host/SNI (no DNS rebinding), redirects are never
followed, 10 s timeouts, response bodies capped, proxy environment variables ignored.

## 7. External software → Keel (API credentials)

- Created under Integrations → API keys; the key `keel_<prefix>_<secret>` is shown once. Name, scopes, expiry
  (default 90 days, max `INTEGRATIONS_API_KEY_MAX_DAYS`), last used, revoke.
- Scopes (deny by default, no catch-all): `contacts:read|write`, `companies:read|write`, `deals:read|write`,
  `activities:read|write`. A key acts through its creator's membership with the intersection of the creator's
  current grants and the scopes' permissions; it cannot grant more than the creator has.
- Accepted only on `/api/v1/contacts|companies|deals|activities/` (`403` everywhere else, including session,
  members, settings, integrations and allauth); never creates a session; a request with both a session cookie and
  a key is refused. Rate limits: per credential (300/min), per organization (1000/min), per credential+endpoint
  (120/min).

## 8. Credential key rotation

```
MESSAGING_ENCRYPTION_KEYS=<new>,<old>   deploy
python manage.py reencrypt_secrets      rewrites mailbox, WhatsApp, integration and webhook secrets
MESSAGING_ENCRYPTION_KEYS=<new>         deploy (the command fails while any value is unreadable)
```

## 9. Troubleshooting

| Symptom (UI message) | Code | Action |
|---|---|---|
| "Your … connection has expired. Reconnect your account." | `auth_expired` | Reconnect (OAuth) or update credentials. |
| "… rejected the credentials." | `auth_failed` | Check the key's permissions at the provider. |
| "The member who connected … no longer has access." | `member_lost_access` | An admin reconnects or updates credentials (becomes the new acting member). |
| "This address points to a private network…" | `private_destination` | Use the public https endpoint. |
| "… answered with a redirect…" | `redirect_not_followed` | Configure the final URL. |
| "… is limiting requests / temporarily unavailable" | `rate_limited` / `unavailable` | None: retried with backoff. |
| "… returned a response Keel could not read" | `invalid_response` | Check `list_key`, `id_field` and paths under Advanced. |
| Records not syncing | — | Data sharing tab: direction, API path, at least one mapped field; Conflicts tab. |
| Inbound webhook `401` | `invalid_signature` | Sign `"<t>." + raw body` with the current (or previous, 24 h) secret; send `t` in seconds. |

Technical detail (status codes, provider error bodies) is only in structured logs keyed by the same codes.

## 10. Adding a provider

1. Implement `IntegrationProvider` in `providers/<name>.py` (reuse `net.safe_request` for every call; raise
   `ProviderError` codes; never return raw provider text).
2. Register it in `providers/__init__.py`; add auth types and `supports_sync` / `supports_inbound_webhooks`.
3. Add messages for any new codes in `errors.py`.
4. If it shares new record types, extend `fields.ENTITIES` (reviewed allowlist) and `sync.binding`.
5. Tests: tenant isolation, SSRF (if it takes URLs), field allowlist, malformed responses, retries.
