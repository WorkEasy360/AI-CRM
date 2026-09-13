# ---------------------------------------------------------------------------
# Naming / global
# ---------------------------------------------------------------------------

variable "project" {
  description = "Short project slug used as a prefix for every resource name."
  type        = string
  default     = "keel"
}

variable "environment" {
  description = "Deployment environment name (production, staging, ...)."
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "AWS region for all regional resources. CloudFront/WAF resources always use us-east-1."
  type        = string
  default     = "ap-south-1"
}

variable "app_domain" {
  description = "Public hostname served by CloudFront (e.g. app.example.com). Used for ALLOWED_HOSTS, CSRF origins and the CloudFront alias."
  type        = string
}

variable "acm_certificate_arn_alb" {
  description = "ARN of an ACM certificate in var.aws_region covering app_domain, attached to the ALB HTTPS listener."
  type        = string
}

variable "acm_certificate_arn_cloudfront" {
  description = "ARN of an ACM certificate in us-east-1 covering app_domain, used as the CloudFront viewer certificate."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:acm:us-east-1:", var.acm_certificate_arn_cloudfront))
    error_message = "The CloudFront certificate must be issued in us-east-1."
  }
}

variable "tags" {
  description = "Additional tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "deletion_protection" {
  description = "Enable deletion protection on the ALB and RDS instance. Keep true in production."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block of the VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones to spread subnets across."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4."
  }
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway for all private subnets (cheaper) instead of one per AZ (more resilient)."
  type        = bool
  default     = true
}

