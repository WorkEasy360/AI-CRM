# Backend Rules

## Scope
Apply these rules only to backend work.

## Stack
- Django
- Django REST Framework
- PostgreSQL
- Celery
- Redis

## Efficiency
- Read only files relevant to the requested backend task.
- Search before opening large files.
- Do not inspect unrelated Django apps.
- Reuse existing services, serializers, permissions, and patterns.
- Avoid unnecessary abstractions or refactoring.
- Run targeted backend tests first.

## Multi-Tenancy
- Every tenant-owned query must remain tenant-scoped.
- Never bypass PostgreSQL Row Level Security.
- Never weaken fail-closed tenant managers.
- Never trust organization/tenant IDs supplied by the client.
- Preserve cross-tenant isolation.

## Security
- Enforce authentication and authorization server-side.
- Validate all API input.
- Never expose secrets, credentials, or sensitive internal data.
- Preserve audit logging for security-sensitive actions.
- Avoid raw SQL unless necessary and reviewed.
- Prevent insecure mass assignment and IDOR-style access.

## Database
- Keep migrations safe and reversible where practical.
- Avoid unnecessary schema changes.
- Preserve indexes and constraints.
- Use transactions for multi-step operations requiring atomicity.
- Prevent N+1 queries where relevant.

## API
- Follow existing DRF conventions.
- Keep API behavior backward compatible unless explicitly changing it.
- Use existing permission classes and pagination/filtering patterns.
- Return consistent error responses.

## Celery
- Use background jobs only for genuinely asynchronous/heavy work.
- Tasks should be idempotent where practical.
- Do not duplicate existing task infrastructure.

## Testing
Order:
1. Specific affected test
2. Relevant Django app tests
3. Broader backend tests only when needed

Before finishing, verify:
- tenant isolation
- permissions
- validation
- affected tests

## Output
Report only:
1. Changed
2. Files modified
3. Tests/results
4. Important risk