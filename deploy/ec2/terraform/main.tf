# Private distribution of the Keel API image for the single EC2 host (deploy/ec2/README.md, "Private API image").
#
# The API image carries WorkEasy360's private sign-in connector (docs/workeasy360-sso.md), so it must not sit in a
# public registry. This module creates one private ECR repository and lets exactly two IAM roles use it:
#
#   GitHub deploy role (OIDC, no stored keys)  --push-->  ECR <account>.dkr.ecr.<region>.amazonaws.com/<name>
#   Keel EC2 instance role (instance profile)  --pull-->  same repository, by the commit SHA tag (immutable)
#
# Both roles already exist (created from deploy/ec2/iam/*.json); this module only adds one inline policy to each, and
# records the repository URL in SSM for bin/keel-deploy. There is no repository policy, so no other account and no
# anonymous caller can reach it. The web image carries no private code and stays on GHCR.
#
# The ECS/Fargate design in infra/terraform has its own repositories; nothing here touches it.

data "aws_iam_role" "deploy" {
  name = var.deploy_role_name
}

data "aws_iam_role" "instance" {
  name = var.instance_role_name
}

resource "aws_ecr_repository" "api" {
  name = var.api_repository_name
  # A tag is a commit SHA and names exactly one image forever: no push can replace what a deploy or a rollback pulls.
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Untagged images (an interrupted push) expire after a day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the images of the last ${var.images_to_keep} deploys for rollback"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.images_to_keep
        }
        action = { type = "expire" }
      },
    ]
  })
}

# --- the deploy role pushes (deploy.yml, job "images") -----------------------------------------------------------

data "aws_iam_policy_document" "push" {
  statement {
    sid       = "RegistryLogin"
    actions   = ["ecr:GetAuthorizationToken"] # account-wide by design: no resource-level permission exists
    resources = ["*"]
  }

  statement {
    sid = "PushTheApiImageOnly"
    actions = [
      "ecr:DescribeRepositories",
      "ecr:DescribeImages",
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = [aws_ecr_repository.api.arn]
  }
}

resource "aws_iam_role_policy" "deploy_push" {
  name   = "KeelCrmApiImagePush"
  role   = data.aws_iam_role.deploy.name
  policy = data.aws_iam_policy_document.push.json
}

# --- the instance role pulls (bin/keel-deploy) -------------------------------------------------------------------

data "aws_iam_policy_document" "pull" {
  statement {
    sid       = "RegistryLogin"
    actions   = ["ecr:GetAuthorizationToken"] # account-wide by design: no resource-level permission exists
    resources = ["*"]
  }

  statement {
    sid = "PullTheApiImageOnly"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.api.arn]
  }
}

resource "aws_iam_role_policy" "instance_pull" {
  name   = "KeelCrmApiImagePull"
  role   = data.aws_iam_role.instance.name
  policy = data.aws_iam_policy_document.pull.json
}

# --- where the host finds the repository --------------------------------------------------------------------------

# bin/keel-deploy reads this (the instance role may read /keel/production/*) and refuses any value that is not an ECR
# repository of its own account and region. Not a secret.
resource "aws_ssm_parameter" "api_image_repository" {
  name        = "${var.ssm_prefix}/API_IMAGE_REPOSITORY"
  description = "Private ECR repository of the Keel API image (deploy/ec2/terraform)"
  type        = "String"
  tier        = "Standard"
  value       = aws_ecr_repository.api.repository_url
}
