# Security Rules

## Scope
Apply these rules to security reviews, authentication, authorization, secrets, tenant isolation, dependency security, and production hardening.

## Core Principle
Security must never be weakened to save time, tokens, or implementation effort.

## Tenant Isolation
- Preserve PostgreSQL Row Level Security.
- Preserve fail-closed tenant managers.
- Never trust tenant/org IDs from client input.
- Prevent all cross-tenant reads and writes.
- Verify tenant context before accessing tenant-owned data.

## Authentication
- Use existing authentication/session mechanisms.
- Do not create custom auth flows unless explicitly required.
- Protect sensitive routes.
- Enforce secure session/cookie settings.
- Never expose authentication tokens in logs or responses.

## Authorization
- Authorization must be enforced server-side.
- Never rely only on frontend visibility rules.
- Check object-level permissions.
- Prevent IDOR/BOLA-style access.
- Apply least privilege.

## Input Security
- Treat all external input as untrusted.
- Validate and normalize input.
- Prevent:
  - SQL injection
  - XSS
  - CSRF
  - command injection
  - path traversal
  - SSRF
  - unsafe file uploads

## Secrets
- Never hardcode:
  - API keys
  - passwords
  - database credentials
  - private tokens
  - encryption keys

- Use approved secret-management mechanisms.
- Never print secrets in logs, tests, screenshots, or error messages.

## API Security
- Validate request payloads.
- Limit exposed fields.
- Prevent mass assignment.
- Rate-limit sensitive endpoints where required.
- Avoid leaking internal exceptions.
- Use consistent authorization checks.

## Database Security
- Preserve constraints and RLS policies.
- Avoid raw SQL unless required.
- Review any raw SQL for injection and tenant isolation.
- Use transactions where security-sensitive state changes must remain atomic.

## Audit
Security-sensitive actions should remain auditable, including:
- permission changes
- authentication events
- important data changes
- administrative actions
- tenant-sensitive operations

## Dependencies
- Do not add unnecessary packages.
- Prefer maintained dependencies.
- Check security impact before adding libraries.
- Do not suppress vulnerability findings without justification.

## Security Tools
Preserve existing checks such as:
- Bandit
- Semgrep
- pip-audit
- Gitleaks
- Trivy
- dependency audits

Never disable a security gate just to make CI pass.

## Review Priority
For security-related changes, verify in this order:

1. Tenant isolation
2. Authentication
3. Authorization
4. Input validation
5. Secret exposure
6. Data leakage
7. Auditability
8. Dependency risk

## Efficiency
- Inspect only the security-relevant code for the task.
- Do not scan the entire repository unless necessary.
- Start from changed files and security boundaries.
- Avoid speculative redesigns.

## Output
Report only:
1. Security issue/change
2. Files affected
3. Validation performed
4. Remaining risk