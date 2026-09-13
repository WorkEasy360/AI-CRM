# ---------------------------------------------------------------------------
# CloudWatch log groups. One per ECS service plus a dedicated security group
# with longer retention (the app routes security events there via the
# "security" logger; see docs/architecture/infrastructure.md).
#
# KMS encryption of log groups is intentionally skipped: CloudWatch encrypts
# at rest by default and a CMK here adds key-policy coupling for little gain.
# ---------------------------------------------------------------------------

locals {
  service_log_groups = toset([
    "api",
    "web",
    "worker-critical",
    "worker-heavy",
    "beat",
    "migrate",
  ])
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = local.service_log_groups

  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days

  tags = { Service = each.key }
}

resource "aws_cloudwatch_log_group" "security" {
  name              = "/ecs/${local.name}/security"
  retention_in_days = var.security_log_retention_days

  tags = { Service = "security" }
}
