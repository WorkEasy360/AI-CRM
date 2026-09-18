# ---------------------------------------------------------------------------
# Application Load Balancer
#
# Internet-facing but reachable only from CloudFront (security group prefix
# list) AND only for requests carrying the X-Origin-Verify header that
# CloudFront injects. Anything else hits the default 403 action.
#
# ACCEPTED FINDING  AVD-AWS-0053 (aws-elb-alb-not-public)
#   Resource : aws_lb.this (internal = false)
#   Reason   : the approved edge is Internet -> CloudFront -> WAF -> ALB -> ECS with the ALB
#              as a classic custom origin. A custom origin must be publicly resolvable and
#              reachable, so the load balancer cannot be internal without moving to
#              CloudFront VPC Origins (a separate architecture change, tracked as a follow-up).
#   Controls : security group admits only the CloudFront origin-facing managed prefix list on
#              TCP 443 (no port 80 listener); every listener rule requires the X-Origin-Verify
#              secret CloudFront injects, otherwise a fixed 403; CloudFront reaches the origin
#              HTTPS-only; WAF (managed rule groups + rate limits) is attached to the
#              distribution; targets are private-subnet tasks with no public IP; /admin/* and
#              /health/* are never forwarded; access logs retained 30 days.
#   Owner    : Keel platform owner (staging readiness review, 2026-09-16).
#   Review   : the exception expires 2027-03-16; CI fails then until it is re-accepted or the
#              ALB is moved behind a CloudFront VPC Origin.
# ---------------------------------------------------------------------------

#trivy:ignore:AVD-AWS-0053:exp:2027-03-16
resource "aws_lb" "this" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  drop_invalid_header_fields = true
  idle_timeout               = 60
  enable_deletion_protection = var.deletion_protection
  enable_http2               = true
  desync_mitigation_mode     = "defensive"

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb"
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.alb_logs]

  tags = { Name = "${local.name}-alb" }
}

# ---------------------------------------------------------------------------
# Target groups
# ---------------------------------------------------------------------------

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 8000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  deregistration_delay = 30

  # LIVENESS, not readiness. A readiness probe here couples target health to the database: during an
  # RDS failover every API task answers 503 at the same moment, the ALB evicts the entire fleet, and a
  # 30-second failover becomes a full outage that outlasts it -- the targets have to pass
  # healthy_threshold checks again before any traffic returns, and there is nowhere to shift load to
  # because every target failed for the same reason. The application processes were fine throughout.
  #
  # So the load balancer asks only "is this process serving?". Requests that need the database fail
  # individually with a 503 and recover the instant the database does. Dependency health is a
  # monitoring concern (see the readiness alarm in alarms.tf), not a reason to shoot the fleet.
  health_check {
    path                = "/health/live/"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-api" }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  deregistration_delay = 30

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-web" }
}

# ---------------------------------------------------------------------------
# Listeners
# ---------------------------------------------------------------------------

# No HTTP listener: CloudFront reaches the origin HTTPS-only and the security
# group does not open port 80, so a redirect listener would be dead surface.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn_alb

  # Requests that do not carry the CloudFront origin-verify header never reach a target.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "forbidden"
      status_code  = "403"
    }
  }
}

# api: Django paths
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }

  condition {
    path_pattern {
      values = ["/api/*", "/_allauth/*"]
    }
  }

  tags = { Name = "${local.name}-rule-api" }
}

# Probes are for the load balancer only (it calls targets directly, bypassing listener rules); the
# public edge never reaches /health/* so the readiness check cannot be used to hammer dependencies.
resource "aws_lb_listener_rule" "health_blocked" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 15

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }

  condition {
    path_pattern {
      values = ["/health/*", "/ready/*"]
    }
  }

  tags = { Name = "${local.name}-rule-health-blocked" }
}

# Django admin is not exposed through the edge at all.
resource "aws_lb_listener_rule" "admin_blocked" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }

  condition {
    path_pattern {
      values = ["/admin/*"]
    }
  }

  tags = { Name = "${local.name}-rule-admin-blocked" }
}

# web: everything else
resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }

  tags = { Name = "${local.name}-rule-web" }
}
