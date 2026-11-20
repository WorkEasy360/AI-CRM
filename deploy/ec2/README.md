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
| `terraform/` | the private ECR repository of the API image, its push and pull policies, `API_IMAGE_REPOSITORY` ([Private API image](#private-api-image-ecr)) |

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

Written by `terraform/` (not by hand): `API_IMAGE_REPOSITORY` (String), the private ECR repository of the API
image. Without it a deploy stops before touching the running stack.

After changing a value run `keel-deploy --restart` (or redeploy). The database passwords are fixed at
first initialisation; rotating them needs `ALTER ROLE` as well as the parameter.

## Deploying

CI (`.github/workflows/deploy.yml`) builds arm64 images for the verified commit and scans them. It pushes the
API image to the private ECR repository (`<account>.dkr.ecr.<region>.amazonaws.com/workeasy360/ai-crm-api:<sha>`)
with the deploy role, and the web image to `ghcr.io/workeasy360/ai-crm-web:<sha>`. Then it runs the
`KeelCrm-Update` document on the instance tagged `Project=KeelCRM, Environment=production`. The host pulls the API
image with its instance role and the web image anonymously, so the GHCR web package must stay public. By hand, as
root on the host: `keel-update <40-char sha>`. Each deploy records the two image references in
`/var/lib/keel/images.env`, which a restart (boot) and `keel-backup` use.

Rollback: `keel-deploy "$(cat /var/lib/keel/previous)"`. Migrations are expand-only, so older code runs
against the newer schema; never reverse a migration without reviewing it. For a release from before the API
image moved to ECR, see [Private API image](#private-api-image-ecr).

## Private API image (ECR)

The API image contains WorkEasy360's private sign-in connector (`docs/workeasy360-sso.md`), so it is never pushed
to a public registry. `terraform/` adds, with no stored credential anywhere:

| Resource | What it allows |
|---|---|
| ECR repository `workeasy360/ai-crm-api` | immutable tags (the commit SHA names one image forever), scan on push, KMS encryption (the AWS-managed `aws/ecr` key, or `kms_key_arn`), lifecycle: untagged images expire after a day, the last 30 images are kept |
| inline policy `KeelCrmApiImagePush` on the deploy role | `ecr:GetAuthorizationToken`, and describe and push on this repository only |
| inline policy `KeelCrmApiImagePull` on `KeelCrmEc2Role` | `ecr:GetAuthorizationToken`, and pull on this repository only |
| SSM parameter `/keel/production/API_IMAGE_REPOSITORY` | the repository URL `keel-deploy` pulls from; it refuses one outside the instance's own account and region |

The repository has no repository policy, so no other account and no anonymous caller can reach it. CI reaches it
through the deploy role (GitHub OIDC; the images job runs in the `production` environment, which the role
trusts). The host reaches it through its instance role: `keel-deploy` logs in with a 12-hour ECR token kept in a
private tmpfs directory, which it deletes after pulling.

### Applying it, in this order

Run these with AWS administrator access. The operator policy `KeelCrmDeployer` cannot create repositories or IAM
policies. Prerequisites: the deploy role and `KeelCrmEc2Role` exist (`iam/*.json`).

1. **Plan and apply** (Terraform 1.6 or later). The state holds no secret values; keep `terraform.tfstate`, or use
   the S3 backend in `backend.tf`.

   ```bash
   cd deploy/ec2/terraform
   terraform init
   terraform plan -var aws_region=<REGION> -out registry.tfplan
   terraform apply registry.tfplan
   ```

   If the deploy role is not named `KeelCrmGithubDeploy`, add `-var deploy_role_name=<the last part of
   AWS_DEPLOY_ROLE_ARN>`. The plan must add 5 resources (repository, lifecycle policy, two role policies, one
   parameter) and change or destroy nothing.
2. **Seed the release now running (recommended).** Copy it into ECR, so the first rollback after the move works
   from ECR too. On the host, `cat /var/lib/keel/current` gives the SHA. On a workstation with Docker:

   ```bash
   registry=$(terraform output -raw registry)
   aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin "$registry"
   docker pull --platform linux/arm64 ghcr.io/workeasy360/ai-crm-api:<sha>
   docker tag ghcr.io/workeasy360/ai-crm-api:<sha> "$registry/workeasy360/ai-crm-api:<sha>"
   docker push "$registry/workeasy360/ai-crm-api:<sha>"
   docker logout "$registry"
   ```

   Those older images contain no connector code.
3. **GitHub variables.** `AWS_DEPLOY_ROLE_ARN` and `AWS_REGION` (the same region) must be set:
   `gh variable set AWS_REGION -R WorkEasy360/AI-CRM --body <REGION>`, and likewise for the role ARN. Until
   `AWS_DEPLOY_ROLE_ARN` exists, the images job builds and scans the API image and publishes it nowhere. If you
   add required reviewers to the `production` environment, both the images and the deploy job wait for approval.
4. **First deploy.** Merge to `main`, or run the workflow from `main`:
   `gh workflow run deploy.yml -R WorkEasy360/AI-CRM --ref main`. Check that the images job pushed
   `…/workeasy360/ai-crm-api:<sha>`, that the deploy job's SSM output ends with `healthy`, and that
   `aws ecr describe-images --repository-name workeasy360/ai-crm-api` lists the tag with a scan result.
5. **Retire the public GHCR API package** (GitHub UI, after step 4 works): open
   <https://github.com/WorkEasy360?tab=packages>, then `ai-crm-api` → **Package settings** → **Danger Zone** →
   **Change visibility** → **Private**, or **Delete this package**. Leave `ai-crm-web` public: the host pulls it
   without credentials. Its 16 tags were all built from `main` before the connector arrived (checked 2026-11-18).
   Keep it public a little longer only if you may need the rollback below without having done step 2.

### Rollback

* **A release after the move:** `keel-deploy "$(cat /var/lib/keel/previous)"`, as before. Its API image is in ECR
  (immutable, the last 30 kept).
* **A release from before the move:** if it was seeded (step 2), as above. Otherwise `keel-update <sha>`: it checks
  out that commit, whose scripts pull both images from GHCR. That only works while the GHCR API package is public.
* **A first deploy that fails** (for example a missing policy or parameter): `keel-deploy` stops at the login or the
  pull, before it touches the running stack, and the previous release keeps serving. A restart (boot) keeps
  starting that release, from the images it was started with. Fix the cause and deploy again.
* **The infrastructure:** there is no safe way back to a public API image once it contains the connector.
  `terraform destroy` removes the two policies and the parameter, and the repository only if it is empty
  (`force_delete = false`). Do it only when no release needs the repository.

## Backups

`keel-backup.timer` writes `/var/backups/keel/keel-<ts>.dump` (custom format, all tenants) and
`private-<ts>.tgz` daily and keeps 7 days. They share the instance's EBS volume, so they cover bad
imports and operator error, **not** the loss of the volume. For that, copy them off the host or enable
EBS snapshots (Data Lifecycle Manager). Restore, as root on the host:

```
cd /opt/keel/src/deploy/ec2
set -a; . /var/lib/keel/images.env; set +a     # KEEL_API_IMAGE and KEEL_WEB_IMAGE of the current release
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
