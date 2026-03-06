###############################################################################
# sqs.tf — SQS Queues (HITL, Fraud Review, DLQs)
###############################################################################

resource "aws_sqs_queue" "hitl_dlq" {
  name                      = "${local.name_prefix}-hitl-dlq"
  message_retention_seconds = 1209600
  tags = { Name = "${local.name_prefix}-hitl-dlq" }
}

resource "aws_sqs_queue" "fraud_review_dlq" {
  name                      = "${local.name_prefix}-fraud-review-dlq"
  message_retention_seconds = 1209600
  tags = { Name = "${local.name_prefix}-fraud-review-dlq" }
}

resource "aws_sqs_queue" "hitl" {
  name                       = "${local.name_prefix}-hitl-queue"
  visibility_timeout_seconds = 900
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.hitl_dlq.arn
    maxReceiveCount     = 3
  })
  tags = { Name = "${local.name_prefix}-hitl-queue" }
}

resource "aws_sqs_queue" "fraud_review" {
  name                       = "${local.name_prefix}-fraud-review-queue"
  visibility_timeout_seconds = 900
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.fraud_review_dlq.arn
    maxReceiveCount     = 3
  })
  tags = { Name = "${local.name_prefix}-fraud-review-queue" }
}
