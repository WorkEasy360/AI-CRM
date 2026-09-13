# Threat Model

Living document. Updated at every phase gate. Method: asset inventory → actors → trust boundaries → STRIDE per component → ranked threat register with controls and the phase in which each control lands.

## 1. Assets

| Asset | Sensitivity | Notes |
|---|---|---|
| Customer CRM data (contacts, companies, deals, notes, activities, attachments, custom fields) | High (PII + commercial) | tenant-owned; the core thing attackers want |
| User credentials, MFA secrets, recovery codes, session ids | Critical | compromise = account takeover |
| Integration credentials (OAuth refresh tokens, SMTP secrets, webhook secrets) | Critical | envelope-encrypted; abuse reaches third-party systems |
| Audit log | High (integrity) | evidence for incidents; must be tamper-resistant |
| AI conversations, proposals, scores | High | contain summaries of CRM data |
| Infrastructure secrets (DB creds, `SECRET_KEY`, LLM API key, cloud keys) | Critical | never in code, prompts or logs |
| Availability of the service | High | SaaS revenue and customer operations depend on it |
| LLM spend | Medium | cost abuse is a direct financial loss |
| Source code and CI pipeline | High | supply chain path to production |

## 2. Actors

| Actor | Capability | Motivation |
|---|---|---|
| Anonymous internet attacker | scanning, credential stuffing, injection, DoS | data theft, extortion, spam |
| Malicious or compromised tenant user (Viewer/Rep) | authenticated API access within one org | escalate privileges, exfiltrate, sabotage |
| Malicious tenant Admin/Owner | full control of own org | attack other tenants, abuse AI/email/webhooks, cost abuse |
| Cross-tenant attacker (any account, possibly free trial) | probes ids, filters, search, exports, AI tools | read/modify other organizations' data |
| Insider (developer/operator) | code, CI, infrastructure, support tooling | accidental exposure or deliberate misuse |
| Third-party content author (email sender, website, CSV supplier) | controls text that ends up in CRM records | indirect prompt injection, XSS, formula injection |
| Compromised dependency / build system | code execution in CI or runtime | supply-chain compromise |
| LLM provider | sees permitted prompts | data handling risk (contractual, not adversarial) |

## 3. Trust boundaries

1. Internet ↔ edge (WAF/ALB/proxy)
2. Proxy ↔ Next.js (untrusted rendering of user data; no secrets)
3. Proxy ↔ Django API (authentication and authorization boundary)
4. API ↔ database (RLS boundary; app role vs migrator role)
5. API/worker ↔ object storage (signed URLs; private buckets)
6. API/worker ↔ LLM provider (data minimisation; untrusted output)
7. CRM records ↔ AI context (untrusted content boundary inside the prompt)
8. Worker ↔ third-party APIs and webhooks (SSRF/egress boundary; signature verification)
9. Developer/CI ↔ production (deployment and secrets boundary)
10. Tenant ↔ tenant (the most important logical boundary; enforced at 3 and 4)

## 4. STRIDE by component

