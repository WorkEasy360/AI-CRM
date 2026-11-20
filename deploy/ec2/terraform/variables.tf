variable "aws_region" {
  description = "Region of the Keel EC2 host and its SSM parameters (the repository variable AWS_REGION)."
  type        = string
}

variable "api_repository_name" {
  description = "ECR repository for the API image. deploy.yml pushes to this name (env API_ECR_REPOSITORY)."
  type        = string
  default     = "workeasy360/ai-crm-api"
}

variable "deploy_role_name" {
  description = "The GitHub OIDC deploy role (deploy/ec2/iam/KeelCrmGithubDeploy*.json), the last part of the repository variable AWS_DEPLOY_ROLE_ARN. It gets push access to the API repository."
  type        = string
  default     = "KeelCrmGithubDeploy"
}

variable "instance_role_name" {
  description = "The Keel EC2 instance role (deploy/ec2/iam/KeelCrmEc2Role-inline.json). It gets pull access to the API repository."
  type        = string
  default     = "KeelCrmEc2Role"
}

variable "ssm_prefix" {
  description = "SSM Parameter Store path the host reads its settings from (bin/keel-deploy PREFIX)."
  type        = string
  default     = "/keel/production"
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for the repository. null uses the AWS-managed key aws/ecr. Changing it replaces the repository."
  type        = string
  default     = null
}

variable "images_to_keep" {
  description = "Tagged API images kept for rollback (one per deploy); older ones expire."
  type        = number
  default     = 30

  validation {
    condition     = var.images_to_keep >= 5
    error_message = "Keep at least 5 images: rollback deploys the previous release's image by its tag."
  }
}
