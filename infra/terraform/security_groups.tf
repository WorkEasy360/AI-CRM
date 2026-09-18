# ---------------------------------------------------------------------------
# Security groups (least privilege, one group per ECS workload)
#
# Ingress
#   cloudfront -> alb              : 443 only, from the CloudFront origin-facing prefix list
#   alb        -> api              : 8000
#   alb        -> web              : 3000
#   data users -> db / proxy       : 5432   (security-group references only)
#   data users -> redis            : 6379   (security-group references only)
#
# Egress, per workload (local.service_profiles is the single source of truth)
#   every task        -> interface endpoints SG : TCP 443 (ECR, Logs, Secrets Manager, CloudWatch)
#   every task        -> S3 gateway prefix list : TCP 443 (ECR layers, private bucket)
#   data users        -> db / proxy / redis     : 5432 / 6379
#   api, web, worker-critical, worker-heavy -> internet via NAT : TCP 443 only
#   worker-critical                          -> internet via NAT : TCP 587 only (EMAIL_URL SMTP)
#   beat, migrate                            -> no internet
#
# Not listed on purpose:
#   * DNS: security groups never filter traffic to the Amazon-provided VPC resolver.
#   * KMS: tasks never call KMS directly (Secrets Manager and S3 decrypt server-side).
#   * ECS task metadata / credentials endpoint: link-local, exempt from security groups.
# Data-tier groups have no egress rule: their subnets have no default route.
# ---------------------------------------------------------------------------

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

locals {
  # `data`          : may open PostgreSQL (direct or via RDS Proxy) and Redis.
  # `internet_https`: may open TCP 443 to the public internet through the NAT gateway.
  # `internet_smtp` : may open TCP 587 (SMTP submission) to the public internet through NAT.
  service_profiles = {
    # OAuth token exchange (Google, Microsoft), WhatsApp Cloud API account verification,
    # LLM provider for AI features, remote embedding provider for RAG retrieval.
    api = { data = true, internet_https = true, internet_smtp = false }
    # Next.js server-side requests go to API_INTERNAL_ORIGIN = https://app_domain (CloudFront).
    # It never touches PostgreSQL or Redis.
    web = { data = false, internet_https = true, internet_smtp = false }
    # Queues default + notifications: Gmail API / Microsoft Graph sync and sends, WhatsApp Cloud
    # API sends (443); accounts.send_email delivers through EMAIL_URL, an SMTP submission URL
    # (smtp+tls://...:587, see README section 3).
    "worker-critical" = { data = true, internet_https = true, internet_smtp = true }
    # Queues imports/exports/reports/rag_indexing/integrations: remote embedding provider and customer-configured
    # integration endpoints (443, SSRF-filtered in apps.integrations.net). Imports and
    # exports only use S3; report emails are queued to worker-critical.
    "worker-heavy" = { data = true, internet_https = true, internet_smtp = false }
    # django-celery-beat DatabaseScheduler + Redis broker only.
    beat = { data = true, internet_https = false, internet_smtp = false }
    # `manage.py migrate`: PostgreSQL only.
    migrate = { data = true, internet_https = false, internet_smtp = false }
  }

  data_services  = { for k, p in local.service_profiles : k => p if p.data }
  proxy_services = { for k, p in local.service_profiles : k => p if p.data && var.enable_rds_proxy }
  # Interface/gateway endpoints exist only when enable_vpc_endpoints; without them every task
  # must reach ECR, Logs, Secrets Manager, CloudWatch and S3 through NAT on 443.
  endpoint_services     = { for k, p in local.service_profiles : k => p if var.enable_vpc_endpoints }
  public_https_services = { for k, p in local.service_profiles : k => p if p.internet_https || !var.enable_vpc_endpoints }
  public_smtp_services  = { for k, p in local.service_profiles : k => p if p.internet_smtp }
}

# ---------------------------------------------------------------------------
# ALB: HTTPS from CloudFront only. Port 80 is not opened: the CloudFront origin
# uses origin_protocol_policy = "https-only", so nothing legitimate ever speaks
# plain HTTP to this load balancer.
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: HTTPS from CloudFront origin-facing IPs only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from CloudFront"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To api tasks"
  from_port                    = 8000
  to_port                      = 8000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.service["api"].id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To web tasks"
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.service["web"].id
}

# ---------------------------------------------------------------------------
# ECS workloads
# ---------------------------------------------------------------------------

resource "aws_security_group" "service" {
  for_each = local.service_profiles

  name        = "${local.name}-${each.key}"
  description = "ECS ${each.key} tasks"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-${each.key}" }
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.service["api"].id
  description                  = "api from ALB"
  from_port                    = 8000
  to_port                      = 8000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.service["web"].id
  description                  = "web from ALB"
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
}

# Data tier (security-group references, never CIDRs)

