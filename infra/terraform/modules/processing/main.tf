variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }

# Lambda execution role
resource "aws_iam_role" "lambda_role" {
  name = "idp-${var.environment}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_permissions" {
  name = "idp-${var.environment}-lambda-permissions"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = ["arn:aws:s3:::idp-${var.environment}-*", "arn:aws:s3:::idp-${var.environment}-*/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = ["*"]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage"]
        Resource = ["*"]
      },
      {
        Effect   = "Allow"
        Action   = ["states:SendTaskSuccess", "states:SendTaskFailure"]
        Resource = ["*"]
      }
    ]
  })
}

# Lambda security group
resource "aws_security_group" "lambda_sg" {
  name_prefix = "idp-${var.environment}-lambda-"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "idp-${var.environment}-lambda" }
}

# Lambda functions
locals {
  lambda_functions = {
    decomposition    = { timeout = 60,  memory = 512 }
    quality-check    = { timeout = 30,  memory = 1024 }
    classification   = { timeout = 60,  memory = 1024 }
    data-extraction  = { timeout = 120, memory = 1024 }
    fraud-check      = { timeout = 60,  memory = 512 }
    send-feedback    = { timeout = 10,  memory = 256 }
    mark-complete    = { timeout = 30,  memory = 256 }
    mark-rejected    = { timeout = 10,  memory = 256 }
  }
}

# Step Functions execution role
resource "aws_iam_role" "sfn_role" {
  name = "idp-${var.environment}-sfn-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "states.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "sfn_permissions" {
  name = "idp-${var.environment}-sfn-permissions"
  role = aws_iam_role.sfn_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = ["arn:aws:lambda:*:*:function:idp-${var.environment}-*"]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = ["*"]
      }
    ]
  })
}

# SQS Queues
resource "aws_sqs_queue" "hitl_queue" {
  name                       = "idp-${var.environment}-hitl-queue"
  visibility_timeout_seconds = 900
  message_retention_seconds  = 1209600  # 14 days

  tags = { Name = "idp-${var.environment}-hitl-queue" }
}

resource "aws_sqs_queue" "fraud_review_queue" {
  name                       = "idp-${var.environment}-fraud-review-queue"
  visibility_timeout_seconds = 900
  message_retention_seconds  = 1209600

  tags = { Name = "idp-${var.environment}-fraud-review-queue" }
}

output "lambda_role_arn" { value = aws_iam_role.lambda_role.arn }
output "sfn_role_arn" { value = aws_iam_role.sfn_role.arn }
output "hitl_queue_url" { value = aws_sqs_queue.hitl_queue.url }
output "fraud_queue_url" { value = aws_sqs_queue.fraud_review_queue.url }
