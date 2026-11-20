output "api_repository_url" {
  description = "Push and pull the API image as <this>:<commit sha>. Also stored in SSM as API_IMAGE_REPOSITORY."
  value       = aws_ecr_repository.api.repository_url
}

output "api_repository_arn" {
  description = "ARN of the API image repository."
  value       = aws_ecr_repository.api.arn
}

output "registry" {
  description = "Registry host, for `aws ecr get-login-password | docker login --username AWS --password-stdin <registry>`."
  value       = split("/", aws_ecr_repository.api.repository_url)[0]
}