| Component | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| Auth endpoints | credential stuffing, session fixation, phishing of reset links | tampering with reset/invite tokens | login without audit | user enumeration, timing leaks | login floods | MFA bypass, reauth bypass |
| Session/tenant middleware | cookie theft, forged membership id | modifying `active_membership_id` | actions without actor | leaking org via errors | session table exhaustion | switching to an org without membership |
| CRM APIs | acting as another owner | mass assignment of `owner_id`/`organization_id`, version races | unaudited deletes/exports | IDOR/BOLA across tenants, over-broad `expand`, verbose errors | unbounded queries, huge bulk ops | Rep performing Admin actions |
| Custom fields | – | injecting keys that shadow real fields | – | JSONB filter leaks via operators | expression-index abuse, huge payloads | validation bypass through custom fields |
| Search | – | – | – | returning rows outside scope, tsquery tricks | expensive queries | – |
| Import/Export | – | CSV formula injection, tampered mapping | unaudited export | exporting beyond scope; leaking files via URLs | huge files, zip bombs, slow parsers | path traversal in filenames |
| Attachments | – | content-type spoofing | – | public/guessable URLs | large uploads | malware distribution, stored XSS via SVG/HTML |
| Dashboards/reports | – | – | – | aggregates that leak other owners'/tenants' data | expensive aggregations on every request | – |
| Activities/calendar/notifications | – | reminder tampering | – | notifications revealing records to wrong recipient | reminder floods | acting on others' activities |
| AI copilot | impersonation via prompt ("as admin…") | model output altering records without confirmation | unlogged AI actions | cross-tenant retrieval through tools, system prompt/secret leakage, over-sharing with provider | token/cost exhaustion | excessive agency (executing actions), tool abuse |
| AI scoring/forecast | – | poisoned training data (per-org), tampered model artefacts | – | model inversion (low risk) | expensive recompute | misleading labels ("AI" without evidence) |
| Integrations/webhooks | forged inbound webhooks | replayed/modified payloads | unlogged deliveries | credential exposure, SSRF to metadata endpoints | delivery storms | using an integration to reach internal network |
| Background jobs | – | task args tampering (broker access) | – | tasks running without tenant context | queue floods | jobs escalating beyond requester permissions |
| Frontend | fake login pages (phishing) | DOM manipulation | – | secrets in bundle, XSS, open redirect | – | relying on hidden buttons |
| Infrastructure/CI | stolen deploy creds | image tampering, dependency confusion | – | secrets in logs/env dumps, public buckets | resource exhaustion | container escape, over-privileged IAM |
| Audit log | – | editing/deleting evidence | denying actions | logging secrets | log flood | – |

## 5. Ranked threat register

Severity = likelihood × impact (Critical/High/Medium/Low). Each threat lists its primary controls and the phase in which they are delivered. Phases may not advance with an open Critical/High that lacks its listed control.

