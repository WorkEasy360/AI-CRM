data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name       = "${var.project}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  common_tags = merge(
    {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )

  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # Image URIs default to the ECR repositories created in ecr.tf.
  api_image = coalesce(var.api_image, "${aws_ecr_repository.api.repository_url}:${var.image_tag}")
  web_image = coalesce(var.web_image, "${aws_ecr_repository.web.repository_url}:${var.image_tag}")

  metrics_namespace = "Keel"

  celery_queues = ["default", "notifications", "imports", "exports", "reports"]
}
