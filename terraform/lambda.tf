###############################################################################
# lambda.tf — All Lambda Functions with IAM Roles
###############################################################################

locals {
  lambda_functions = {
    "s3-trigger" = {
      name    = "${local.name_prefix}-s3-trigger"
      handler = "index.handler"
      memory  = 256
      timeout = 30
      vpc     = false
      env = {
        STATE_MACHINE_ARN = aws_sfn_state_machine.pipeline.arn
      }
    }
    "decomposition" = {
      name    = "${local.name_prefix}-decomposition"
      handler = "index.handler"
      memory  = 512
      timeout = 60
      vpc     = true
      env = {
        S3_BUCKET = aws_s3_bucket.documents.id
        DB_HOST   = aws_rds_cluster.main.endpoint
        DB_PORT   = "5432"
        DB_NAME   = var.aurora_database_name
        DB_USER   = var.aurora_master_username
      }
    }
    "quality-check" = {
      name    = "${local.name_prefix}-quality-check"
      handler = "index.handler"
      memory  = 1024
      timeout = 30
      vpc     = true
      env     = { S3_BUCKET = aws_s3_bucket.documents.id }
    }
    "classification" = {
      name    = "${local.name_prefix}-classification"
      handler = "index.handler"
      memory  = 1024
      timeout = 60
      vpc     = true
      env = {
        S3_BUCKET        = aws_s3_bucket.documents.id
        ANTHROPIC_SECRET = aws_secretsmanager_secret.anthropic_api_key.arn
      }
    }
    "data-extraction" = {
      name    = "${local.name_prefix}-data-extraction"
      handler = "index.handler"
      memory  = 1024
      timeout = 120
      vpc     = true
      env = {
        S3_BUCKET        = aws_s3_bucket.documents.id
        DB_HOST          = aws_rds_cluster.main.endpoint
        DB_PORT          = "5432"
        DB_NAME          = var.aurora_database_name
        DB_USER          = var.aurora_master_username
        ANTHROPIC_SECRET = aws_secretsmanager_secret.anthropic_api_key.arn
      }
    }
    "fraud-check" = {
      name    = "${local.name_prefix}-fraud-check"
      handler = "index.handler"
      memory  = 512
      timeout = 60
      vpc     = true
      env     = { S3_BUCKET = aws_s3_bucket.documents.id }
    }
    "send-feedback" = {
      name    = "${local.name_prefix}-send-feedback"
      handler = "index.handler"
      memory  = 256
      timeout = 10
      vpc     = true
      env = {
        DB_HOST = aws_rds_cluster.main.endpoint
        DB_PORT = "5432"
        DB_NAME = var.aurora_database_name
        DB_USER = var.aurora_master_username
      }
    }
    "mark-rejected" = {
      name    = "${local.name_prefix}-mark-rejected"
      handler = "index.handler"
      memory  = 256
      timeout = 10
      vpc     = true
      env = {
        DB_HOST = aws_rds_cluster.main.endpoint
        DB_PORT = "5432"
        DB_NAME = var.aurora_database_name
        DB_USER = var.aurora_master_username
      }
    }
    "mark-complete" = {
      name    = "${local.name_prefix}-mark-complete"
      handler = "index.handler"
      memory  = 256
      timeout = 30
      vpc     = true
      env = {
        DB_HOST        = aws_rds_cluster.main.endpoint
        DB_PORT        = "5432"
        DB_NAME        = var.aurora_database_name
        DB_USER        = var.aurora_master_username
        EVENT_BUS_NAME = aws_cloudwatch_event_bus.main.name
      }
    }
    "handle-error" = {
      name    = "${local.name_prefix}-handle-error"
      handler = "index.handler"
      memory  = 256
      timeout = 10
      vpc     = true
      env = {
        DB_HOST        = aws_rds_cluster.main.endpoint
        DB_PORT        = "5432"
        DB_NAME        = var.aurora_database_name
        DB_USER        = var.aurora_master_username
        EVENT_BUS_NAME = aws_cloudwatch_event_bus.main.name
      }
    }
    "populate-db" = {
      name    = "${local.name_prefix}-populate-db"
      handler = "index.handler"
      memory  = 512
      timeout = 300
      vpc     = true
      env = {
        DB_HOST = aws_rds_cluster.main.endpoint
        DB_PORT = "5432"
        DB_NAME = var.aurora_database_name
        DB_USER = var.aurora_master_username
      }
    }
    "api" = {
      name    = "${local.name_prefix}-api"
      handler = "index.handler"
      memory  = 256
      timeout = 30
      vpc     = true
      env = {
        S3_BUCKET = aws_s3_bucket.documents.id
        DB_HOST   = aws_rds_cluster.main.endpoint
        DB_PORT   = "5432"
        DB_NAME   = var.aurora_database_name
        DB_USER   = var.aurora_master_username
      }
    }
  }
}

# ---------- IAM Role ----------
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name_prefix}-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda_permissions" {
  statement {
    actions = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"]
    resources = [
      aws_s3_bucket.intake.arn, "${aws_s3_bucket.intake.arn}/*",
      aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*",
    ]
  }
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.pipeline.arn]
  }
  statement {
    actions   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.hitl.arn, aws_sqs_queue.fraud_review.arn]
  }
  statement {
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.main.arn]
  }
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.db_credentials.arn,
      aws_secretsmanager_secret.anthropic_api_key.arn,
    ]
  }
  statement {
    actions   = ["rds-db:connect"]
    resources = ["arn:aws:rds-db:${var.aws_region}:${local.account_id}:dbuser:${aws_rds_cluster.main.cluster_resource_id}/${var.aurora_master_username}"]
  }
}

resource "aws_iam_role_policy" "lambda_permissions" {
  name   = "${local.name_prefix}-lambda-permissions"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_permissions.json
}

# ---------- Placeholder deployment package ----------
data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/.build/placeholder.zip"
  source {
    content  = "exports.handler = async (event) => { console.log(JSON.stringify(event)); return { statusCode: 200 }; };"
    filename = "index.js"
  }
}

# ---------- Lambda Functions ----------
resource "aws_lambda_function" "functions" {
  for_each = local.lambda_functions

  function_name    = each.value.name
  role             = aws_iam_role.lambda.arn
  handler          = each.value.handler
  runtime          = var.lambda_runtime
  memory_size      = each.value.memory
  timeout          = each.value.timeout
  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  environment {
    variables = each.value.env
  }

  dynamic "vpc_config" {
    for_each = each.value.vpc ? [1] : []
    content {
      subnet_ids         = aws_subnet.private[*].id
      security_group_ids = [aws_security_group.lambda.id]
    }
  }

  depends_on = [
    aws_iam_role_policy.lambda_permissions,
    aws_cloudwatch_log_group.lambda,
  ]

  tags = { Name = each.value.name }
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.lambda_functions
  name              = "/aws/lambda/${each.value.name}"
  retention_in_days = local.env == "prod" ? 90 : 14
  tags              = { Name = each.value.name }
}