variable "enable_vpc_endpoints" {
  description = "Create S3 gateway + interface endpoints (ECR, Logs, Secrets Manager, CloudWatch) so task traffic to AWS APIs bypasses the NAT gateway."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Container images
# ---------------------------------------------------------------------------

variable "image_tag" {
  description = "Image tag deployed by the initial apply. CI rolls new task definitions afterwards; Terraform ignores those changes."
  type        = string
  default     = "latest"
}

variable "api_image" {
  description = "Full image URI for the API/worker containers. Defaults to the ECR repository created by this module with var.image_tag."
  type        = string
  default     = null
}

variable "web_image" {
  description = "Full image URI for the Next.js container. Defaults to the ECR repository created by this module with var.image_tag."
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------
# Task sizing
# ---------------------------------------------------------------------------

variable "api_cpu" {
  description = "Fargate CPU units for the api task (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "api_memory" {
  description = "Fargate memory (MiB) for the api task."
  type        = number
  default     = 2048
}

variable "web_cpu" {
  description = "Fargate CPU units for the web task."
  type        = number
  default     = 512
}

variable "web_memory" {
  description = "Fargate memory (MiB) for the web task."
  type        = number
  default     = 1024
}

variable "worker_cpu" {
  description = "Fargate CPU units for each Celery worker task."
  type        = number
  default     = 1024
}

variable "worker_memory" {
  description = "Fargate memory (MiB) for each Celery worker task."
  type        = number
  default     = 2048
}

variable "beat_cpu" {
  description = "Fargate CPU units for the Celery beat task."
  type        = number
  default     = 256
}

variable "beat_memory" {
  description = "Fargate memory (MiB) for the Celery beat task."
  type        = number
  default     = 512
}

variable "migrate_cpu" {
  description = "Fargate CPU units for the one-off migrate task."
  type        = number
  default     = 512
}

variable "migrate_memory" {
  description = "Fargate memory (MiB) for the one-off migrate task."
  type        = number
  default     = 1024
}

variable "gunicorn_workers" {
  description = "GUNICORN_WORKERS for the api container."
  type        = number
  default     = 2
}

variable "gunicorn_threads" {
  description = "GUNICORN_THREADS for the api container."
  type        = number
  default     = 4
}

# ---------------------------------------------------------------------------
# Service capacities
# ---------------------------------------------------------------------------

variable "api_min_capacity" {
  description = "Minimum api tasks."
  type        = number
  default     = 2
}

variable "api_desired_count" {
  description = "Initial api task count (autoscaling owns it afterwards)."
  type        = number
  default     = 2
}

variable "api_max_capacity" {
  description = "Maximum api tasks."
  type        = number
  default     = 6
}

variable "web_min_capacity" {
  description = "Minimum web tasks."
  type        = number
  default     = 2
}

variable "web_desired_count" {
  description = "Initial web task count."
  type        = number
  default     = 2
}

variable "web_max_capacity" {
  description = "Maximum web tasks."
  type        = number
  default     = 4
}

variable "worker_critical_min_capacity" {
  description = "Minimum worker-critical tasks (queues default, notifications)."
  type        = number
  default     = 1
}

variable "worker_critical_max_capacity" {
  description = "Maximum worker-critical tasks."
  type        = number
  default     = 4
}

variable "worker_heavy_min_capacity" {
  description = "Minimum worker-heavy tasks (queues imports, exports, reports)."
  type        = number
  default     = 1
}

variable "worker_heavy_max_capacity" {
  description = "Maximum worker-heavy tasks."
  type        = number
  default     = 3
}

# ---------------------------------------------------------------------------
# Autoscaling targets
# ---------------------------------------------------------------------------

variable "alb_requests_per_target_api" {
  description = "Target ALBRequestCountPerTarget (per minute) for api target tracking."
  type        = number
  default     = 300
}

variable "alb_requests_per_target_web" {
  description = "Target ALBRequestCountPerTarget (per minute) for web target tracking."
  type        = number
  default     = 500
}

variable "cpu_target" {
  description = "Target average CPU utilisation (%) for api and web target tracking."
  type        = number
  default     = 60
}

# ---------------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage" {
  description = "Initial RDS storage (GiB)."
  type        = number
  default     = 50
}

variable "db_max_allocated_storage" {
  description = "Upper bound for RDS storage autoscaling (GiB)."
  type        = number
  default     = 200
}

variable "db_backup_retention_days" {
  description = "Automated backup / PITR retention in days (1-35)."
  type        = number
  default     = 14
}

variable "db_max_connections_alarm" {
  description = "Effective PostgreSQL max_connections for the instance class; the DatabaseConnections alarm fires at 80% of this value."
  type        = number
  default     = 400
}

variable "enable_rds_proxy" {
  description = "Create an RDS Proxy in front of the instance. Enable once the connection budget (tasks x gunicorn workers x threads + workers) exceeds ~60% of max_connections."
  type        = bool
  default     = false
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "keel"
}

# ---------------------------------------------------------------------------
# ElastiCache
# ---------------------------------------------------------------------------

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "redis_num_nodes" {
  description = "Number of cache nodes (1 primary + N-1 replicas). >1 enables Multi-AZ and automatic failover."
  type        = number
  default     = 2
}

# ---------------------------------------------------------------------------
# Observability
# ---------------------------------------------------------------------------

variable "log_retention_days" {
  description = "Retention for application, VPC flow and WAF log groups."
  type        = number
  default     = 30
}

variable "security_log_retention_days" {
  description = "Retention for the dedicated security log group."
  type        = number
  default     = 365
}

variable "alarm_email" {
  description = "Email address subscribed to the alarm SNS topic. Empty string disables the subscription."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Edge
# ---------------------------------------------------------------------------

variable "enable_waf_bot_control" {
  description = "Add the AWSManagedRulesBotControlRuleSet (common tier) to the web ACL. Adds ~USD 10/month + per-request cost."
  type        = bool
  default     = false
}

variable "cloudfront_price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_200"
}

# ---------------------------------------------------------------------------
# CI/CD
# ---------------------------------------------------------------------------

variable "github_repository" {
  description = "GitHub repository (org/repo) whose main branch may assume the deploy role through OIDC."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like org/repo."
  }
}
