# Remote state.
#
# Create the state bucket and lock table by hand (see README, "Bootstrap") before
# enabling this block, then run `terraform init -migrate-state`. The bucket must have
# versioning and SSE enabled and block all public access. Keep the block commented
# until the bootstrap resources exist so `terraform init -backend=false` keeps working
# in CI validation.
#
# terraform {
#   backend "s3" {
#     bucket         = "<STATE_BUCKET_NAME>"            # e.g. keel-terraform-state-<account-alias>
#     key            = "keel/production/terraform.tfstate"
#     region         = "ap-south-1"
#     dynamodb_table = "<LOCK_TABLE_NAME>"              # e.g. keel-terraform-locks (PK: LockID, string)
#     encrypt        = true
#     kms_key_id     = "<OPTIONAL_STATE_KMS_KEY_ARN>"   # omit to use SSE-S3
#   }
# }
