# Keel CRM - production infrastructure (Terraform)

Root module for the AWS production stack described in
[ADR-0008](../../docs/adr/ADR-0008-infrastructure-aws-ecs.md) and
[docs/architecture/infrastructure.md](../../docs/architecture/infrastructure.md).

```
Route 53 -> CloudFront (+WAF) -> ALB -> ECS Fargate (api, web, worker-critical, worker-heavy, beat)
                                          |-> RDS PostgreSQL 16 Multi-AZ (optional RDS Proxy)
                                          |-> ElastiCache Redis 7.1 (TLS + AUTH)
                                          '-> S3 private bucket (SSE-KMS)
```

| File | Contents |
|---|---|
| `versions.tf`, `backend.tf` | providers (default region + `aws.us_east_1`), remote state (commented) |
| `variables.tf`, `locals.tf` | inputs, naming, tags |
| `vpc.tf` | VPC, public/app/data subnets, NAT, VPC endpoints, flow logs |
| `security_groups.tf` | least-privilege SGs (CloudFront prefix list -> ALB -> app -> data) |
| `alb.tf` | ALB, HTTPS listener, origin-verify rules, target groups |
| `cloudfront.tf`, `waf.tf` | edge distribution, managed + rate-based WAF rules, WAF logs |
| `ecr.tf`, `ecs.tf`, `autoscaling.tf` | images, cluster, task definitions, services, scaling |
| `rds.tf`, `elasticache.tf`, `s3.tf` | data tier |
| `secrets.tf`, `iam.tf` | KMS key, Secrets Manager, task/execution roles, GitHub OIDC deploy role |
| `logs.tf`, `alarms.tf` | log groups, SNS topics, CloudWatch alarms and metric filters |
| `outputs.tf` | values consumed by the deploy pipeline and operators |
| `environments/production.tfvars.example` | starting point for `production.tfvars` (git-ignored) |

## 1. Bootstrap (create by hand, once)

Terraform cannot sensibly own these, either because it needs them before its
first run or because they are shared across environments.

1. **Route 53 hosted zone** for the apex domain (or delegate a sub-zone).
2. **ACM certificates** for `app_domain`, DNS-validated in the hosted zone:
   * one in `ap-south-1` (ALB listener) -> `acm_certificate_arn_alb`
   * one in `us-east-1` (CloudFront viewer certificate) -> `acm_certificate_arn_cloudfront`
3. **State bucket + lock table** (S3 with versioning, SSE, public access blocked;
   DynamoDB table with partition key `LockID`). Then uncomment `backend.tf` and
   run `terraform init -migrate-state`.
4. Optionally an **SES identity** for the sending domain (SPF/DKIM/DMARC) so
   `EMAIL_URL` has something to point at.

Nothing else is created outside Terraform. No account IDs or secrets are in
the code; they arrive via `tfvars` and Secrets Manager.

## 2. Apply order

```bash
cd infra/terraform
cp environments/production.tfvars.example environments/production.tfvars   # fill it in
terraform init
terraform plan  -var-file=environments/production.tfvars
terraform apply -var-file=environments/production.tfvars
```

The first apply creates everything in one pass. ECS services will start with
`<ecr-repo>:latest`, which does not exist yet, so tasks fail to pull until CI
has pushed the first image; the circuit breaker keeps them from flapping.
Sequence for a fresh environment:

1. `terraform apply` (creates ECR, RDS, Redis, secrets, roles, empty services).
2. Create the Route 53 alias `app_domain -> cloudfront_domain_name` (output).
3. Fill in `DATABASE_URL` and `EMAIL_URL` (section 3).
4. Run the GitHub Actions deploy workflow: build + push images, `run-task`
   migrate, then `update-service` for every service (section 4).

Re-applying later never touches task definition revisions or desired counts
(`lifecycle.ignore_changes`), so Terraform and CI/autoscaling do not fight.

## 3. Secrets operators must fill in

Terraform creates the Secrets Manager entries but only knows the values it
generates itself (`SECRET_KEY`, `REDIS_URL`, `CELERY_BROKER_URL`,
`ORIGIN_VERIFY`). Two are placeholders (`REPLACE_ME`) with
`ignore_changes = [secret_string]`, so what you put in stays:

