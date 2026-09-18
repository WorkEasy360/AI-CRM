# ---------------------------------------------------------------------------
# ECS cluster, task definitions and services.
#
# All containers: non-root (set in the Dockerfiles), read-only root
# filesystem with an ephemeral volume mounted at /tmp (Fargate does not
# support tmpfs), init process enabled, awslogs driver.
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = local.name }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

# ---------------------------------------------------------------------------
# Shared container configuration
# ---------------------------------------------------------------------------

locals {
  api_environment = [
    { name = "ENVIRONMENT", value = "production" },
    { name = "DJANGO_SETTINGS_MODULE", value = "config.settings.prod" },
    { name = "ALLOWED_HOSTS", value = var.app_domain },
    { name = "CSRF_TRUSTED_ORIGINS", value = "https://${var.app_domain}" },
    { name = "FRONTEND_ORIGIN", value = "https://${var.app_domain}" },
    { name = "PRIVATE_STORAGE_BACKEND", value = "s3" },
    { name = "PRIVATE_STORAGE_BUCKET", value = aws_s3_bucket.private.id },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "TRUSTED_PROXY_COUNT", value = "2" }, # CloudFront + ALB
    { name = "GUNICORN_WORKERS", value = tostring(var.gunicorn_workers) },
    { name = "GUNICORN_THREADS", value = tostring(var.gunicorn_threads) },
    { name = "DB_POOL", value = "true" },
    { name = "METRICS_BACKEND", value = "cloudwatch" },
    { name = "METRICS_NAMESPACE", value = local.metrics_namespace },
    { name = "LOG_LEVEL", value = "INFO" },
    { name = "DB_SSLMODE", value = "verify-full" },
    { name = "DB_SSLROOTCERT", value = "/etc/ssl/certs/ca-certificates.crt" },
  ]

  # Secrets every Django process needs: the four infrastructure URLs plus the Fernet key
  # ring, without which config.settings.prod refuses to start (see secrets.tf).
  base_secrets = concat([
    { name = "SECRET_KEY", valueFrom = aws_secretsmanager_secret.secret_key.arn },
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
    { name = "CELERY_BROKER_URL", valueFrom = aws_secretsmanager_secret.celery_broker_url.arn },
    { name = "EMAIL_URL", valueFrom = aws_secretsmanager_secret.email_url.arn },
  ], local.boot_secrets)

  # Per-service composition (least privilege; see the table in secrets.tf).
  # api serves the assistant, the OAuth connect flow and the WhatsApp webhook.
  api_secrets = concat(local.base_secrets, local.ai_secrets, local.whatsapp_secrets, local.email_oauth_secrets)

  # worker-critical runs messaging.send_* and messaging.sync_email_account*, which refresh
  # mailbox OAuth tokens. It never calls the model and never verifies a webhook signature.
  worker_critical_secrets = concat(local.base_secrets, local.email_oauth_secrets)

  # worker-heavy (imports, exports, reports, rag_indexing, integrations), beat and migrate need nothing
  # beyond the base set.
  worker_heavy_secrets = local.base_secrets
  beat_secrets         = local.base_secrets
  migrate_secrets      = local.base_secrets

  web_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "HOSTNAME", value = "0.0.0.0" },
    # The ALB routes /api and /_allauth straight to Django, so the web tier
    # rarely proxies; when it does, it goes through the public edge.
    { name = "API_INTERNAL_ORIGIN", value = "https://${var.app_domain}" },
  ]

  tmp_mount = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]

  # Builds the awslogs block for a service log group.
  log_config = { for name, lg in aws_cloudwatch_log_group.service : name => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = lg.name
      awslogs-region        = var.aws_region
      awslogs-stream-prefix = name
    }
  } }

  api_health_check = {
    command     = ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/live/', timeout=3).status==200 else 1)\""]
    interval    = 30
    timeout     = 5
    retries     = 3
    startPeriod = 30
  }

  web_health_check = {
    command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1"]
    interval    = 30
    timeout     = 5
    retries     = 3
    startPeriod = 15
  }

  # Celery worker definitions share image, env and secrets with the api.
  workers = {
    "worker-critical" = {
      command = ["celery", "-A", "config.celery", "worker", "-l", "info", "-Q", "default,notifications", "-c", "4", "--max-tasks-per-child", "500"]
      cpu     = var.worker_cpu
      memory  = var.worker_memory
      secrets = local.worker_critical_secrets
    }
    "worker-heavy" = {
      # rag_indexing carries rag.purge_organization (tenant erasure): it must always have a consumer.
      command = ["celery", "-A", "config.celery", "worker", "-l", "info", "-Q", "imports,exports,reports,rag_indexing,integrations", "-c", "2", "--max-tasks-per-child", "100"]
      cpu     = var.worker_cpu
      memory  = var.worker_memory
      secrets = local.worker_heavy_secrets
    }
  }
}