resource "aws_vpc_security_group_egress_rule" "service_to_db" {
  for_each = local.data_services

  security_group_id            = aws_security_group.service[each.key].id
  description                  = "PostgreSQL"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_egress_rule" "service_to_proxy" {
  for_each = local.proxy_services

  security_group_id            = aws_security_group.service[each.key].id
  description                  = "PostgreSQL via RDS Proxy"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.rds_proxy[0].id
}

resource "aws_vpc_security_group_egress_rule" "service_to_redis" {
  for_each = local.data_services

  security_group_id            = aws_security_group.service[each.key].id
  description                  = "Redis (TLS)"
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.redis.id
}

# AWS services through VPC endpoints (ECR, Logs, Secrets Manager, CloudWatch; S3 gateway)

resource "aws_vpc_security_group_egress_rule" "service_to_vpc_endpoints" {
  for_each = local.endpoint_services

  security_group_id            = aws_security_group.service[each.key].id
  description                  = "HTTPS to interface VPC endpoints"
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.vpc_endpoints[0].id
}

resource "aws_vpc_security_group_egress_rule" "service_to_s3" {
  for_each = local.endpoint_services

  security_group_id = aws_security_group.service[each.key].id
  description       = "HTTPS to S3 gateway endpoint"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  prefix_list_id    = aws_vpc_endpoint.s3[0].prefix_list_id
}

# Public internet through NAT, TCP 443 only.
#
# ACCEPTED FINDING  AVD-AWS-0104 (aws-ec2-no-public-egress-sgr)
#   Resource : aws_vpc_security_group_egress_rule.service_internet_https (api, web,
#              worker-critical, worker-heavy; beat/migrate only when enable_vpc_endpoints=false)
#   Reason   : these workloads call third-party HTTPS APIs whose addresses are not
#              enumerable (Anthropic, Google OAuth/Gmail, Microsoft OAuth/Graph, WhatsApp
#              Cloud API, the remote embedding provider, and CloudFront for the web tier).
#              The scanner flags any egress to a public CIDR regardless of port.
#   Controls : single TCP port; tasks sit in private subnets behind NAT with no public IP;
#              no ingress except from the ALB; AWS-service traffic uses VPC endpoints;
#              VPC flow logs retained; beat and migrate have no internet at all.
#   Owner    : Keel platform owner (staging readiness review, 2026-09-16).
#   Review   : the exception expires 2027-03-16; CI fails then until it is re-accepted.
#              Removing it needs an egress proxy / allow-listing layer (e.g. AWS Network
#              Firewall with FQDN rules), which is tracked as a follow-up.
#trivy:ignore:AVD-AWS-0104:exp:2027-03-16
resource "aws_vpc_security_group_egress_rule" "service_internet_https" {
  for_each = local.public_https_services

  security_group_id = aws_security_group.service[each.key].id
  description       = "HTTPS to third-party APIs via NAT"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

# ACCEPTED FINDING  AVD-AWS-0104 (aws-ec2-no-public-egress-sgr)
#   Resource : aws_vpc_security_group_egress_rule.service_internet_smtp (worker-critical only)
#   Reason   : accounts.send_email delivers through EMAIL_URL, an operator-supplied SMTP
#              submission endpoint (README documents SES SMTP on 587). The provider's
#              addresses are not enumerable.
#   Controls : single TCP port (587, STARTTLS); one workload; private subnet behind NAT.
#   Owner    : Keel platform owner (staging readiness review, 2026-09-16).
#   Review   : expires 2027-03-16. If SES stays the provider, replace this rule with the
#              com.amazonaws.<region>.email-smtp interface endpoint and drop the exception.
#trivy:ignore:AVD-AWS-0104:exp:2027-03-16
resource "aws_vpc_security_group_egress_rule" "service_internet_smtp" {
  for_each = local.public_smtp_services

  security_group_id = aws_security_group.service[each.key].id
  description       = "SMTP submission (EMAIL_URL) via NAT"
  from_port         = 587
  to_port           = 587
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------------

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "RDS PostgreSQL: 5432 from data-tier workloads and RDS proxy"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_service" {
  for_each = local.data_services

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from ${each.key} tasks"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.service[each.key].id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from RDS Proxy"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.rds_proxy[0].id
}

# RDS Proxy (optional)
resource "aws_security_group" "rds_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  name        = "${local.name}-rds-proxy"
  description = "RDS Proxy: 5432 from data-tier workloads"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-rds-proxy" }
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_service" {
  for_each = local.proxy_services

  security_group_id            = aws_security_group.rds_proxy[0].id
  description                  = "PostgreSQL from ${each.key} tasks"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.service[each.key].id
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_db" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = aws_security_group.rds_proxy[0].id
  description                  = "To RDS"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.db.id
}

# ---------------------------------------------------------------------------
# ElastiCache
# ---------------------------------------------------------------------------

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "ElastiCache Redis: 6379 from data-tier workloads"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-redis" }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_service" {
  for_each = local.data_services

  security_group_id            = aws_security_group.redis.id
  description                  = "Redis (TLS) from ${each.key} tasks"
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.service[each.key].id
}
