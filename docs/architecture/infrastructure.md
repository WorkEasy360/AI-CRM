# Infrastructure Architecture

Recommendation (ADR-0008): **AWS, single region, containers on ECS Fargate, managed data services.** Terraform for everything; no Kubernetes in the MVP. The choice of cloud and region is listed in `docs/DECISIONS-REQUIRED.md`; the design below maps 1:1 onto GCP/Azure equivalents if a different provider is chosen.

## 1. Environments

| Env | Purpose | Data | Access |
|---|---|---|---|
| `dev` (local) | docker-compose: postgres, redis, backend, worker, beat, frontend, mailpit, minio | synthetic seed | developer laptop |
| `ci` | ephemeral services in GitHub Actions | fixtures | pipeline only |
| `staging` | production-like, DAST target, restore tests | anonymised synthetic data, never production copies | team, IP-allowlisted |
| `production` | customers | real | no direct DB access; break-glass via SSM session + audit |

Separate AWS accounts (or at minimum separate VPCs and IAM boundaries) for staging and production.

## 2. Production topology

- **Edge**: Route 53 → CloudFront (optional) → ALB with AWS WAF (managed rule sets: core, known bad inputs, IP reputation, rate-based rule) → target groups for `web` (Next.js) and `api` (Django). TLS 1.2+ with ACM certificates; HSTS.
- **Compute**: ECS Fargate services: `api` (gunicorn, 2+ tasks), `web` (Next.js, 2+ tasks), `worker` (Celery, queues `default`, `imports`, `ai`, `webhooks`), `beat` (1 task, leader-only), `migrate` (one-off task run by the deploy pipeline before rollout). Containers run as non-root, read-only root filesystem, no privileged capabilities.
- **Data**: RDS PostgreSQL 16 Multi-AZ, encrypted (KMS), private subnets, `rds.force_ssl=1`, automated backups + PITR (7–35 days), performance insights; RDS Proxy or pgbouncer sidecar in transaction mode. ElastiCache Redis (TLS, AUTH, private). S3 buckets (private, SSE-KMS, versioning, lifecycle rules, block public access, bucket policies restricted to task roles).
- **Secrets**: AWS Secrets Manager + KMS; injected into tasks as environment variables at start via the ECS secrets integration; rotation for DB credentials (managed rotation) and app-managed rotation for third-party keys; app reads `SECRET_KEY` list (current + previous) to allow zero-downtime rotation of Django's signing key.
- **Network**: public subnets only for ALB/NAT; tasks and data in private subnets; security groups allow `api→db:5432`, `api→redis:6379`, nothing inbound to data tiers from the internet; egress through NAT with optional egress allowlist (LLM API, email provider, OAuth providers, package registries only during build).
- **Observability**: JSON logs → CloudWatch Logs (retention 90 days; security events forwarded to a dedicated log group with 1-year retention, exportable to a SIEM); metrics via CloudWatch + application metrics (request latency, error rates, queue depth, AI spend); alarms wired to email/Slack; error tracking (Sentry-compatible SDK with PII scrubbing) is optional and configured with `send_default_pii=False`.
- **Email**: SES (or Postmark) with SPF/DKIM/DMARC; bounce and complaint handling.

## 3. CI/CD (GitHub Actions)

Per pull request:

| Job | Tools |
|---|---|
| Backend tests | pytest with PostgreSQL + Redis services; coverage gate; tenant-isolation and authz matrix suites are mandatory jobs |
| Frontend tests | vitest, typecheck (`tsc --noEmit`), eslint, playwright smoke on PR label |
| Lint/format | ruff (lint + format), mypy (strict on `apps/core`, `authz`, `ai`; gradual elsewhere) |
| SAST | Semgrep (Django + custom rules: unscoped managers, raw SQL, `mark_safe`, `dangerouslySetInnerHTML`), Bandit, CodeQL (Python + JS) |
| Dependencies | pip-audit, `pnpm audit`, Dependabot weekly; lock files required |
| Secrets | gitleaks (pre-commit + CI) |
| Containers | Trivy on built images; fail on critical/high with fixes available |
| SBOM | CycloneDX generated for release builds and attached to the GitHub release |

Main branch: build immutable images tagged by git SHA → push to ECR → deploy to staging → run migrations → smoke tests + ZAP baseline scan → manual approval → production rolling deploy with health checks and automatic rollback. Deployment is blocked when any critical/high finding is open in the security dashboard.

## 4. Backups and disaster recovery

| Item | Target |
|---|---|
| RPO | 5 minutes (PITR) |
| RTO | 1 hour (restore to new instance + DNS/ECS switch, rehearsed) |
| Backups | automated daily snapshots + continuous WAL; cross-region snapshot copy weekly; S3 versioning + replication for attachments |
| Restore test | monthly automated restore into an isolated environment with a data-integrity check job; results recorded in `docs/operations/restore-log.md`. Backups are not called reliable until the first successful test |
| Runbooks | `docs/operations/backup-restore.md`, `docs/operations/incident-response.md` (Phase 6) |

## 5. Container hygiene

- Multi-stage builds; final images on `python:3.13-slim` / `node:22-alpine`; no build tools, no `.git`, no secrets, no `.env`.
- `USER app` (uid 10001), `HEALTHCHECK` defined, `--cap-drop ALL`.
- Pinned base image digests; renovate/dependabot for image updates.
- Trivy scan in CI and weekly on deployed images.
