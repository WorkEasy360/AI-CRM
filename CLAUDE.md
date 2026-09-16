# Keel CRM — Global Claude Rules

## Goal
Complete tasks correctly with the minimum necessary context, tokens, tool calls, and repository exploration.

## Project Architecture
- Backend: Django + DRF
- Database: PostgreSQL
- Background jobs: Celery + Redis
- Frontend: Next.js + React + TypeScript
- Architecture: modular monolith
- Multi-tenancy: PostgreSQL RLS + fail-closed tenant managers

## Context Efficiency
- Never read the entire repository by default.
- Search first, then open only relevant files.
- Do not reread files already understood unless necessary.
- Do not inspect unrelated modules.
- Start with `git status`, `git diff`, search, and affected files.
- Use folder-specific `CLAUDE.md` instructions when available.

## Scope
- Modify only what the task requires.
- Do not perform unrelated refactors.
- Reuse existing architecture, services, components, and patterns.
- Do not add unnecessary dependencies.
- Do not create unnecessary documentation or files.

## Security — Mandatory
Never weaken:
- tenant isolation
- PostgreSQL RLS
- authentication
- authorization
- audit logging
- secret management
- input validation

Never trust tenant/org IDs supplied by the client.

## Reasoning
Use normal reasoning for:
- CRUD
- UI changes
- standard APIs
- tests
- small bugs

Use deeper reasoning only for:
- architecture
- security
- RLS / tenant isolation
- authentication / authorization
- complex production bugs
- major refactoring

## Testing
Run tests in this order:

1. affected test
2. affected module/app tests
3. wider suite only when necessary
4. full gates before major merge/release

Do not run the entire test suite after every minor change.

## Subagents
Do not use subagents for:
- simple bugs
- single-feature work
- CRUD
- minor UI work
- basic tests

Use them only when independent complex work genuinely benefits from parallel execution.

## Output
Keep responses short.

After implementation report only:

1. Changed
2. Files modified
3. Tests/results
4. Important risk or follow-up

## Rule
Correctness and security take priority over token reduction.