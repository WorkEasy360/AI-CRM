# Keel CRM — frontend (Phase 2)

Next.js 15 (App Router) + React 19 + TypeScript strict + Tailwind CSS v4. Talks to the Django backend over same-origin cookie sessions; nothing sensitive lives in the browser bundle.

## Setup

Requirements: Node 20.19+ (CI uses 22), pnpm 10 (`corepack enable`).

```bash
cp .env.example .env.local   # optional; defaults to http://localhost:8000
pnpm install
pnpm dev                     # http://localhost:3000
```

`API_INTERNAL_ORIGIN` is read **server-side only** by `src/middleware.ts` and used as the destination of the proxy for `/api/*`, `/_allauth/*`, `/health/` and `/ready/` (middleware rather than `next.config.ts` rewrites so the trailing slash every DRF route requires survives the hop). It is never exposed to the browser; there are no `NEXT_PUBLIC_*` variables and no secrets in Phase 1.

## Scripts

| Script            | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`        | Next.js dev server proxying backend paths                                     |
| `pnpm build`      | Production build (`output: "standalone"`)                                     |
| `pnpm start`      | Serve the production build                                                    |
| `pnpm lint`       | ESLint (next/core-web-vitals + next/typescript + security rules)              |
| `pnpm typecheck`  | `tsc --noEmit`                                                                |
| `pnpm test`       | Vitest unit/component tests (jsdom)                                           |
| `pnpm test:e2e`   | Playwright smoke spec; skips itself unless `E2E_BASE_URL` is set              |
| `pnpm gen:api`    | Regenerate `src/lib/api/schema.d.ts` from `openapi.json` (commit the result)  |

The generated `schema.d.ts` is committed so builds are reproducible without the backend. Re-run `pnpm gen:api` whenever `openapi.json` changes.

## Layout

```
src/
  app/                 routes: (auth) group, (app) group with shell (settings has its own sub-layout)
  components/ui/       small typed primitives on Radix (Button, Dialog, Select, ...)
  components/shell/    app shell: side nav, top bar, org switcher, user menu, Copilot drawer
  components/settings/ organization, members, teams, security, audit-log, pipelines, custom-fields, tags, data (import/export)
  components/crm/      shared CRM layer (data table, list toolbar, custom-field form, tag picker, notes, timeline, record page)
                       + contacts/, companies/, products/, pipeline/ (kanban, list), deals/ (detail, form, stage move)
  lib/api/crm*.ts      hand-written Phase 2 types and endpoint functions (version-aware writes)
  lib/crm/             query keys, URL-backed list params, formatting, UI permission helpers
  components/auth/     login, signup, verify, reset, invitation acceptance
  lib/api/             fetch client, RFC 9457 problem parsing, allauth client, endpoints, types
  lib/                 csrf reader, next-redirect validator, session hooks, validation schemas
  styles/              tokens.css (design tokens) + globals.css (Tailwind theme mapping)
  middleware.ts        CSP nonce + security headers
tests/e2e/             Playwright smoke spec
```

## Dependencies (and why)

Runtime:

- `next` 15.5.25, `react` / `react-dom` 19.3.0 — fixed stack.
- `@radix-ui/react-{avatar,dialog,dropdown-menu,label,select,slot,switch,tabs,toast}` — accessible headless primitives; `slot` is what lets `Button asChild` wrap a `Link`.
- `@tanstack/react-query` 5.102.8 — server state, cursor pagination, invalidation after mutations.
- `react-hook-form` 7.88.0 + `zod` 4.6.2 + `@hookform/resolvers` 5.9.1 — forms and schema validation.
- `lucide-react` 1.45.0 — icons.
- `class-variance-authority`, `clsx`, `tailwind-merge` — typed component variants (`Button`, `Badge`) and safe class merging when callers pass `className`. Justification: avoids hand-rolled variant maps and last-wins Tailwind conflicts in every primitive.
- `qrcode` 1.5.4 (MIT) — used only to compute the QR bit matrix for the TOTP `otpauth://` URL; the SVG is rendered from that matrix as a React `<path>`, so no HTML strings are injected.

