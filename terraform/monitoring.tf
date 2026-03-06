###############################################################################
# monitoring.tf — CloudWatch Alarms, Dashboards, SNS Topic
###############################################################################

resource "aws_sns_topic" "alarms" {
  name = "${local.name_prefix}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = local.lambda_functions
  alarm_name          = "${each.value.name}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Lambda ${each.value.name} error rate"
  dimensions          = { FunctionName = each.value.name }
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "sfn_failures" {
  alarm_name          = "${local.name_prefix}-pipeline-failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ExecutionsFailed"
  namespace           = "AWS/States"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  dimensions          = { StateMachineArn = aws_sfn_state_machine.pipeline.arn }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "aurora_cpu" {
  alarm_name          = "${local.name_prefix}-aurora-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  dimensions          = { DBClusterIdentifier = aws_rds_cluster.main.cluster_identifier }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "hitl_dlq" {
  alarm_name          = "${local.name_prefix}-hitl-dlq-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  dimensions          = { QueueName = aws_sqs_queue.hitl_dlq.name }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "fraud_dlq" {
  alarm_name          = "${local.name_prefix}-fraud-review-dlq-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  dimensions          = { QueueName = aws_sqs_queue.fraud_review_dlq.name }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name_prefix}-pipeline"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title = "Pipeline Executions"
          metrics = [
            ["AWS/States", "ExecutionsStarted", "StateMachineArn", aws_sfn_state_machine.pipeline.arn],
            [".", "ExecutionsSucceeded", ".", "."],
            [".", "ExecutionsFailed", ".", "."],
          ]
          period = 300, stat = "Sum", region = var.aws_region
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title   = "Lambda Errors"
          metrics = [for k, v in local.lambda_functions : ["AWS/Lambda", "Errors", "FunctionName", v.name]]
          period = 300, stat = "Sum", region = var.aws_region
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title = "Aurora Serverless"
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBClusterIdentifier", aws_rds_cluster.main.cluster_identifier],
            [".", "ServerlessDatabaseCapacity", ".", "."],
            [".", "DatabaseConnections", ".", "."],
          ]
          period = 300, stat = "Average", region = var.aws_region
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title = "SQS Queue Depths"
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.hitl.name],
            [".", ".", ".", aws_sqs_queue.fraud_review.name],
            [".", ".", ".", aws_sqs_queue.hitl_dlq.name],
            [".", ".", ".", aws_sqs_queue.fraud_review_dlq.name],
          ]
          period = 60, stat = "Sum", region = var.aws_region
        }
      },
    ]
  })
}
