output "alb_dns_name" {
  description = "ALB DNS name (CloudFront origin; not meant to be hit directly)."
  value       = aws_lb.this.dns_name
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain. Point the Route 53 alias for app_domain here."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "cloudfront_hosted_zone_id" {
  description = "CloudFront hosted zone id for the Route 53 alias record."
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}

output "private_bucket" {
  description = "Private storage bucket (imports/exports)."
  value       = aws_s3_bucket.private.id
}

output "alb_logs_bucket" {
  description = "ALB access log bucket."
  value       = aws_s3_bucket.alb_logs.id
}

output "ecr_api_url" {
  description = "ECR repository URL for the api/worker image."
  value       = aws_ecr_repository.api.repository_url
}

output "ecr_web_url" {
  description = "ECR repository URL for the web image."
  value       = aws_ecr_repository.web.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "ecs_service_names" {
  description = "ECS service names keyed by role."
  value       = local.ecs_services
}

output "migrate_task_family" {
  description = "Task definition family for the one-off migrate task (aws ecs run-task)."
  value       = aws_ecs_task_definition.migrate.family
}

output "task_subnet_ids" {
  description = "Private app subnet ids for `aws ecs run-task --network-configuration`."
  value       = aws_subnet.app[*].id
}

output "worker_security_group_id" {
  description = "Security group for worker/migrate tasks (used by `aws ecs run-task`)."
  value       = aws_security_group.worker.id
}

output "secret_arns" {
  description = "Secrets Manager secret ARNs (values are never output)."
  value = {
    SECRET_KEY        = aws_secretsmanager_secret.secret_key.arn
    DATABASE_URL      = aws_secretsmanager_secret.database_url.arn
    EMAIL_URL         = aws_secretsmanager_secret.email_url.arn
    REDIS_URL         = aws_secretsmanager_secret.redis_url.arn
    CELERY_BROKER_URL = aws_secretsmanager_secret.celery_broker_url.arn
    ORIGIN_VERIFY     = aws_secretsmanager_secret.origin_verify.arn
    RDS_MASTER        = aws_db_instance.this.master_user_secret[0].secret_arn
  }
}

output "deploy_role_arn" {
  description = "IAM role assumed by GitHub Actions through OIDC."
  value       = aws_iam_role.deploy.arn
}

output "rds_endpoint" {
  description = "RDS instance endpoint (host:port)."
  value       = aws_db_instance.this.endpoint
}

output "rds_proxy_endpoint" {
  description = "RDS Proxy endpoint, null when enable_rds_proxy = false."
  value       = var.enable_rds_proxy ? aws_db_proxy.this[0].endpoint : null
}

output "redis_primary_endpoint" {
  description = "ElastiCache primary endpoint."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "alarm_topic_arn" {
  description = "SNS topic receiving CloudWatch alarms (regional)."
  value       = aws_sns_topic.alarms.arn
}