Dev:

- `typescript` 5.9.3, `@types/*` — types. `@types/node` is pinned to the 20.x line to match the Node baseline.
- `tailwindcss` 4.3.3 + `@tailwindcss/postcss` + `postcss` — styling.
- `eslint` 9.39.5 + `eslint-config-next` 15.5.25 + `@eslint/eslintrc` 3.3.7 — `eslint-config-next` 15 ships legacy (eslintrc-style) configs; `@eslint/eslintrc`'s `FlatCompat` bridges them into the flat config, exactly as Next's own template does.
- `vitest` 4.1.11 + `vite` 7.3.6 + `@vitejs/plugin-react` + `jsdom` + `@testing-library/{react,jest-dom,user-event}` — unit and component tests. Vitest 5 requires Node 22, so 4.x is pinned to keep Node 20 working. `vite` is pinned explicitly so the test transform is reproducible.
- `@playwright/test` 1.63.0 — e2e smoke spec (browsers are not installed in CI).
- `openapi-typescript` 7.13.0 — schema generation.

Everything is pinned to exact versions; `pnpm-lock.yaml` is committed. `.npmrc` sets `node-linker=hoisted` so Next's standalone file tracing does not need to recreate symlinks (which Windows forbids without elevated privileges); it changes nothing about resolution on Linux.

## Backend contract