| # | Threat | Sev | Primary controls | Phase |
|---|---|---|---|---|
| T1 | Cross-tenant data access via API (IDOR/BOLA, FK smuggling, filters, expand) | Critical | tenant context from session only; scoped managers; RLS; 404 semantics; router-generated cross-tenant tests | 1 (framework), every phase (tests) |
| T2 | Cross-tenant leak via AI tools or context | Critical | tools receive `Actor`, no org args; `authz.scope()` in every handler; ids validated through scoped managers; red-team suite | 4 |
| T3 | Privilege escalation inside a tenant (Rep→Admin, self role change, owner injection, last-owner removal) | Critical | central `authz.check`; role invariants in services; explicit serializer fields; matrix tests | 1 |
| T4 | Account takeover (credential stuffing, weak passwords, session fixation, reset abuse) | Critical | Argon2id, rate limits + lockout, MFA, `cycle_key()` on auth events, hashed single-use tokens, generic responses, suspicious-login alerts | 1 |
| T5 | Excessive AI agency (model output mutating data, sending mail, exporting) | High | proposals + human confirmation through normal API; no write tools; idempotency; audit | 4 |
| T6 | Prompt injection (direct and indirect via notes/imports/emails/websites) | High | delimiting + escaping, untrusted labels, heuristics + pre-summarisation, output validation, no privileged actions, canary | 4 |
| T7 | Sensitive data over-sharing with LLM provider | High | data minimisation per feature, no attachments by default, provider DPA, per-feature model config, logging without payloads | 4 |
| T8 | Mass assignment (`organization_id`, `owner_id`, `role`, `version`, `status`) | High | explicit `fields`/`read_only_fields`; service signatures accept only allowlisted data; tests | 1–2 |
| T9 | CSRF on state-changing endpoints | High | Django CSRF + DRF SessionAuthentication; `SameSite=Lax`; `__Host-` cookie; tests | 1 |
| T10 | XSS via CRM data (names, notes, custom fields, attachments, AI output) | High | React escaping, no raw HTML, CSP without `unsafe-inline` for scripts, attachments served with `Content-Disposition: attachment` + nosniff from a separate origin, markdown sanitiser | 1 (CSP), 2, 4 |
| T11 | Unauthorised bulk export / data exfiltration | High | `*.export` permission, recent-auth, async job, audit + alert on large exports, signed URL TTL, row caps | 2 |
| T12 | CSV formula injection on export; malicious import content | High | neutralise cells starting with `= + - @ \t \r`; imports validated per row via serializers; size/row caps; no formulas evaluated | 2 |
| T13 | File upload attacks (malware, SVG/HTML XSS, spoofed MIME, path traversal, size) | High | extension + magic-byte allowlist; random storage keys; private bucket; signed URLs; size limits; AV scan hook; never trust filenames | 2 |
| T14 | SSRF via webhook URLs, website fields, calendar/mail integrations | High | URL validator (scheme, host, DNS resolution against private/link-local/metadata ranges, re-check at request time), egress allowlist, no redirects followed blindly | 2 (validator), 5 |
| T15 | Webhook forgery/replay | High | HMAC signatures with timestamp, 5-min tolerance, replay table, idempotency, per-endpoint throttles | 5 |
| T16 | Audit log tampering or secret leakage into logs | High | append-only role grants, redaction denylist, structured logging with field allowlist, log integrity via write-once log sink | 1 |
| T17 | Secret leakage (repo, images, prompts, error pages, frontend bundle) | High | gitleaks pre-commit + CI, secrets manager, no `.env` in images, `DEBUG=False`, prompts built from templates without secrets, `NEXT_PUBLIC_` review | 1 |
| T18 | Dependency/supply-chain compromise | High | lock files, pip-audit/pnpm audit, Dependabot, Trivy, SBOM, pinned actions by SHA, package review checklist in ADR-0010 | 1 |
| T19 | Resource exhaustion (unbounded queries, exports, imports, AI tokens, login floods) | Medium–High | pagination caps, async jobs with caps, throttles, budgets, WAF rate rules, statement timeouts, Celery time limits | 1–4 |
| T20 | Background job runs without tenant context or with escalated rights | High | `tenant_context()` mandatory; tasks carry actor; scope re-applied; test | 1 |
| T21 | Integration credential theft | High | envelope encryption with KMS, decrypt only in worker memory, never serialised, rotation, audit | 5 |
| T22 | Session revocation gaps (disabled user keeps working) | Medium | `user_session` revocation check per request with short cache and immediate invalidation | 1 |
| T23 | Clickjacking / MIME sniffing / referrer leaks | Medium | `frame-ancestors 'none'`, nosniff, `Referrer-Policy: strict-origin-when-cross-origin` | 1 |
| T24 | Open redirect after login/OAuth | Medium | `next` validated as same-origin relative path; OAuth state + PKCE | 1, 5 |
| T25 | Misleading AI claims (fake predictions, unverified accuracy) | Medium (trust/legal) | registry-gated labels; metrics required; UI copy reviewed | 4 |
| T26 | Data poisoning of per-org predictive models | Medium | per-org training only, outlier checks, model approval step, fallback to rules on drift | 4 |
| T27 | Insider misuse of support tooling / unscoped access | Medium | `all_objects` audited with reason, break-glass procedure, production access logging | 1, 6 |
| T28 | Backup/restore failure or backup exposure | Medium | encrypted managed backups, restore drills, restricted access | 6 |
| T29 | Privacy obligations unmet (deletion, export, retention) | Medium | privacy app, retention jobs, tenant deletion workflow | 1 (design), 6 |
| T30 | Enumeration of users/orgs via signup/invite/reset responses | Low–Medium | generic responses, uniform timing, throttles | 1 |
| T31 | Stale sessions survive a privilege change (role change, disable) because only tracked session rows are purged | High | per-user `session_salt` folded into Django's session auth hash; rotating it invalidates every session at the next request, independent of session tracking | 1 (found and fixed during implementation) |
| T32 | Identity-level RLS policies (a user may read their own memberships/organizations before a tenant is bound) widen the "no context" state | Medium | the identity context carries only `app.current_user`; tenant tables stay invisible; nested tenant contexts restore the identity context on exit; raw-SQL tests cover the no-context and identity-only states | 1 |
| T33 | Transaction-local RLS settings leaking between requests under connection pooling, or a login signal leaving `app.current_user` set | Medium | settings are applied with `set_config(..., is_local=true)` inside the per-request transaction and explicitly restored in a `finally` block; safe with transaction-mode pgbouncer | 1 |
| T34 | `system_context()` is an in-process bypass of RLS: a code path that binds it without need widens the blast radius of an application bug | Medium | usage requires a reason string, is logged, is confined by a Semgrep rule to reviewed modules, and `all_objects` refuses to run outside it; RLS remains a control against missing filters, not against compromised application code (documented limitation) | 1 |
| T35 | Organization-wide MFA policy reported to the UI but not enforced by the API | Medium | `RequirePermissions` refuses tenant routes with `mfa_required` until the user enrols; session and auth endpoints stay reachable for enrolment (test covered) | 1 (found and fixed) |
| T36 | Concurrent stage moves on the same deal apply twice or interleave (lost update / double history) | High | `SELECT … FOR UPDATE` on the deal row alone (joining the stage row let PostgreSQL's re-check after a concurrent update drop the row: found by the race test and fixed), version compared under the lock, `UPDATE … WHERE version = ?`, history + audit in the same transaction; threaded race test asserts exactly one winner | 2 (found and fixed) |
| T37 | Custom-field keys or values used as an authorization or validation bypass (shadowing built-in fields, JSONB operator smuggling, oversized payloads, type confusion) | High | keys validated against `^[a-z][a-z0-9_]{0,39}$` and a per-entity reserved-name list; values coerced per declared type through one service; unknown keys rejected (never dropped silently); filters only on active definitions; 64 KB payload cap; `custom_data` never accepted raw by serializers | 2 |
| T38 | CSV import used to plant formulas, oversized files, binary content or rows that bypass API validation | High | extension/size/NUL/UTF-8/row/column/cell caps before storage; server-generated storage keys; every row goes through the same write serializer and record service as the API (owner = requester); export neutralises `= + - @ 	  |` cells; processing is a background task rebuilt from the requester's membership | 2 |
| T39 | Export or search widening scope (a user obtaining rows they cannot open directly) | High | exports re-apply `authz.scope()` and the module `FilterSet` inside the task with the requester's actor, are requester-only to download, audited and expire; search runs each entity through `authz.scope()` with parameterised `websearch_to_tsquery` | 2 |

## 6. Residual risks and assumptions

- The LLM provider is trusted to honour its data-processing agreement; we minimise what it receives but cannot technically prevent provider-side misuse.
- WAF and rate limits reduce but do not eliminate volumetric DoS; hosting-provider DDoS protection is relied upon.
- Per-tenant database isolation is not provided in the MVP; RLS + application scoping is the accepted control for the target market (small/medium businesses). Enterprise tenants needing physical isolation are a future routing feature.
- Malware scanning of attachments is a hook; the scanning engine is selected in Phase 2 (ClamAV container or a managed scanning service).

## 7. Attack scenarios to automate (security regression suite)

User A → User B record; Org A → Org B record (list, detail, update, delete, export, search, AI tool); `organization_id`/`owner_id`/`role` in payload; sequential/guessed ids; Viewer calling admin routes; Rep confirming AI action on another's deal; malicious HTML in every text field; SQL payloads in filters/search; CSRF without header; oversized upload; filename `../../etc/passwd`; SVG with script; CSV cell `=HYPERLINK(...)`; webhook URL `http://169.254.169.254/`; login burst; prompt injection in note, CSV cell and company website; canary leakage; stale-version confirm; expired proposal confirm.
