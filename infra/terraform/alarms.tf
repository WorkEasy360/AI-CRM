# ---------------------------------------------------------------------------
# Alarms and notifications.
#
# README: every threshold below is a conservative initial value chosen before
# the system has seen production traffic. Review them after the first weeks
# against observed p95 latency, connection counts and queue behaviour, and
# tune in tfvars-driven follow-ups rather than muting alarms.
# ---------------------------------------------------------------------------

# Both topics are SSE-KMS encrypted with customer-managed keys whose policies
# let cloudwatch.amazonaws.com Decrypt / GenerateDataKey (secrets.tf). The
# AWS-managed aws/sns key cannot be used: its policy cannot be edited to grant
# CloudWatch alarms that access. Email subscriptions need nothing extra; SNS
# decrypts on delivery.
resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.this.arn
}

resource "aws_sns_topic_subscription" "alarms_email" {
  count = var.alarm_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# CloudFront-scoped WAF metrics live in us-east-1, and alarm actions must be
# in the alarm's region, so the edge gets its own topic.
resource "aws_sns_topic" "alarms_us_east_1" {
  provider = aws.us_east_1

  name              = "${local.name}-alarms-edge"
  kms_master_key_id = aws_kms_key.edge.arn
}

resource "aws_sns_topic_subscription" "alarms_us_east_1_email" {
  count    = var.alarm_email != "" ? 1 : 0
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.alarms_us_east_1.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]

  target_groups = {
    api = aws_lb_target_group.api.arn_suffix
    web = aws_lb_target_group.web.arn_suffix
  }

  ecs_services = {
    api               = aws_ecs_service.api.name
    web               = aws_ecs_service.web.name
    "worker-critical" = aws_ecs_service.worker_critical.name
    "worker-heavy"    = aws_ecs_service.worker_heavy.name
    beat              = aws_ecs_service.beat.name
  }
}

# ---------------------------------------------------------------------------
# ALB
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  alarm_name          = "${local.name}-alb-5xx-rate"
  alarm_description   = "Target 5xx responses exceed 2% of requests over 5 minutes"
  evaluation_periods  = 1
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = aws_lb.this.arn_suffix }
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = { LoadBalancer = aws_lb.this.arn_suffix }
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "rate"
    expression  = "IF(requests > 0, 100 * errors / requests, 0)"
    label       = "5xx rate (%)"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_p95_latency" {
  for_each = local.target_groups

  alarm_name          = "${local.name}-alb-${each.key}-p95-latency"
  alarm_description   = "${each.key} p95 target response time above 1.0s for 3 consecutive minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1.0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  for_each = local.target_groups

  alarm_name          = "${local.name}-alb-${each.key}-unhealthy-hosts"
  alarm_description   = "${each.key} has at least one unhealthy target for 2 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = each.value
  }
}

# ---------------------------------------------------------------------------
# ECS services
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = local.ecs_services

  alarm_name          = "${local.name}-ecs-${each.key}-cpu"
  alarm_description   = "${each.key} average CPU above 85% for 5 minutes"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  for_each = local.ecs_services

  alarm_name          = "${local.name}-ecs-${each.key}-memory"
  alarm_description   = "${each.key} average memory above 85% for 5 minutes"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = each.value
  }
}

# ---------------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------------

locals {
  rds_dimensions = { DBInstanceIdentifier = aws_db_instance.this.identifier }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name}-rds-cpu"
  alarm_description   = "RDS CPU above 80% for 10 minutes"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 10
  datapoints_to_alarm = 10
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = local.rds_dimensions
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${local.name}-rds-connections"
  alarm_description   = "RDS connections above 80% of max_connections (${var.db_max_connections_alarm})"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = floor(var.db_max_connections_alarm * 0.8)
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = local.rds_dimensions
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${local.name}-rds-free-storage"
  alarm_description   = "RDS free storage below 10 GiB"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = local.rds_dimensions
}

resource "aws_cloudwatch_metric_alarm" "rds_freeable_memory" {
  alarm_name          = "${local.name}-rds-freeable-memory"
  alarm_description   = "RDS freeable memory below 256 MiB"
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 256 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = local.rds_dimensions
}

resource "aws_cloudwatch_metric_alarm" "rds_read_latency" {
  alarm_name          = "${local.name}-rds-read-latency"
  alarm_description   = "RDS read latency above 20ms"
  namespace           = "AWS/RDS"
  metric_name         = "ReadLatency"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 0.020
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = local.rds_dimensions
}

