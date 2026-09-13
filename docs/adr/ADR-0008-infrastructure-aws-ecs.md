# ADR-0008 — AWS with ECS Fargate and managed data services

**Status:** Accepted (2026-09-12, AWS ap-south-1); implementation in Phase 6

## Context
The MVP needs a reverse proxy, containers, managed PostgreSQL, Redis, object storage, secrets/KMS, WAF, backups and CI/CD, without Kubernetes or bespoke infrastructure.

## Decision
Containers on ECS Fargate behind an ALB with AWS WAF; RDS PostgreSQL Multi-AZ with PITR; ElastiCache Redis; S3 with SSE-KMS; Secrets Manager + KMS; CloudWatch logs/metrics with a dedicated security log group; Terraform for all resources; GitHub Actions for CI/CD with OIDC-based deploy credentials (no long-lived cloud keys).

## Consequences
- Managed services carry encryption, backups and patching; we operate no database hosts.
- Everything in this ADR has direct equivalents on GCP (Cloud Run, Cloud SQL, Memorystore, GCS, Secret Manager) or Azure; the application does not depend on AWS-specific APIs beyond S3-compatible storage and KMS (accessed through adapters).
- Region choice determines data residency; must be fixed before Phase 6.
