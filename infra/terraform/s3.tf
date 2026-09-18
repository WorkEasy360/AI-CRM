# ---------------------------------------------------------------------------
# Private storage bucket (CSV import uploads, export files).
#
# Objects are short-lived by design: imports are consumed within minutes and
# exports are downloaded through signed URLs, so everything expires after 7
# days. Versioning is off on purpose (nothing here is a system of record).
# ---------------------------------------------------------------------------

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "private" {
  bucket = "${local.name}-private-${random_id.bucket_suffix.hex}"

  tags = { Name = "${local.name}-private" }
}

resource "aws_s3_bucket_public_access_block" "private" {
  bucket = aws_s3_bucket.private.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "private" {
  bucket = aws_s3_bucket.private.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "private" {
  bucket = aws_s3_bucket.private.id

  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "private" {
  bucket = aws_s3_bucket.private.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "private" {
  bucket = aws_s3_bucket.private.id

  # Only import uploads and export results expire. The bucket also holds email attachments and record
  # files, which are permanent; keys begin with the organization id, so the temporary objects are
  # selected by the tag apps.importexport.storage sets on them, never by prefix.
  rule {
    id     = "expire-import-export-files"
    status = "Enabled"

    filter {
      tag {
        key   = "retention"
        value = "temporary"
      }
    }

    expiration {
      days = 7
    }
  }

  # S3 does not allow this action in a tag-filtered rule; it only touches unfinished uploads.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "private_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.private.arn,
      "${aws_s3_bucket.private.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyUnencryptedObjectUploads"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.private.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DenyWrongKmsKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.private.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "private" {
  bucket = aws_s3_bucket.private.id
  policy = data.aws_iam_policy_document.private_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.private]
}

# ---------------------------------------------------------------------------
# ALB access logs bucket. ALB access logging only supports SSE-S3.
# ---------------------------------------------------------------------------

data "aws_elb_service_account" "this" {}

resource "aws_s3_bucket" "alb_logs" {
  bucket = "${local.name}-alb-logs-${random_id.bucket_suffix.hex}"

  tags = { Name = "${local.name}-alb-logs" }
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# ACCEPTED FINDING  AVD-AWS-0132 (aws-s3-encryption-customer-key)
#   Resource : aws_s3_bucket_server_side_encryption_configuration.alb_logs
#   Reason   : Elastic Load Balancing access-log delivery only supports SSE-S3 (AES256);
#              enabling SSE-KMS on this bucket makes the ALB fail to write logs. The private
#              CRM bucket above does use the project CMK and is not exempted.
#   Controls : Block Public Access on all four settings, BucketOwnerEnforced, TLS-only bucket
#              policy, PutObject limited to the regional ELB account / log-delivery service on
#              one prefix, 30-day expiry, no application access; logs contain no request bodies.
#   Owner    : Keel platform owner (staging readiness review, 2026-09-16).
#   Review   : expires 2027-09-16; re-check whether ELB log delivery has gained SSE-KMS support.
#trivy:ignore:AVD-AWS-0132:exp:2027-09-16
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    id     = "expire-alb-logs"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Regions with an ELB service account (ap-south-1 included) grant that
# principal PutObject; the delivery service principal statement covers newer
# regions as well.
data "aws_iam_policy_document" "alb_logs_bucket" {
  statement {
    sid       = "AllowELBAccountPutObject"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/alb/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.this.arn]
    }
  }

  statement {
    sid       = "AllowLogDeliveryPutObject"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/alb/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.alb_logs.arn,
      "${aws_s3_bucket.alb_logs.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = data.aws_iam_policy_document.alb_logs_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.alb_logs]
}