- Every request goes through `src/lib/api/client.ts`: `credentials: "include"`, `Accept: application/json`, and `X-CSRFToken` on unsafe methods read from `__Host-keel_csrftoken` (prod) or `keel_csrftoken` (dev) — whichever exists.
- `GET /api/v1/session/` is mounted first on every page tree (auth pages via `CsrfBootstrap`, app pages via `AuthGate`) so the CSRF cookie is set before any POST.
- Errors are RFC 9457 problem details, normalised by `parseProblem` (allauth's `{status, errors[]}` envelope and DRF `{detail}` bodies are mapped to the same shape). `ApiError` exposes `isReauthRequired`, `isNotAuthenticated`, `fieldErrors()`.
- `reauth_required` (403) — any mutation wrapped in `useReauth().runSensitive(...)` opens a password dialog, calls `POST /_allauth/browser/v1/auth/reauthenticate`, then retries the original call once. allauth's own "401 + pending `reauthenticate` flow" is mapped to the same problem type.
- `not_authenticated` (401/403) — inside the app shell a handler redirects to `/login?next=<path>`; the auth pages register no handler so they can probe the session freely.
- The `next` parameter is only honoured when `isSafeNextPath` accepts it: a string starting with exactly one `/`, no `//`, no backslashes, no whitespace/control characters, no scheme, no encoded leading slashes; auth routes are never used as a target.

## Security notes

- **CSP** (`src/middleware.ts`): per-request nonce; `script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `connect-src 'self'`, `img-src 'self' data: blob:`. `style-src` keeps `'unsafe-inline'` because Next.js/Tailwind inject inline `<style>` and Radix positions popovers with inline `style` attributes. `'unsafe-eval'` is added to `script-src` **only when `NODE_ENV !== "production"`** (React Refresh / dev source maps); production builds never include it. Also sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`. The middleware does not run on the proxied backend paths.
- No `dangerouslySetInnerHTML`, no `eval`, no rendering of untrusted HTML (enforced by ESLint rules `react/no-danger`, `no-eval`, `no-implied-eval`, `no-new-func`). Audit-log metadata is shown via `JSON.stringify` inside a `<pre>`.
- No tokens in `localStorage`/`sessionStorage`; auth is entirely cookie-based and handled by the backend.
- `next.config.ts`: `poweredByHeader: false`, `reactStrictMode: true`, `output: "standalone"`.
- Permissions from `session.active.permissions` only gate UI affordances; the backend enforces everything.
- Fonts: system font stack only (no third-party font requests).

### Client-side session gating (known limitation)

Protected routes are gated **client-side** in `src/components/auth-gate.tsx`. The Django session cookie is only visible to the browser and to Django behind the same-origin rewrite; the Next.js server never sees it, so it cannot verify the session during server rendering. The `(app)` layout therefore renders a skeleton until `GET /api/v1/session/` resolves, then redirects to `/login?next=…` (unauthenticated) or calls `POST /api/v1/session/bootstrap/` (no active organisation: the server creates the personal workspace and activates a membership, so there is no onboarding wizard). True server-side gating arrives with the shared-origin reverse proxy in staging, when Next.js route handlers/middleware can forward the cookie to the backend.

## Docker

```bash
docker build -t keel-frontend .
docker run -p 3000:3000 -e API_INTERNAL_ORIGIN=http://backend:8000 keel-frontend
```

Multi-stage on `node:22-alpine`, standalone output, non-root user (uid 10001), `HEALTHCHECK` against `/login`. `API_INTERNAL_ORIGIN` is read by the middleware at runtime, so it can be set on the container (as `docker-compose.yml` does); in staging the reverse proxy routes `/api` and `/_allauth` directly and the middleware proxy is not exercised.

## Tests

- `src/lib/csrf.test.ts` — cookie reader (dev/prod cookie names, precedence, decoding).
- `src/lib/safe-next.test.ts` — redirect validator (open-redirect cases).
- `src/lib/api/problem.test.ts` — problem-details parser and `ApiError` classification.
- `src/components/settings/invite-member-dialog.test.tsx` — invite dialog zod validation with the API mocked.
- `tests/e2e/smoke.spec.ts` — production hydration under the CSP nonce (no backend needed; CI runs it against the standalone server), signup up to "check your email", security headers.
- `tests/e2e/sales-workflow.spec.ts` — the critical business workflow through the browser: login, pipeline, company, contact, deal, stage move, task, meeting, call, email (sandbox OAuth), WhatsApp (connect, template, signed inbound webhook, free text), AI summary / follow-up / risk, closed won, dashboard and forecast.
- `tests/e2e/browser-behaviour.spec.ts` — server-side session revocation, MFA enrolment and login, permission denial (UI + API), concurrent deal edits, loading/error states, phone and tablet layouts, keyboard-only operation.

Running the browser suites needs a live stack with sandbox providers:

```sh
# backend (from ./backend): fake email/WhatsApp/AI providers; the port must differ from any dev server you keep running
MESSAGING_PROVIDER_BACKEND=fake AI_PROVIDER_BACKEND=fake WHATSAPP_APP_SECRET=e2e-app-secret WHATSAPP_VERIFY_TOKEN=e2e-verify FRONTEND_ORIGIN=http://localhost:3100 CSRF_TRUSTED_ORIGINS=http://localhost:3100,http://localhost:8001 uv run python manage.py runserver 8001 --noreload
uv run celery -A config.celery worker -l info -Q default,notifications --pool=solo   # sends run on the worker
uv run python manage.py seed_e2e --out ../frontend/test-results/e2e-users.json     # fresh org + owner/viewer/rep/mfa users

# frontend (from ./frontend): production build served by the standalone server
NEXT_DIST_DIR=.next-build pnpm build
cp -r .next-build/static .next-build/standalone/.next-build/static && cp -r public .next-build/standalone/public
(cd .next-build/standalone && API_INTERNAL_ORIGIN=http://localhost:8001 HOSTNAME=localhost PORT=3100 node server.js)

E2E_BASE_URL=http://localhost:3100 E2E_USERS_FILE=test-results/e2e-users.json E2E_WHATSAPP_APP_SECRET=e2e-app-secret pnpm test:e2e
```

`next start` refuses `output: standalone`; run `server.js`. The dev server also works as a target (it renders dynamically), but only the production build proves the CSP nonce contract, which is why the smoke spec runs against it in CI.