### `DATABASE_URL`

The application connects as the `crm_app` role, never as the RDS master user.

1. Retrieve the master credentials from the RDS-managed secret
   (`secret_arns.RDS_MASTER` output) and connect from a bastion / SSM session
   in the app subnets (the DB is not reachable from outside the VPC).
2. Run `infra/postgres/prod-roles.sql`, then set passwords:
   `ALTER ROLE crm_migrator PASSWORD '...'; ALTER ROLE crm_app PASSWORD '...';`
3. Store the runtime URL:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id keel-production/DATABASE_URL \
     --secret-string 'postgresql://crm_app:<password>@<rds_endpoint>/keel'
   ```

   `rds_endpoint` (output) already includes the port. With `enable_rds_proxy`
   use `rds_proxy_endpoint` and port 5432 instead. TLS is enforced server-side
   (`rds.force_ssl=1`) and verified client-side (`DB_SSLMODE=verify-full`
   against the system CA bundle, which contains the RDS CA).
4. Migrations run as `crm_migrator`; the deploy pipeline passes that URL to the
   `migrate` task through a separate secret or CI-scoped variable (out of scope
   for this module; the `migrate` task definition reads the same `DATABASE_URL`
   by default, so either point it at a `crm_migrator` URL or grant `crm_app`
   the migration privileges you are comfortable with).

### `EMAIL_URL`

```bash
aws secretsmanager put-secret-value \
  --secret-id keel-production/EMAIL_URL \
  --secret-string 'smtp+tls://<ses-smtp-user>:<ses-smtp-password>@email-smtp.ap-south-1.amazonaws.com:587'
```

Running tasks read secrets only at start; force a new deployment
(`aws ecs update-service --force-new-deployment`) after changing a value.

## 4. How the deploy pipeline uses the outputs

GitHub Actions on `main` assumes `deploy_role_arn` through OIDC
(`repo:<github_repository>:ref:refs/heads/main` only; no static keys) and:

| Step | Uses |
|---|---|
| `docker push` | `ecr_api_url`, `ecr_web_url` (tags are immutable; tag by git SHA) |
| register task definitions | `aws ecs describe-task-definition` of the current family, swap the image, `register-task-definition` |
| migrate | `aws ecs run-task --cluster $ecs_cluster_name --task-definition $migrate_task_family --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$task_subnet_ids],securityGroups=[$worker_security_group_id],assignPublicIp=DISABLED}"`, then `aws ecs wait tasks-stopped` and check the exit code |
| roll services | `aws ecs update-service --cluster $ecs_cluster_name --service <name> --task-definition <new arn>` for each entry of `ecs_service_names` (api and workers after migrate; web can go in parallel) |
| verify | `aws ecs wait services-stable`; the deployment circuit breaker rolls back automatically on repeated task failures |

The role can only push to the two repositories, update the five services,
run the `migrate` family in this cluster and pass the task roles defined here.

## 5. RDS Proxy toggle

`enable_rds_proxy = false` by default. Turn it on when the connection budget
approaches 60% of `max_connections`:

```
api tasks      x GUNICORN_WORKERS x GUNICORN_THREADS   (6 x 2 x 4 = 48 at max scale)
+ worker-critical tasks x 4 concurrency                 (4 x 4 = 16)
+ worker-heavy tasks    x 2 concurrency                 (3 x 2 = 6)
+ beat + migrate + admin sessions                       (~5)
```

That is ~75 connections at full scale for the defaults, well under the 400 of a
`db.t4g.medium`, so the proxy is off. Enable it (and point `DATABASE_URL` at
`rds_proxy_endpoint`) before raising `api_max_capacity`, gunicorn sizing or
worker concurrency past that ~60% line, or if deploys start producing
connection storms. The proxy currently authenticates with the RDS-managed
master secret; add a dedicated `crm_app` secret to its `auth` block before
routing app traffic through it (comment in `rds.tf`).

## 6. Cost drivers and rough monthly estimate (defaults, ap-south-1, on-demand)

Numbers are order-of-magnitude, USD, September 2026 list prices, low traffic
(~1 M requests/month, ~50 GB egress). Check the AWS calculator before budgeting.

