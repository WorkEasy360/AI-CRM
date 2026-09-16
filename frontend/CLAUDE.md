# Frontend Rules

## Scope
Apply these rules only to frontend work.

## Stack
- Next.js
- React
- TypeScript

## Efficiency
- Read only files relevant to the requested UI task.
- Search before opening large files.
- Do not inspect unrelated pages/components.
- Reuse existing components, hooks, utilities, and design patterns.
- Avoid unnecessary refactoring.
- Keep dependencies minimal.
- Do not add a new package if the existing stack can solve the task.

## Architecture
- Follow existing Next.js routing and folder structure.
- Prefer existing shared components.
- Keep business logic out of presentation components where practical.
- Keep API calls consistent with existing frontend patterns.
- Avoid duplicated state and duplicated utilities.

## TypeScript
- Keep strict typing.
- Avoid `any` unless unavoidable and justified.
- Reuse existing types/interfaces.
- Do not duplicate backend response types unnecessarily.

## UI/UX
- Keep UI professional, responsive, and consistent.
- Reuse existing spacing, typography, tables, forms, and modal patterns.
- Do not redesign unrelated screens.
- Preserve accessibility.
- Keep loading, empty, error, and success states consistent.

## Security
- Never rely on frontend checks for authorization.
- Never expose secrets or private credentials to the browser.
- Treat all client input as untrusted.
- Do not weaken authentication/session handling.
- Avoid rendering unsanitized user-controlled HTML.

## Performance
- Avoid unnecessary re-renders.
- Avoid fetching the same data repeatedly.
- Use existing caching/data-fetching patterns.
- Lazy-load heavy components only when useful.
- Avoid unnecessary client components.

## Testing
Order:
1. Specific affected component/test
2. Relevant feature tests
3. Full frontend suite only when needed

Before finishing verify:
- TypeScript
- lint
- affected tests
- responsive behavior
- loading/error states

## Output
Report only:
1. Changed
2. Files modified
3. Tests/results
4. Important risk