# Security Architecture

Control catalogue mapped to the threat register (`threat-model.md`) and to delivery phases. Standards: OWASP ASVS 4.0 (Level 2 target), OWASP Top 10, OWASP API Security Top 10, OWASP Top 10 for LLM Applications, Django security guidance.

## 1. Django settings baseline (production)

| Setting | Value |
|---|---|
| `DEBUG` | `False`; settings module refuses to start with `DEBUG=True` when `ENVIRONMENT=production` |
| `SECRET_KEY` / `SECRET_KEY_FALLBACKS` | from secrets manager; rotation supported |
| `ALLOWED_HOSTS` | exact hostnames |
| `CSRF_TRUSTED_ORIGINS` | exact `https://` origins |
| `SECURE_SSL_REDIRECT` | `True` (proxy also redirects) |
| `SECURE_PROXY_SSL_HEADER` | `("HTTP_X_FORWARDED_PROTO", "https")` with the proxy stripping client-supplied values |
| `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE` | `True` |
| `SESSION_COOKIE_HTTPONLY` | `True` |
| `SESSION_COOKIE_SAMESITE`, `CSRF_COOKIE_SAMESITE` | `Lax` |
| `SECURE_HSTS_SECONDS` | `31536000` after a 1-week ramp (`300` → `86400` → full) |
| `SECURE_HSTS_INCLUDE_SUBDOMAINS` | `True` once all subdomains are HTTPS |
| `SECURE_HSTS_PRELOAD` | `False` until domain readiness is confirmed and documented |
| `SECURE_CONTENT_TYPE_NOSNIFF` | `True` |
| `SECURE_REFERRER_POLICY` | `strict-origin-when-cross-origin` |
| `X_FRAME_OPTIONS` | `DENY` (plus CSP `frame-ancestors 'none'`) |
| `DATA_UPLOAD_MAX_MEMORY_SIZE` | 1 MB for JSON; file endpoints use explicit limits |
| `DATA_UPLOAD_MAX_NUMBER_FIELDS` | 500 |
| `PASSWORD_HASHERS` | Argon2 first |
| `AUTH_PASSWORD_VALIDATORS` | min length 12, common, similarity, numeric |
| `ATOMIC_REQUESTS` | `True` |
| `DATABASES[...]["OPTIONS"]` | `sslmode=verify-full`, `options=-c statement_timeout=15000` |
| Logging | JSON, no request bodies, redaction filter |

## 2. Content Security Policy

Delivered by `django-csp` on API responses and by Next.js middleware on pages with a per-request nonce:

```
default-src 'self';
script-src 'self' 'nonce-<random>' 'strict-dynamic';
style-src 'self' 'nonce-<random>';
img-src 'self' data: blob: https://<attachments-cdn>;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
form-action 'self';
base-uri 'none';
object-src 'none';
upgrade-insecure-requests;
report-to csp-endpoint;
```

Rolled out in `Content-Security-Policy-Report-Only` in staging first; violations reviewed before enforcement. No third-party scripts in the MVP.

## 3. Control catalogue