| Item | Driver | Approx. USD/month |
|---|---|---|
| NAT gateway (1) | hourly + data processed | 45 |
| VPC interface endpoints (5 x 2 AZ) | hourly per AZ | 75 |
| ALB | hourly + LCU | 25 |
| Fargate: api 2 x (1 vCPU / 2 GiB) | task-hours | 76 |
| Fargate: web 2 x (0.5 vCPU / 1 GiB) | task-hours | 38 |
| Fargate: worker-critical 1 x (1 / 2) | task-hours | 38 |
| Fargate: worker-heavy 1 x (1 / 2), on-demand base | task-hours (extra tasks on Spot, ~70% cheaper) | 38 |
| Fargate: beat 1 x (0.25 / 0.5) | task-hours | 10 |
| RDS db.t4g.medium Multi-AZ + 50 GB gp3 x 2 | instance-hours x 2, storage | 125 |
| ElastiCache 2 x cache.t4g.small | node-hours | 60 |
| CloudFront (PriceClass_200) | requests + egress | 15 |
| WAF: 1 web ACL, 4 managed groups, 3 rate rules | fixed + requests | 15 |
| CloudWatch: logs, Container Insights, ~45 alarms, custom metrics | ingestion + alarms | 30 |
| Secrets Manager (7 secrets), KMS (1 key) | fixed | 5 |
| S3, ECR | storage | 5 |
| **Total** | | **~600** |

Levers, cheapest first: drop the interface endpoints if NAT data volume is
small (`enable_vpc_endpoints=false`, -75), use `single_nat_gateway=true`
(already default; per-AZ NAT is +45 each), `redis_num_nodes=1` (-30, loses
failover), single-AZ RDS is not offered by this module on purpose.
`enable_waf_bot_control=true` adds ~10 + 1/M requests.

## 7. Security posture summary

* **Edge only**: the ALB security group admits traffic solely from the
  CloudFront origin-facing managed prefix list, and every listener rule also
  requires the `X-Origin-Verify` header that CloudFront injects. Direct hits
  get a 403. `/admin/*` is answered 404 at the ALB.
* **WAF** (CloudFront scope): IP reputation, Core rule set (body size check in
  count mode for CSV imports), Known Bad Inputs, SQLi, and rate limits for
  login (100/5 min), API (1500/5 min) and global (3000/5 min) per IP.
  Logs go to `aws-waf-logs-keel-production` with `authorization` and `cookie`
  redacted.
* **TLS everywhere**: TLS 1.2+ at CloudFront (TLSv1.2_2021) and the ALB
  (TLS13-1-2-2021-06), HTTPS-only to the origin, `rds.force_ssl=1` with
  `verify-full` on the client, Redis in-transit encryption required.
* **Network**: tasks in private app subnets, data tier in subnets with no
  default route, security groups referencing each other rather than CIDRs,
  VPC flow logs retained `log_retention_days`.
* **Containers**: non-root images, `readonlyRootFilesystem`, ephemeral
  `/tmp`, init process, no `execute-command`, immutable image tags with
  scan-on-push.
* **Identity**: distinct execution / api / worker / web task roles; S3 access
  limited to the private bucket, metrics limited to the `Keel` namespace,
  secrets readable only by the execution role and only the five app secrets.
  CI deploys via GitHub OIDC on `main`, scoped to these repositories, services
  and task roles. No long-lived cloud keys.
* **Data**: one customer-managed KMS key with rotation for RDS storage, the
  private bucket, Secrets Manager and Performance Insights; RDS Multi-AZ,
  14-day PITR, deletion protection, final snapshot; S3 buckets block public
  access and deny non-TLS or non-KMS uploads.
* **Observability**: per-service log groups, a 365-day security log group,
  alarms on availability, latency, saturation, queue health, WAF blocks,
  failed logins and rate limiting (see `alarms.tf`; thresholds are starting
  points to be tuned from production data).

## 8. Validation without a local Terraform binary

```bash
cd infra/terraform
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/w" -w /w hashicorp/terraform:1.9 fmt -recursive -check
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/w" -w /w hashicorp/terraform:1.9 init -backend=false
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/w" -w /w hashicorp/terraform:1.9 validate
```

`.terraform.lock.hcl` is committed; `.terraform/`, state and real `*.tfvars`
files are git-ignored.
