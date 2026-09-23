# Keel CRM on one EC2 host

The low-cost production target: one Graviton instance running the whole stack with Docker Compose.
The ECS/Fargate design in `infra/terraform` (~USD 600/month) remains the scale-out path; nothing here
uses it.

```
Internet --443--> Caddy (Let's Encrypt) --> web  (Next.js standalone)
                                      \--> api  (gunicorn, /api /_allauth /health /ready)
          api, worker-critical (default, notifications), worker-heavy (imports, exports, reports,
          rag_indexing, integrations), beat (exactly one) --> postgres 16 + pgvector, redis 7
```

Only Caddy publishes ports (80 for the ACME challenge and the HTTPS redirect, 443). PostgreSQL and
Redis listen on a private Docker network. The app connects to PostgreSQL as `crm_app` (no DDL, no RLS
bypass) over TLS with `verify-full`; migrations run as `crm_migrator`, whose URL only the one-off
`migrate` container receives.

## Files

| Path | Purpose |
|---|---|
| `compose.yml` | the stack; sizing for a 2 GiB host |
| `Caddyfile` | HTTPS, path split, HSTS for Next.js pages |
| `postgres/init-keel.sh` | first-boot roles, database, pgvector |
| `bin/keel-deploy` | render config from SSM, migrate, start, health-check (`--restart` at boot) |
| `bin/keel-update` | check out a commit and deploy its images (what CI runs) |
| `bin/keel-backup` + `systemd/` | daily `pg_dump` + private files, 7-day retention |
| `user-data.sh` | one-time bootstrap: Docker, Compose (checksum-pinned), swap, scripts |
| `ssm/KeelCrm-Update.json` | the only SSM document the CI role may run (`keel-update <sha>`) |
| `iam/*.json` | instance role, operator policy, GitHub OIDC role (fill in `<ACCOUNT_ID>`, `<REGION>`) |

## Configuration (SSM Parameter Store, `/keel/production/`, Standard tier)

Generated on the host on first deploy (SecureString, never overwritten, never printed):
`SECRET_KEY`, `MESSAGING_ENCRYPTION_KEYS`, `POSTGRES_PASSWORD`, `CRM_MIGRATOR_PASSWORD`,
`CRM_APP_PASSWORD`, `REDIS_PASSWORD`.

Optional, set by an operator:

| Name | Type | Effect when absent |
|---|---|---|
| `EMAIL_URL` | SecureString | emails go to the worker log only: **sign-up verification cannot complete** |
| `DEFAULT_FROM_EMAIL` | String | `no-reply@keel.local` |
| `ANTHROPIC_API_KEY` | SecureString | Ask Keel answers from CRM data and retrieval only |
| `SITE_HOST` | String | `<public-ip-with-dashes>.sslip.io` |
| `SECURE_HSTS_SECONDS` | String | 300 (ramp to 86400, then 31536000) |
| `CADDY_GLOBAL_OPTIONS` | String | none; e.g. `email ops@example.com` enables the ZeroSSL fallback |

After changing a value run `keel-deploy --restart` (or redeploy). The database passwords are fixed at
first initialisation; rotating them needs `ALTER ROLE` as well as the parameter.

## Deploying

CI (`.github/workflows/deploy.yml`) builds arm64 images for the verified commit, scans them, pushes
`ghcr.io/workeasy360/ai-crm-{api,web}:<sha>` and runs the `KeelCrm-Update` document on the instance
tagged `Project=KeelCRM, Environment=production`. The GHCR packages must be public (the host pulls
without credentials). By hand, as root on the host: `keel-update <40-char sha>`.

Rollback: `keel-deploy "$(cat /var/lib/keel/previous)"`. Migrations are expand-only, so older code runs
against the newer schema; never reverse a migration without reviewing it.

## Backups

`keel-backup.timer` writes `/var/backups/keel/keel-<ts>.dump` (custom format, all tenants) and
`private-<ts>.tgz` daily and keeps 7 days. They share the instance's EBS volume, so they cover bad
imports and operator error, **not** the loss of the volume. For that, copy them off the host or enable
EBS snapshots (Data Lifecycle Manager). Restore, as root on the host:

```
cd /opt/keel/src/deploy/ec2
tag=$(cat /var/lib/keel/current)
export KEEL_API_IMAGE=ghcr.io/workeasy360/ai-crm-api:$tag KEEL_WEB_IMAGE=ghcr.io/workeasy360/ai-crm-web:$tag
docker compose stop api worker-critical worker-heavy beat
docker compose exec -T postgres pg_restore -U postgres -d keel --clean --if-exists < /var/backups/keel/keel-<ts>.dump
docker compose up -d --wait api
docker compose exec -T api tar -xzf - -C /app/private < /var/backups/keel/private-<ts>.tgz
docker compose up -d
```

## Limits (accepted for the low-cost tier)

* One host: an instance or AZ failure is an outage; recovery is a new instance plus a restore.
* Redis is local with AOF (`appendfsync everysec`): up to ~1 s of queued tasks can be lost on a crash;
  the beat sweepers (`rag.drain_pending`, `importexport.resume_stalled_imports`, `integrations.drain`,
  `messaging.reconcile_stuck_sends`) re-drive periodic and outbox work.
* No WAF/CDN: rate limiting is Django's (DRF throttles, allauth limits) keyed on the real client IP.
* The public IPv4 is not an Elastic IP: a stop/start changes it, and with the default `sslip.io` name
  the hostname and certificate change too (the boot unit re-renders and re-issues automatically).
* `sslip.io` is not on the Public Suffix List, so Let's Encrypt's per-domain limit is shared by all its
  users; if issuance is refused, set `CADDY_GLOBAL_OPTIONS` for ZeroSSL or use your own `SITE_HOST`.