| Area | Controls | Threats | Phase |
|---|---|---|---|
| Tenant isolation | scoped managers, `TenantContextMissing`, immutable `organization_id`, RLS + `SET LOCAL`, two DB roles, router-generated cross-tenant tests, RLS coverage test, `all_objects` audit | T1, T2, T20, T27 | 1 |
| Authentication | Argon2id, allauth flows, MFA/TOTP/recovery/WebAuthn, hashed tokens, rate limits, lockout, session rotation, revocation table, recent-auth for sensitive actions, suspicious-login notice | T4, T22, T30 | 1 |
| Authorization | permission catalogue, roles, scopes, `check`/`scope`, route coverage test, role invariants, field-level writable sets, bulk scope pre-check | T3, T8 | 1 |
| Input validation | DRF serializers with explicit fields, allowlisted filters/sorts/expands, custom-field validation against definitions, JSON schema for widget/view configs, size caps, phone/email/URL validators, URL SSRF validator | T8, T13, T14 | 1–2 |
| Output handling | explicit output serializers, error format without internals, redaction filter, React escaping, markdown sanitiser, `Content-Disposition: attachment` for files | T10, T16 | 1–2 |
| CSRF/session | Django CSRF, `SessionAuthentication`, `__Host-` cookies, `SameSite=Lax` | T9 | 1 |
| Headers/CSP | `SecurityMiddleware`, CSP with nonces, `frame-ancestors 'none'`, nosniff, referrer policy, permissions policy | T10, T23 | 1 |
| Redirects | `next` validated with `url_has_allowed_host_and_scheme`; OAuth state + PKCE | T24 | 1, 5 |
| Rate limiting | DRF throttles (Redis), WAF rate rules, per-feature buckets, Celery time limits, statement timeout | T4, T19 | 1 |
| Audit | `audit.record()` from services, append-only grants, redaction, admin viewer, retention | T16, T3, T11 | 1 |
| Files | allowlist extension + magic bytes, random keys, private buckets, signed URLs 15 min, size caps, AV scan hook, separate attachments origin | T13, T10 | 2 |
| Import/export | async jobs, row/size caps, per-row serializer validation, formula neutralisation, audit, large-export alert | T11, T12, T19 | 2 |
| Search | scoped querysets, `websearch_to_tsquery`, query length cap, no raw SQL | T1, T19 | 2 |
| Concurrency | `version` + `If-Match`, `select_for_update` in stage moves, deferrable unique constraints | T8 (races) | 2 |
| AI | permission-gated read-only tools, no org args, delimiting/escaping, injection heuristics, output validators, proposals + confirm, budgets, ledger, anomaly alerts, honest labels, registry gating, provider adapter, red-team suite | T2, T5, T6, T7, T25, T26 | 4 |
| Integrations | envelope encryption (KMS), decrypt-in-memory only, SSRF guard at save and send, HMAC + timestamp + replay table, egress allowlist, credential rotation, audit | T14, T15, T21 | 5 |
| Secrets | secrets manager, KMS, no secrets in images/prompts/logs/bundles, gitleaks, `NEXT_PUBLIC_` review, key rotation with fallbacks | T17 | 1 |
| Supply chain | lock files, pip-audit, pnpm audit, Dependabot, Trivy, SBOM, pinned GitHub Actions by SHA, package review checklist | T18 | 1 |
| Infrastructure | private subnets, security groups, least-privilege IAM per task, non-root read-only containers, WAF, TLS everywhere, managed encryption at rest, separate envs | T17, T19, T28 | 1 (dev/CI), 6 (prod hardening) |
| Monitoring | structured logs, security event log group, alerts for login failures, role changes, large exports, cross-tenant attempts (404 bursts on foreign ids), error-rate spikes, AI spend spikes, webhook failures | all | 1 (logging), 3 (alerts), 6 (SIEM-ready) |
| Backup/DR | PITR, cross-region copies, monthly restore test, runbooks | T28 | 6 |
| Privacy | data export, user deletion, tenant deletion, retention jobs, PII inventory, provider data minimisation | T29, T7 | 1 (design), 6 |

## 4. Secure coding rules (enforced by review + Semgrep)

- No `objects.all()`/`filter()` outside scoped managers; no `all_objects` outside `core.tenancy.system`.
- No raw SQL with string formatting; `RawSQL`/`extra()` banned; `.raw()` only with parameters and review.
- No `mark_safe`, `|safe`, `dangerouslySetInnerHTML`.
- No `eval`, `exec`, `pickle` on untrusted data; `yaml.safe_load` only.
- No `ModelSerializer` with `fields = "__all__"` or `exclude`.
- Every view class declares `permission_map`.
- Every Celery task uses `@tenant_task` (which requires `organization_id`).
- No secrets in settings files; only `env()` lookups.
- No `requests.get(user_url)` without `ssrf_guard.safe_get`.
- Exceptions are never swallowed silently; user-facing errors go through the problem-details handler.

## 5. Security gate template

Produced at the end of every phase (see `docs/plan/development-phases.md`):

1. Attack surface introduced
2. Threats identified (new register entries)
3. Security controls implemented
4. Authorization checks implemented
5. Tenant-isolation checks
6. Input-validation checks
7. Tests written
8. Remaining vulnerabilities
9. Dependencies introduced (with review notes)
10. Security scan results (Semgrep, Bandit, pip-audit, pnpm audit, gitleaks, Trivy, CodeQL)
11. Risks accepted (with owner and expiry)
12. Safe to continue? (No, if any Critical/High is open)
