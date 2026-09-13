# ---------------------------------------------------------------------------
# Security groups (least privilege)
#
#   cloudfront -> alb   : 443/80, only from the CloudFront origin-facing prefix list
#   alb        -> app   : 8000 (api) and 3000 (web)
#   app/worker -> db    : 5432
#   app/worker -> redis : 6379
#   proxy      -> db    : 5432 (when enable_rds_proxy)
#
# Egress from app/worker is open (via NAT) for email/LLM/OAuth providers.
# Data-tier groups have no egress rule that matters: their subnets have no
# default route.
# ---------------------------------------------------------------------------

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: HTTPS/HTTP from CloudFront origin-facing IPs only"
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

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from CloudFront (redirected to HTTPS by the listener)"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To api tasks"
  from_port                    = 8000
  to_port                      = 8000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To web tasks"
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id
}

# api + web tasks
resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "ECS api/web tasks: ingress from ALB only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-app" }
}

resource "aws_vpc_security_group_ingress_rule" "app_api_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "api from ALB"
  from_port                    = 8000
  to_port                      = 8000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "app_web_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "web from ALB"
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "All egress via NAT / VPC endpoints"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Celery workers, beat, migrate
resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "ECS worker/beat/migrate tasks: no ingress"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-worker" }
}

resource "aws_vpc_security_group_egress_rule" "worker_all" {
  security_group_id = aws_security_group.worker.id
  description       = "All egress via NAT / VPC endpoints"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# RDS
resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "RDS PostgreSQL: 5432 from app, worker and RDS proxy"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from api/web tasks"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_worker" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from worker tasks"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.worker.id
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
  description = "RDS Proxy: 5432 from app and worker"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-rds-proxy" }
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_app" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = aws_security_group.rds_proxy[0].id
  description                  = "PostgreSQL from api/web tasks"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_worker" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = aws_security_group.rds_proxy[0].id
  description                  = "PostgreSQL from worker tasks"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.worker.id
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

# ElastiCache
resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "ElastiCache Redis: 6379 from app and worker"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-redis" }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis (TLS) from api/web tasks"
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_worker" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis (TLS) from worker tasks"
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.worker.id
}
