# ADR-0003 — Cookie sessions, same-origin API, django-allauth headless for auth and MFA

**Status:** Proposed

## Context
Browser clients need authentication that is resistant to XSS token theft and CSRF, supports revocation, MFA and passkeys, and does not require us to write our own token or MFA cryptography.

## Decision
Server-side database sessions in an `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefixed cookie; Django CSRF protection on all state-changing requests; frontend and API on the same origin. Account lifecycle (signup, verification, password reset, rate limiting) and MFA (TOTP, recovery codes, WebAuthn) provided by `django-allauth` in headless mode. Session keys are rotated on every authentication or privilege event; a `user_session` table provides listing and revocation. No JWTs in the browser; API tokens for integrations are a separate, later feature.

## Consequences
- No secrets in `localStorage`; revocation is immediate.
- Deployment must keep frontend and API on one origin (reverse proxy).
- We depend on allauth's release cadence for auth security fixes (tracked by Dependabot and pip-audit).
- SSO providers can be added through allauth's provider system without changing the session model.
