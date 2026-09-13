# Authentication Design

Decision (ADR-0003): **server-side sessions in `HttpOnly` cookies, same-origin API, `django-allauth` (headless mode) for account lifecycle and MFA.** No JWTs in the browser. No third-party identity provider in the MVP; SSO (OIDC/SAML) is a Phase 5+ add-on behind allauth's provider abstraction.

Why allauth: one actively maintained, widely audited package covers email verification, password reset, rate limiting, TOTP MFA, recovery codes and WebAuthn/passkeys. Writing these ourselves would add risk without benefit.

## 1. Flows

| Flow | Design |
|---|---|
| Sign-up | Email + password (Argon2id via Django's `Argon2PasswordHasher` as default hasher). Creates `user` (unverified) and an `organization` with an `Owner` membership. Verification email with single-use, hashed, 24 h token. Login is blocked until verified. Response is generic whether the email exists or not. |
| Login | Email + password → rate limited (per IP and per account) → MFA challenge if enabled → session created → `session.cycle_key()` → `user_session` row → audit `auth.login`. Failed attempts audited as `auth.login_failed` with no password material. After 10 failures in 15 min per account: temporary lock + email notice; per IP: exponential backoff. |
| MFA | TOTP (RFC 6238) with encrypted secret, 10 single-use hashed recovery codes. WebAuthn passkeys as a second factor and as passwordless login are supported by the same library; UI ships after Phase 1 but the data model and endpoints are present. Owners/Admins can enforce MFA org-wide (`organization.settings.require_mfa`). |
| Password reset | Generic response; single-use hashed token, 1 h expiry; reset invalidates all sessions and MFA "remember device" grants; audit `auth.password_reset`. |
| Invitation | Admin invites by email + role. Hashed token, 7-day expiry. Acceptance creates membership (existing user) or user + membership (new user). Invitation-based accounts still verify email implicitly through the token. |
| Session lifetime | Idle timeout 12 h, absolute lifetime 14 days (`SESSION_COOKIE_AGE`, refreshed on activity via `SESSION_SAVE_EVERY_REQUEST` with a throttle). Sessions stored in the database (`django.contrib.sessions.backends.db`) so revocation is authoritative; Redis cache-backed reads via `cached_db`. |
| Session rotation | On login, MFA success, password change, role change, organization switch, and privilege elevation (`cycle_key()` + new `user_session` row). |
| Revocation | User: "Sign out everywhere". Admin: disable member → revoke all sessions in that org. Password/MFA change → revoke all other sessions. `user_session.revoked_at` is checked by `TenantMiddleware` (cached 60 s with immediate invalidation on revoke). |
| Recent authentication | Sensitive actions (change email/password, MFA settings, role changes, org deletion, export of all data, integration credentials, API token management) require `mfa_verified_at`/`last_password_auth_at` within 10 minutes; otherwise the API returns `403 reauth_required` and the UI opens a re-auth dialog. |
| Suspicious login | New device/IP fingerprint (hashed UA + /24 or /64 prefix) triggers an email notice; impossible-travel heuristic logged for monitoring. |
| Logout | Deletes the session server-side and clears the cookie; audit `auth.logout`. |

### 1.1 As implemented (Phase 1)

- Account lifecycle and MFA are served by `django-allauth` **headless** (`/_allauth/browser/v1/...`): signup,
  email verification (mandatory, link-based, 1-day expiry), login, logout, password request/reset/change,
  re-authentication, TOTP + recovery codes, WebAuthn endpoints (UI deferred), session listing/revocation
  (`allauth.usersessions`). Enumeration prevention is set to `strict`.
- Revocation is two-layered: every `User` carries a `session_salt` folded into `get_session_auth_hash()`;
  `revoke_user_sessions()` rotates it (Django then rejects every existing session on its next request) **and**
  purges allauth's tracked session rows. It runs on role change, member disable, password change and reset.
- Session rotation (`cycle_key()`) happens on login (Django), organization creation, organization switch and
  invitation acceptance.
- Idle timeout (12 h) is enforced by `TenantMiddleware` from a session timestamp written at most every 5 minutes;
  absolute lifetime is 14 days.
- Recent authentication (10 minutes, allauth `did_recently_authenticate`) is required for role changes,
  member disable/enable and organization settings; the API answers `403 reauth_required`.
- Organization-wide MFA (`settings.require_mfa`) is enforced by `RequirePermissions`: tenant routes answer
  `403 mfa_required` until the user enrols; `/api/v1/session/` and the allauth endpoints remain reachable.
- New-device notice: a login from an IP + user-agent pair not seen in the user's tracked sessions produces an
  `auth.suspicious_login` audit event and a plain-text email (skipped on the first ever login).
- Failed logins are audited with the attempted email only; passwords never reach the audit log or structured logs.

## 2. Cookies and CSRF

| Setting | Value |
|---|---|
| `SESSION_COOKIE_HTTPONLY` | `True` |
| `SESSION_COOKIE_SECURE` / `CSRF_COOKIE_SECURE` | `True` in staging/prod |
| `SESSION_COOKIE_SAMESITE` | `Lax` (`Strict` breaks legitimate top-level navigations from email links; `Lax` + CSRF tokens is the standard choice) |
| `CSRF_COOKIE_HTTPONLY` | `False` (frontend must read it to send `X-CSRFToken`); the token itself is not a secret that grants access |
| `CSRF_TRUSTED_ORIGINS` | exact production origins only |
| `SESSION_COOKIE_NAME` | `__Host-keel_session` (the `__Host-` prefix pins the cookie to the origin, no `Domain` attribute) |

All state-changing API calls require the `X-CSRFToken` header; DRF's `SessionAuthentication` enforces CSRF. CSRF is never disabled globally or per view. Auth endpoints that must be callable before a session exists (login, signup) still use CSRF via the pre-fetched token cookie.

## 3. API tokens (later)

Personal access tokens / integration keys are a Phase 5 feature: random 256-bit token, stored as SHA-256, prefixed (`keel_pat_`) for secret scanners, scoped permissions, expiry, last-used tracking, revocable, never usable for the web UI.

## 4. Rate limiting and brute-force controls

- DRF throttles: anonymous auth endpoints 10/min per IP; authenticated API default 600/min per user with per-endpoint overrides; export/import/AI endpoints have their own stricter buckets.
- Redis-backed sliding window; keyed on IP for anonymous and on user id for authenticated (never trust `X-Forwarded-For` unless set by our own proxy; `SECURE_PROXY_SSL_HEADER` and trusted proxy list configured).
- Login: allauth rate limits plus the account lock described above.
- Credential stuffing: optional HIBP k-anonymity password check on set/change (range API, no plaintext leaves the server), blocked-password list (Django's `CommonPasswordValidator` + `UserAttributeSimilarityValidator` + min length 12).

## 5. Password policy

Minimum 12 characters, no composition rules, checked against common lists and user attributes, Argon2id parameters tuned to ~100–150 ms on production hardware, rehash on login when parameters change.