# ---------------------------------------------------------------------------
# ElastiCache (one alarm per node; ElastiCache reports per CacheClusterId)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  for_each = toset(local.redis_member_cluster_ids)

  alarm_name          = "${each.key}-memory-usage"
  alarm_description   = "Redis ${each.key} memory usage above 80%"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = { CacheClusterId = each.key }
}

resource "aws_cloudwatch_metric_alarm" "redis_evictions" {
  for_each = toset(local.redis_member_cluster_ids)

  alarm_name          = "${each.key}-evictions"
  alarm_description   = "Redis ${each.key} evicted keys (cache TTL keys under memory pressure; broker keys are never evictable)"
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = { CacheClusterId = each.key }
}

resource "aws_cloudwatch_metric_alarm" "redis_connections" {
  for_each = toset(local.redis_member_cluster_ids)

  alarm_name          = "${each.key}-connections"
  alarm_description   = "Redis ${each.key} current connections above 5000"
  namespace           = "AWS/ElastiCache"
  metric_name         = "CurrConnections"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 5000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = { CacheClusterId = each.key }
}

resource "aws_cloudwatch_metric_alarm" "redis_engine_cpu" {
  for_each = toset(local.redis_member_cluster_ids)

  alarm_name          = "${each.key}-engine-cpu"
  alarm_description   = "Redis ${each.key} engine CPU above 80%"
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = { CacheClusterId = each.key }
}

# ---------------------------------------------------------------------------
# Celery (application-published metrics, namespace "Keel")
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "celery_queue_depth" {
  for_each = toset(local.celery_queues)

  alarm_name          = "${local.name}-celery-${each.key}-queue-depth"
  alarm_description   = "Celery queue ${each.key} depth above 500 for 10 minutes"
  namespace           = local.metrics_namespace
  metric_name         = "QueueDepth"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 10
  datapoints_to_alarm = 10
  threshold           = 500
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = { Queue = each.key }
}

resource "aws_cloudwatch_metric_alarm" "celery_oldest_message" {
  for_each = toset(local.celery_queues)

  alarm_name          = "${local.name}-celery-${each.key}-oldest-message"
  alarm_description   = "Celery queue ${each.key} oldest message above 600s for 5 minutes"
  namespace           = local.metrics_namespace
  metric_name         = "OldestMessageAgeSeconds"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = { Queue = each.key }
}

resource "aws_cloudwatch_metric_alarm" "celery_task_failures" {
  alarm_name          = "${local.name}-celery-task-failures"
  alarm_description   = "More than 5 Celery task failures in 5 minutes"
  namespace           = local.metrics_namespace
  metric_name         = "TaskFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# WAF (us-east-1)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "waf_blocked" {
  provider = aws.us_east_1

  alarm_name          = "${local.name}-waf-blocked-requests"
  alarm_description   = "WAF blocked more than 1000 requests in 5 minutes"
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms_us_east_1.arn]
  ok_actions          = [aws_sns_topic.alarms_us_east_1.arn]

  dimensions = {
    WebACL = aws_wafv2_web_acl.this.name
    Rule   = "ALL"
    Region = "global"
  }
}

# ---------------------------------------------------------------------------
# Log-derived security signals (api structured JSON logs)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "login_failures" {
  name           = "${local.name}-login-failures"
  log_group_name = aws_cloudwatch_log_group.service["api"].name
  pattern        = "{ $.event = \"auth.login_failed\" }"

  metric_transformation {
    name          = "LoginFailures"
    namespace     = local.metrics_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "login_failures" {
  alarm_name          = "${local.name}-login-failures"
  alarm_description   = "More than 200 failed logins in 5 minutes (credential stuffing?)"
  namespace           = local.metrics_namespace
  metric_name         = "LoginFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 200
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_log_metric_filter" "rate_limited" {
  name           = "${local.name}-rate-limited"
  log_group_name = aws_cloudwatch_log_group.service["api"].name
  pattern        = "{ $.status = 429 }"

  metric_transformation {
    name          = "RateLimited"
    namespace     = local.metrics_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "rate_limited" {
  alarm_name          = "${local.name}-rate-limited"
  alarm_description   = "More than 500 HTTP 429 responses in 5 minutes"
  namespace           = local.metrics_namespace
  metric_name         = "RateLimited"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 500
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
