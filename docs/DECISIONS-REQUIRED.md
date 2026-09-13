# Decisions Required Before Coding

Only decisions that genuinely need the product owner. Everything else has been decided in the ADRs with the safer/standard engineering choice; those can be challenged but do not block Phase 1.

| # | Decision | Recommendation | Why it needs you |
|---|---|---|---|
| D1 | **Product name and brand direction** (name, primary colour family, tone) | Placeholder codename "Keel"; neutral deep-teal/slate palette until a name exists | Brand is a business choice; it affects domain, email sender, cookie names and UI copy |
| D2 | **Cloud provider and primary region** (data residency) | AWS, `ap-south-1` (Mumbai) if your customers are primarily in India, otherwise the region closest to them; one region for MVP | Billing relationship, residency/compliance obligations and latency are yours to decide; the design ports to GCP/Azure |
| D3 | **Source hosting and CI platform** | GitHub + GitHub Actions (gives CodeQL, Dependabot, secret scanning, OIDC deploys) | Determines the CI/CD tooling assumed in `docs/architecture/infrastructure.md` |
| D4 | **LLM provider and data-handling terms** | Anthropic Claude via the official API: `claude-opus-5` for copilot/drafting, `claude-haiku-4-5` where cheaper bulk work is acceptable; sign the provider's data-processing terms; if residency requires it, route through the cloud provider's hosted offering instead (adapter supports it) | Commercial agreement, data residency and customer-facing AI disclosures are business decisions |
| D5 | **Subscription billing in scope for MVP?** | No. Model `organization.plan` and usage limits now; integrate a payment provider after Phase 6 | Affects scope and timeline materially |
| D6 | **Compliance targets** (e.g. India DPDP Act, GDPR for EU customers, SOC 2 ambition, ISO 27001) | Design for DPDP + GDPR-style rights (export, deletion, retention) from Phase 1; defer formal certification | Determines retention defaults, DPA requirements with the LLM/email providers, and logging retention |
| D7 | **Transactional email provider** | Amazon SES if AWS is chosen; Postmark otherwise | Domain ownership, DNS (SPF/DKIM/DMARC) and sender identity are yours |
| D8 | **Sign-up model** | Self-service sign-up with email verification (public SaaS) | If you intend invite-only or sales-led onboarding, the auth flows and abuse controls differ |

Decided without asking (see ADRs): modular monolith, shared-schema tenancy with RLS, cookie sessions + allauth, central RBAC, UUID ids, JSONB custom fields, optimistic concurrency, PostgreSQL search, money/currency handling, dependency policy, no Kubernetes/Kafka/Elasticsearch in MVP, Next.js self-hosted in a container on the same origin, no rich-text editor in MVP (plain text/markdown notes), single-table activities with a `kind` discriminator, calendar views built in-house on `date-fns` rather than a heavy calendar dependency.

Reply with the numbers and your choice (or "accept recommendations") and Phase 1 starts.
