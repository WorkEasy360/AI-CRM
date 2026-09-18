# ---------------------------------------------------------------------------
# Application Auto Scaling
#
# api / web : target tracking on ALB requests per target AND average CPU.
#             Both policies may scale out; scale-in only happens when every
#             policy agrees.
# workers   : step scaling driven by Celery queue metrics that the app
#             publishes to the "Keel" namespace every 30 seconds from a Celery
#             beat task (QueueDepth and OldestMessageAgeSeconds, dimension
#             Queue=<name>). If the metrics stop arriving nothing scales
#             (treat_missing_data = notBreaching), so the min capacity is the
#             safety floor.
# beat      : never scaled (see ecs.tf).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# api
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  min_capacity       = var.api_min_capacity
  max_capacity       = var.api_max_capacity
}

resource "aws_appautoscaling_policy" "api_requests" {
  name               = "${local.name}-api-requests-per-target"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  resource_id        = aws_appautoscaling_target.api.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.alb_requests_per_target_api
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"
    }
  }
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  resource_id        = aws_appautoscaling_target.api.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---------------------------------------------------------------------------
# web
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_target" "web" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.web.name}"
  min_capacity       = var.web_min_capacity
  max_capacity       = var.web_max_capacity
}

resource "aws_appautoscaling_policy" "web_requests" {
  name               = "${local.name}-web-requests-per-target"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  resource_id        = aws_appautoscaling_target.web.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.alb_requests_per_target_web
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.web.arn_suffix}"
    }
  }
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${local.name}-web-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  resource_id        = aws_appautoscaling_target.web.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---------------------------------------------------------------------------
# Worker step-scaling policies (shared shape for both worker services)
#
# Step bounds are relative to the alarm threshold (20):
#   depth in [20, 100)  -> +1 task
#   depth >= 100        -> +2 tasks
# ---------------------------------------------------------------------------

locals {
  worker_services = {
    "worker-critical" = {
      service_name = aws_ecs_service.worker_critical.name
      min_capacity = var.worker_critical_min_capacity
      max_capacity = var.worker_critical_max_capacity
    }
    "worker-heavy" = {
      service_name = aws_ecs_service.worker_heavy.name
      min_capacity = var.worker_heavy_min_capacity
      max_capacity = var.worker_heavy_max_capacity
    }
  }

  heavy_queues = ["imports", "exports", "reports", "rag_indexing", "integrations"]
}

resource "aws_appautoscaling_target" "worker" {
  for_each = local.worker_services

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${each.value.service_name}"
  min_capacity       = each.value.min_capacity
  max_capacity       = each.value.max_capacity
}

resource "aws_appautoscaling_policy" "worker_scale_out_depth" {
  for_each = local.worker_services

  name               = "${local.name}-${each.key}-scale-out-depth"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.worker[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.worker[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.worker[each.key].resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = 80
      scaling_adjustment          = 1
    }

    step_adjustment {
      metric_interval_lower_bound = 80
      scaling_adjustment          = 2
    }
  }
}

resource "aws_appautoscaling_policy" "worker_scale_out_age" {
  for_each = local.worker_services

  name               = "${local.name}-${each.key}-scale-out-age"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.worker[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.worker[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.worker[each.key].resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_appautoscaling_policy" "worker_scale_in" {
  for_each = local.worker_services

  name               = "${local.name}-${each.key}-scale-in"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.worker[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.worker[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.worker[each.key].resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 300
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}

# ---------------------------------------------------------------------------
# worker-critical alarms (queue "default")
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "worker_critical_depth_high" {
  alarm_name          = "${local.name}-worker-critical-queue-depth-high"
  alarm_description   = "default queue backlog: add worker-critical capacity"
  namespace           = local.metrics_namespace
  metric_name         = "QueueDepth"
  dimensions          = { Queue = "default" }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 20
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_scale_out_depth["worker-critical"].arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_critical_age_high" {
  alarm_name          = "${local.name}-worker-critical-oldest-message-high"
  alarm_description   = "default queue oldest message >= 120s: add worker-critical capacity"
  namespace           = local.metrics_namespace
  metric_name         = "OldestMessageAgeSeconds"
  dimensions          = { Queue = "default" }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 120
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_scale_out_age["worker-critical"].arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_critical_depth_low" {
  alarm_name          = "${local.name}-worker-critical-queue-depth-low"
  alarm_description   = "default queue idle for 10 minutes: remove worker-critical capacity"
  namespace           = local.metrics_namespace
  metric_name         = "QueueDepth"
  dimensions          = { Queue = "default" }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 10
  datapoints_to_alarm = 10
  threshold           = 0
  comparison_operator = "LessThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_scale_in["worker-critical"].arn]
}

# ---------------------------------------------------------------------------
# worker-heavy alarms (sum of imports + exports + reports)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "worker_heavy_depth_high" {
  alarm_name          = "${local.name}-worker-heavy-queue-depth-high"
  alarm_description   = "imports+exports+reports backlog: add worker-heavy capacity"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 20
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_scale_out_depth["worker-heavy"].arn]

  dynamic "metric_query" {
    for_each = local.heavy_queues
    content {
      id = metric_query.value
      metric {
        namespace   = local.metrics_namespace
        metric_name = "QueueDepth"
        dimensions  = { Queue = metric_query.value }
        period      = 60
        stat        = "Maximum"
      }
    }
  }

  metric_query {
    id          = "depth"
    expression  = "SUM([${join(", ", local.heavy_queues)}])"
    label       = "heavy queue depth"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_heavy_age_high" {
  alarm_name          = "${local.name}-worker-heavy-oldest-message-high"
  alarm_description   = "heavy queues oldest message >= 120s: add worker-heavy capacity"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 120
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_scale_out_age["worker-heavy"].arn]

  dynamic "metric_query" {
    for_each = local.heavy_queues
    content {
      id = metric_query.value
      metric {
        namespace   = local.metrics_namespace
        metric_name = "OldestMessageAgeSeconds"
        dimensions  = { Queue = metric_query.value }
        period      = 60
        stat        = "Maximum"
      }
    }
  }

  metric_query {
    id          = "age"
    expression  = "MAX([${join(", ", local.heavy_queues)}])"
    label       = "heavy queue oldest message age"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_heavy_depth_low" {
  alarm_name          = "${local.name}-worker-heavy-queue-depth-low"
  alarm_description   = "heavy queues idle for 10 minutes: remove worker-heavy capacity"
  evaluation_periods  = 10
  datapoints_to_alarm = 10
  threshold           = 0
  comparison_operator = "LessThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_scale_in["worker-heavy"].arn]

  dynamic "metric_query" {
    for_each = local.heavy_queues
    content {
      id = metric_query.value
      metric {
        namespace   = local.metrics_namespace
        metric_name = "QueueDepth"
        dimensions  = { Queue = metric_query.value }
        period      = 60
        stat        = "Maximum"
      }
    }
  }

  metric_query {
    id          = "depth"
    expression  = "SUM([${join(", ", local.heavy_queues)}])"
    label       = "heavy queue depth"
    return_data = true
  }
}
