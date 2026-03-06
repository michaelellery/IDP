###############################################################################
# outputs.tf — Key Resource ARNs and Endpoints
###############################################################################

output "vpc_id" { value = aws_vpc.main.id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "aurora_cluster_endpoint" { value = aws_rds_cluster.main.endpoint }
output "aurora_cluster_arn" { value = aws_rds_cluster.main.arn }
output "intake_bucket_name" { value = aws_s3_bucket.intake.id }
output "documents_bucket_name" { value = aws_s3_bucket.documents.id }
output "lambda_function_arns" { value = { for k, fn in aws_lambda_function.functions : k => fn.arn } }
output "state_machine_arn" { value = aws_sfn_state_machine.pipeline.arn }
output "hitl_queue_url" { value = aws_sqs_queue.hitl.url }
output "fraud_review_queue_url" { value = aws_sqs_queue.fraud_review.url }
output "event_bus_arn" { value = aws_cloudwatch_event_bus.main.arn }
output "api_endpoint" { value = aws_apigatewayv2_api.main.api_endpoint }
output "api_id" { value = aws_apigatewayv2_api.main.id }
output "db_credentials_secret_arn" { value = aws_secretsmanager_secret.db_credentials.arn }
output "anthropic_secret_arn" { value = aws_secretsmanager_secret.anthropic_api_key.arn }
output "lambda_role_arn" { value = aws_iam_role.lambda.arn }
output "sfn_role_arn" { value = aws_iam_role.sfn.arn }
