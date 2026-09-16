# ---------------------------------------------------------------------------
# Customer-managed KMS key: RDS storage, S3 private bucket, Secrets Manager,
# RDS master secret, Performance Insights.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "kms" {
  # Account root retains full control so IAM policies can grant usage.
  statement {
    sid       = "EnableRootAndIAMPolicies"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  # Services that use the key on the account's behalf (grants for RDS, S3
  # bucket keys, Secrets Manager).
  statement {
    sid    = "AllowServiceUse"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      "kms:CreateGrant",
      "kms:ListGrants",
      "kms:RevokeGrant",
    ]
    resources = ["*"]
    principals {
      type = "Service"
      identifiers = [
        "rds.amazonaws.com",
        "s3.amazonaws.com",
        "secretsmanager.amazonaws.com",
      ]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "${local.name}: RDS, S3, Secrets Manager"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json

  tags = { Name = "${local.name}-cmk" }
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.this.key_id
}

# ---------------------------------------------------------------------------
# Generated secrets
# ---------------------------------------------------------------------------

resource "random_password" "django_secret_key" {
  length           = 64
  special          = true
  override_special = "!#%^&*()-_=+[]{}<>?"
}

resource "random_password" "redis_auth" {
  # ElastiCache AUTH tokens: 16-128 printable ASCII chars, no '/', '"', '@' or spaces.
  length  = 64
  special = false
}

resource "random_password" "origin_verify" {
  length  = 32
  special = false
}

# ---------------------------------------------------------------------------
# Secrets Manager
#
# Names are stable ("keel-production/NAME") so the deploy role and execution
# role can be scoped by ARN. A short recovery window keeps re-creation during
# initial bring-up painless; raise to 30 once the stack is stable.
# ---------------------------------------------------------------------------

locals {
  secret_recovery_window_days = 7
  redis_host                  = aws_elasticache_replication_group.this.primary_endpoint_address
}

resource "aws_secretsmanager_secret" "secret_key" {
  name                    = "${local.name}/SECRET_KEY"
  description             = "Django SECRET_KEY"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "secret_key" {
  secret_id     = aws_secretsmanager_secret.secret_key.id
  secret_string = random_password.django_secret_key.result
}

# DATABASE_URL is deliberately NOT derived from the RDS master credentials.
# The app runs as the `crm_app` role (no DDL, no RLS bypass), created by
# infra/postgres/prod-roles.sql. After running that script, operators store
#   postgresql://crm_app:<password>@<rds_endpoint or proxy endpoint>:5432/keel
# in this secret (see README). Terraform ignores later changes to the value.
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${local.name}/DATABASE_URL"
  description             = "PostgreSQL URL for the crm_app role (filled by operators)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# EMAIL_URL (e.g. smtp+tls://user:pass@email-smtp.ap-south-1.amazonaws.com:587)
resource "aws_secretsmanager_secret" "email_url" {
  name                    = "${local.name}/EMAIL_URL"
  description             = "Email backend URL (filled by operators)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "email_url" {
  secret_id     = aws_secretsmanager_secret.email_url.id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Redis URLs are composed from the ElastiCache primary endpoint and the
# generated AUTH token. DB 0 = cache/sessions, DB 1 = Celery broker.
resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${local.name}/REDIS_URL"
  description             = "Redis URL (cache, sessions, rate limits)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "rediss://:${random_password.redis_auth.result}@${local.redis_host}:6379/0"
}

resource "aws_secretsmanager_secret" "celery_broker_url" {
  name                    = "${local.name}/CELERY_BROKER_URL"
  description             = "Celery broker URL"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "celery_broker_url" {
  secret_id     = aws_secretsmanager_secret.celery_broker_url.id
  secret_string = "rediss://:${random_password.redis_auth.result}@${local.redis_host}:6379/1"
}

# Shared secret between CloudFront and the ALB listener rules. Kept in Secrets
# Manager for operators; the value itself is wired into both sides by Terraform.
resource "aws_secretsmanager_secret" "origin_verify" {
  name                    = "${local.name}/ORIGIN_VERIFY"
  description             = "X-Origin-Verify header value injected by CloudFront"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "origin_verify" {
  secret_id     = aws_secretsmanager_secret.origin_verify.id
  secret_string = random_password.origin_verify.result
}

# ---------------------------------------------------------------------------
# MESSAGING_ENCRYPTION_KEYS -- REQUIRED TO BOOT
#
# Fernet keys for provider tokens at rest (OAuth refresh tokens, WhatsApp access
# tokens). config.settings.prod raises at import time when this is empty, so every
# Django task -- api, workers, beat and the one-off migrate task -- fails to start
# without it. It is therefore generated here rather than left as a placeholder: an
# unfilled placeholder would boot and then fail on the first mailbox connection,
# because apps.core.crypto validates the key lazily.
#
# Format (apps/core/crypto.py): comma-separated urlsafe-base64 32-byte keys, the
# first encrypts and every key may decrypt. Rotation is "prepend the new key,
# re-encrypt lazily, drop the old one later" and is performed directly in Secrets
# Manager -- ignore_changes keeps Terraform from reverting it.
#
# random_bytes emits standard base64; Fernet requires the urlsafe alphabet, so the
# two differing characters are translated. The byte value is unchanged.
# ---------------------------------------------------------------------------

resource "random_bytes" "messaging_encryption_key" {
  length = 32
}

resource "aws_secretsmanager_secret" "messaging_encryption_keys" {
  name                    = "${local.name}/MESSAGING_ENCRYPTION_KEYS"
  description             = "Fernet key ring for stored provider tokens (required to boot; rotate in place)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "messaging_encryption_keys" {
  secret_id     = aws_secretsmanager_secret.messaging_encryption_keys.id
  secret_string = replace(replace(random_bytes.messaging_encryption_key.base64, "+", "-"), "/", "_")

  lifecycle {
    ignore_changes = [secret_string] # rotation happens in Secrets Manager, not here
  }
}

# ---------------------------------------------------------------------------
# OPTIONAL FEATURE SECRETS
#
# Created only when the matching feature flag is on (see variables.tf). Values are
# placeholders filled by operators out of band; Terraform never stores the real
# credential. While a feature is off the application reports it as "not configured"
# and the rest of the CRM is unaffected.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  count                   = var.enable_ai_provider ? 1 : 0
  name                    = "${local.name}/ANTHROPIC_API_KEY"
  description             = "Anthropic API key (optional; absent = assistant answers retrieval-only)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "anthropic_api_key" {
  count         = var.enable_ai_provider ? 1 : 0
  secret_id     = aws_secretsmanager_secret.anthropic_api_key[0].id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "whatsapp_app_secret" {
  count                   = var.enable_whatsapp ? 1 : 0
  name                    = "${local.name}/WHATSAPP_APP_SECRET"
  description             = "Meta app secret; verifies X-Hub-Signature-256 on the inbound webhook"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "whatsapp_app_secret" {
  count         = var.enable_whatsapp ? 1 : 0
  secret_id     = aws_secretsmanager_secret.whatsapp_app_secret[0].id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "whatsapp_verify_token" {
  count                   = var.enable_whatsapp ? 1 : 0
  name                    = "${local.name}/WHATSAPP_VERIFY_TOKEN"
  description             = "Token echoed during Meta's webhook verification handshake"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "whatsapp_verify_token" {
  count         = var.enable_whatsapp ? 1 : 0
  secret_id     = aws_secretsmanager_secret.whatsapp_verify_token[0].id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Mailbox OAuth client credentials. The client ids are not secret, but they are kept
# beside their secrets so a deployment configures one coherent thing.
locals {
  email_oauth_secret_names = var.enable_email_oauth ? [
    "EMAIL_OAUTH_GOOGLE_CLIENT_ID",
    "EMAIL_OAUTH_GOOGLE_CLIENT_SECRET",
    "EMAIL_OAUTH_MICROSOFT_CLIENT_ID",
    "EMAIL_OAUTH_MICROSOFT_CLIENT_SECRET",
  ] : []
}

resource "aws_secretsmanager_secret" "email_oauth" {
  for_each                = toset(local.email_oauth_secret_names)
  name                    = "${local.name}/${each.key}"
  description             = "Mailbox OAuth credential ${each.key} (filled by operators)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "email_oauth" {
  for_each      = aws_secretsmanager_secret.email_oauth
  secret_id     = each.value.id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

locals {
  # Secret injection per service, least privilege: a task definition receives only the
  # secrets that service actually reads.
  #
  #   MESSAGING_ENCRYPTION_KEYS  every Django process (required to boot)
  #   ANTHROPIC_API_KEY          api only        -- no Celery task calls the model
  #   WHATSAPP_APP_SECRET/TOKEN  api only        -- inbound webhook signature check
  #   EMAIL_OAUTH_*              api + worker-critical -- connect flow, then token refresh
  #                                                       and send/sync on default+notifications
  boot_secrets = [
    { name = "MESSAGING_ENCRYPTION_KEYS", valueFrom = aws_secretsmanager_secret.messaging_encryption_keys.arn },
  ]

  ai_secrets = var.enable_ai_provider ? [
    { name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.anthropic_api_key[0].arn },
  ] : []

  whatsapp_secrets = var.enable_whatsapp ? [
    { name = "WHATSAPP_APP_SECRET", valueFrom = aws_secretsmanager_secret.whatsapp_app_secret[0].arn },
    { name = "WHATSAPP_VERIFY_TOKEN", valueFrom = aws_secretsmanager_secret.whatsapp_verify_token[0].arn },
  ] : []

  email_oauth_secrets = [
    for name in local.email_oauth_secret_names :
    { name = name, valueFrom = aws_secretsmanager_secret.email_oauth[name].arn }
  ]

  # Secrets the ECS execution role may read (api + workers).
  app_secret_arns = concat([
    aws_secretsmanager_secret.secret_key.arn,
    aws_secretsmanager_secret.database_url.arn,
    aws_secretsmanager_secret.email_url.arn,
    aws_secretsmanager_secret.redis_url.arn,
    aws_secretsmanager_secret.celery_broker_url.arn,
    aws_secretsmanager_secret.messaging_encryption_keys.arn,
    ],
    var.enable_ai_provider ? [aws_secretsmanager_secret.anthropic_api_key[0].arn] : [],
    var.enable_whatsapp ? [
      aws_secretsmanager_secret.whatsapp_app_secret[0].arn,
      aws_secretsmanager_secret.whatsapp_verify_token[0].arn,
    ] : [],
    [for name in local.email_oauth_secret_names : aws_secretsmanager_secret.email_oauth[name].arn],
  )
}
