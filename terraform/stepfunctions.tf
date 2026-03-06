###############################################################################
# stepfunctions.tf — State Machine Definition
###############################################################################

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${local.name_prefix}-sfn-role"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "sfn_permissions" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [for fn in aws_lambda_function.functions : fn.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.hitl.arn, aws_sqs_queue.fraud_review.arn]
  }
  statement {
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.main.arn]
  }
  statement {
    actions = [
      "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies", "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sfn_permissions" {
  name   = "${local.name_prefix}-sfn-permissions"
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn_permissions.json
}

locals {
  lambda_retry = [
    {
      ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
      IntervalSeconds = 3
      MaxAttempts     = 5
      BackoffRate     = 2
    },
    {
      ErrorEquals     = ["States.TaskFailed"]
      IntervalSeconds = 5
      MaxAttempts     = 2
      BackoffRate     = 2
    }
  ]
}

resource "aws_sfn_state_machine" "pipeline" {
  name     = "${local.name_prefix}-document-pipeline"
  role_arn = aws_iam_role.sfn.arn

  definition = jsonencode({
    Comment = "IDP Document Processing Pipeline"
    StartAt = "Decomposition"
    States = {
      Decomposition = {
        Type       = "Task"
        Resource   = aws_lambda_function.functions["decomposition"].arn
        Comment    = "Split multi-document uploads into individual documents"
        ResultPath = "$.decomposition"
        Next       = "ProcessDocuments"
        Retry      = local.lambda_retry
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "HandleProcessingError", ResultPath = "$.error" }]
      }
      ProcessDocuments = {
        Type           = "Map"
        ItemsPath      = "$.decomposition.documents"
        MaxConcurrency = 10
        Iterator = {
          StartAt = "QualityCheck"
          States = {
            QualityCheck = {
              Type = "Task", Resource = aws_lambda_function.functions["quality-check"].arn
              Comment = "4-corner analysis, blur detection, completeness"
              ResultPath = "$.qualityResult", Next = "QualityGate", Retry = local.lambda_retry
            }
            QualityGate = {
              Type = "Choice"
              Choices = [{ Variable = "$.qualityResult.passed", BooleanEquals = false, Next = "SendQualityFeedback" }]
              Default = "Classification"
            }
            SendQualityFeedback = {
              Type = "Task", Resource = aws_lambda_function.functions["send-feedback"].arn
              ResultPath = "$.feedbackResult", Next = "DocumentRejected", Retry = local.lambda_retry
            }
            Classification = {
              Type = "Task", Resource = aws_lambda_function.functions["classification"].arn
              Comment = "AI document type classification with confidence scoring"
              ResultPath = "$.classificationResult", Next = "ClassificationGate", Retry = local.lambda_retry
            }
            ClassificationGate = {
              Type = "Choice"
              Choices = [{ Variable = "$.classificationResult.correctDocument", BooleanEquals = false, Next = "SendClassificationFeedback" }]
              Default = "ParallelProcessing"
            }
            SendClassificationFeedback = {
              Type = "Task", Resource = aws_lambda_function.functions["send-feedback"].arn
              ResultPath = "$.feedbackResult", Next = "DocumentRejected", Retry = local.lambda_retry
            }
            ParallelProcessing = {
              Type = "Parallel"
              Branches = [
                { StartAt = "DataExtraction", States = { DataExtraction = {
                  Type = "Task", Resource = aws_lambda_function.functions["data-extraction"].arn
                  ResultPath = "$.extractionResult", End = true, Retry = local.lambda_retry
                }}},
                { StartAt = "FraudCheck", States = { FraudCheck = {
                  Type = "Task", Resource = aws_lambda_function.functions["fraud-check"].arn
                  ResultPath = "$.fraudResult", End = true, Retry = local.lambda_retry
                }}}
              ]
              ResultPath = "$.processingResults", Next = "ConfidenceGate"
            }
            ConfidenceGate = {
              Type = "Choice"
              Choices = [
                { Variable = "$.processingResults[0].extractionResult.confidence", NumericLessThan = var.extraction_confidence_threshold, Next = "RouteToHITL" },
                { Variable = "$.processingResults[1].fraudResult.fraudResult.flagged", BooleanEquals = true, Next = "RouteToFraudReview" }
              ]
              Default = "MarkComplete"
            }
            RouteToHITL = {
              Type = "Task", Resource = "arn:aws:states:::sqs:sendMessage.waitForTaskToken"
              Parameters = {
                QueueUrl = aws_sqs_queue.hitl.url
                MessageBody = {
                  "documentId.$" = "$.documentId", "matterId.$" = "$.matterId"
                  "documentType.$" = "$.classificationResult.documentType"
                  "extractionResult.$" = "$.processingResults[0]", "taskToken.$" = "$$.Task.Token"
                }
              }
              ResultPath = "$.hitlResult", Next = "MarkComplete", TimeoutSeconds = var.sfn_hitl_timeout_seconds
            }
            RouteToFraudReview = {
              Type = "Task", Resource = "arn:aws:states:::sqs:sendMessage.waitForTaskToken"
              Parameters = {
                QueueUrl = aws_sqs_queue.fraud_review.url
                MessageBody = {
                  "documentId.$" = "$.documentId", "matterId.$" = "$.matterId"
                  "fraudSignals.$" = "$.processingResults[1]", "taskToken.$" = "$$.Task.Token"
                }
              }
              ResultPath = "$.fraudReviewResult", Next = "MarkComplete", TimeoutSeconds = var.sfn_fraud_review_timeout_seconds
            }
            MarkComplete = {
              Type = "Task", Resource = aws_lambda_function.functions["mark-complete"].arn
              Comment = "Update metadata, publish dss.extraction.available event"
              End = true, Retry = local.lambda_retry
            }
            DocumentRejected = {
              Type = "Task", Resource = aws_lambda_function.functions["mark-rejected"].arn
              Comment = "Mark document as rejected", End = true, Retry = local.lambda_retry
            }
          }
        }
        ResultPath = "$.processedDocuments", Next = "PipelineComplete"
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "HandleProcessingError", ResultPath = "$.error" }]
      }
      HandleProcessingError = {
        Type = "Task", Resource = aws_lambda_function.functions["handle-error"].arn
        Next = "PipelineFailed", Retry = local.lambda_retry
      }
      PipelineComplete = { Type = "Succeed" }
      PipelineFailed   = { Type = "Fail", Error = "ProcessingError", Cause = "Document processing pipeline failed" }
    }
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = true
    level                  = "ERROR"
  }

  tags = { Name = "${local.name_prefix}-document-pipeline" }
}

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/aws/states/${local.name_prefix}-document-pipeline"
  retention_in_days = local.env == "prod" ? 90 : 14
}
