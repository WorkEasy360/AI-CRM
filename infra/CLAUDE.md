# Infrastructure Rules

## Scope
Apply these rules only to infrastructure, deployment, Docker, CI/CD, and AWS work.

## Current Architecture
- Route 53
- CloudFront
- AWS WAF
- ALB
- ECS Fargate
- RDS PostgreSQL
- ElastiCache Redis
- S3
- KMS
- Secrets Manager

## Efficiency
- Inspect only infrastructure files relevant to the task.
- Do not scan unrelated application code.
- Reuse existing infrastructure patterns.
- Avoid unnecessary resource creation.
- Avoid introducing new AWS services unless clearly required.
- Prefer the simplest production-safe solution.

## Security
- HTTPS only.
- Keep application services in private subnets where applicable.
- Never hardcode credentials or secrets.
- Use Secrets Manager / secure environment injection.
- Apply least-privilege IAM.
- Keep S3 private unless explicitly required otherwise.
- Preserve encryption at rest and in transit.
- Do not weaken WAF, security groups, IAM, or network isolation.
- Never expose PostgreSQL or Redis publicly.

## Load Balancing
Preserve routing rules:

- `/api/*` → Django API
- `/_allauth/*` → Django
- `/*` → Next.js
- `/health/*` and `/admin/*` follow existing restricted policy

- Maintain HTTPS listeners.
- Preserve origin verification/security headers.
- Avoid unnecessary redirects.
- Prevent redirect loops between ALB, Next.js, and Django.

## ECS
Existing services:

- api
- web
- worker-critical
- worker-heavy
- beat

Do not merge or split services without a clear architectural reason.

## Scaling
- Scale API/web based on real load indicators.
- Scale workers primarily using queue pressure.
- Do not overprovision resources without evidence.
- Prefer measurable autoscaling policies.

## Database / Redis
- Preserve RDS Multi-AZ configuration where configured.
- Never make destructive DB changes without explicit review.
- Do not expose Redis externally.
- Preserve backup/recovery configuration.

## Docker
- Keep images minimal.
- Use multi-stage builds where already established.
- Do not include secrets in images.
- Pin important dependencies/base images where practical.
- Avoid unnecessary packages.

## CI/CD
- Preserve pinned GitHub Actions.
- Never bypass security gates to make CI pass.
- Keep:
  - tests
  - lint/type checks
  - secret scanning
  - vulnerability scanning
  - image scanning

## Changes
Before modifying infrastructure:
1. Understand the existing resource.
2. Make the smallest required change.
3. Check security impact.
4. Check availability impact.
5. Check rollback path.

## Output
Report only:
1. Infrastructure changed
2. Files/resources affected
3. Validation performed
4. Security/availability risk