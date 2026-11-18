# State. This module holds no secret values (names, ARNs and the repository URL), so local state works for a single
# operator: keep terraform.tfstate safe (it is git-ignored). To share it, store it next to infra/terraform's state
# (infra/terraform/README.md, "Bootstrap"), uncomment this block and run `terraform init -migrate-state`. Keep it
# commented until then, so `terraform init -backend=false` keeps working in CI validation.
#
# terraform {
#   backend "s3" {
#     bucket         = "<STATE_BUCKET_NAME>"
#     key            = "keel/ec2-production/registry.tfstate"
#     region         = "<REGION>"
#     dynamodb_table = "<LOCK_TABLE_NAME>"
#     encrypt        = true
#   }
# }
