output "microvm_artifact_bucket" {
  description = "Private S3 bucket used by Lambda MicroVM image builds."
  value       = aws_s3_bucket.artifacts.bucket
}

output "microvm_build_role_arn" {
  description = "Role Lambda assumes to build the MicroVM image."
  value       = aws_iam_role.microvm_build.arn
}

output "microvm_build_log_group" {
  description = "CloudWatch log group for MicroVM image build logs."
  value       = aws_cloudwatch_log_group.microvm_build.name
}

output "workshop_url" {
  description = "HTTPS URL for the deployed Slidev workshop."
  value       = var.deploy_workshop ? "https://${aws_cloudfront_distribution.site[0].domain_name}" : null
}

output "active_session_table" {
  description = "DynamoDB table holding attendee-to-MicroVM mappings."
  value       = var.deploy_workshop ? aws_dynamodb_table.sessions[0].name : null
}