# ---------------------------------------------------------------------------
# Task definitions
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "api"
      image                  = local.api_image
      essential              = true
      portMappings           = [{ containerPort = 8000, protocol = "tcp" }]
      environment            = local.api_environment
      secrets                = local.api_secrets
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_mount
      linuxParameters        = { initProcessEnabled = true }
      stopTimeout            = 30
      healthCheck            = local.api_health_check
      logConfiguration       = local.log_config["api"]
    },
  ])

  tags = { Name = "${local.name}-api" }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  # The web tier holds no AWS credentials; a role with no policy is attached
  # so the task never inherits anything by default.
  task_role_arn = aws_iam_role.web_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  # Next.js image optimiser / ISR write under .next/cache.
  volume {
    name = "next-cache"
  }

  container_definitions = jsonencode([
    {
      name                   = "web"
      image                  = local.web_image
      essential              = true
      portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
      environment            = local.web_environment
      readonlyRootFilesystem = true
      mountPoints = concat(local.tmp_mount, [
        { sourceVolume = "next-cache", containerPath = "/app/.next/cache", readOnly = false },
      ])
      linuxParameters  = { initProcessEnabled = true }
      stopTimeout      = 30
      healthCheck      = local.web_health_check
      logConfiguration = local.log_config["web"]
    },
  ])

  tags = { Name = "${local.name}-web" }
}

resource "aws_ecs_task_definition" "worker" {
  for_each = local.workers

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = each.key
      image                  = local.api_image
      essential              = true
      command                = each.value.command
      environment            = local.api_environment
      secrets                = each.value.secrets
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_mount
      linuxParameters        = { initProcessEnabled = true }
      # Celery warm shutdown: finish in-flight tasks before SIGKILL.
      stopTimeout      = 120
      logConfiguration = local.log_config[each.key]
    },
  ])

  tags = { Name = "${local.name}-${each.key}" }
}

resource "aws_ecs_task_definition" "beat" {
  family                   = "${local.name}-beat"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.beat_cpu
  memory                   = var.beat_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "beat"
      image                  = local.api_image
      essential              = true
      command                = ["celery", "-A", "config.celery", "beat", "-l", "info", "--scheduler", "django_celery_beat.schedulers:DatabaseScheduler"]
      environment            = local.api_environment
      secrets                = local.beat_secrets
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_mount
      linuxParameters        = { initProcessEnabled = true }
      stopTimeout            = 120
      logConfiguration       = local.log_config["beat"]
    },
  ])

  tags = { Name = "${local.name}-beat" }
}

# One-off migration task. Not a service: the deploy pipeline runs
#   aws ecs run-task --cluster <cluster> --task-definition <family> \
#     --launch-type FARGATE --network-configuration ...
# and waits for exit code 0 before rolling the api/worker services.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.migrate_cpu
  memory                   = var.migrate_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "migrate"
      image                  = local.api_image
      essential              = true
      command                = ["python", "manage.py", "migrate", "--no-input"]
      environment            = local.api_environment
      secrets                = local.migrate_secrets
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_mount
      linuxParameters        = { initProcessEnabled = true }
      stopTimeout            = 120
      logConfiguration       = local.log_config["migrate"]
    },
  ])

  tags = { Name = "${local.name}-migrate" }
}

# ---------------------------------------------------------------------------
# Services
#
# `lifecycle.ignore_changes = [task_definition, desired_count]`: CI registers
# new task definition revisions and calls UpdateService, and Application Auto
# Scaling moves desired_count. Terraform must not revert either on its next
# apply; it only owns the service's shape (network, deployment policy, LB).
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  wait_for_steady_state              = false
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.service["api"].id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8000
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener_rule.api]

  tags = { Name = "${local.name}-api" }
}

resource "aws_ecs_service" "web" {
  name            = "${local.name}-web"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"

  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  wait_for_steady_state              = false
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.service["web"].id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener_rule.web]

  tags = { Name = "${local.name}-web" }
}

resource "aws_ecs_service" "worker_critical" {
  name            = "${local.name}-worker-critical"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker["worker-critical"].arn
  desired_count   = var.worker_critical_min_capacity
  launch_type     = "FARGATE"

  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  wait_for_steady_state              = false
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.service["worker-critical"].id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = { Name = "${local.name}-worker-critical" }
}

# worker-heavy runs imports/exports/reports: idempotent, retried, latency
# tolerant. One task is always on-demand FARGATE so the queues never stall if
# Spot capacity is reclaimed; every additional task prefers FARGATE_SPOT
# (roughly 70% cheaper). Interrupted Spot tasks get SIGTERM + 120s to finish
# the current job (stopTimeout), and Celery acks late so unfinished jobs are
# redelivered.
resource "aws_ecs_service" "worker_heavy" {
  name            = "${local.name}-worker-heavy"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker["worker-heavy"].arn
  desired_count   = var.worker_heavy_min_capacity

  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  wait_for_steady_state              = false
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 0
  }

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    base              = 0
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.service["worker-heavy"].id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_ecs_cluster_capacity_providers.this]

  tags = { Name = "${local.name}-worker-heavy" }
}

# beat must be a singleton: two schedulers would double-fire every periodic
# task. Deployments therefore stop the old task before starting the new one
# (min 0% / max 100%); periodic tasks are delayed by a few seconds during a
# rollout instead of duplicated. No autoscaling target is attached.
resource "aws_ecs_service" "beat" {
  name            = "${local.name}-beat"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.beat.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  wait_for_steady_state              = false
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.service["beat"].id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = { Name = "${local.name}-beat" }
}
