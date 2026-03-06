variable "environment" { type = string }

resource "aws_cloudwatch_event_bus" "idp" {
  name = "idp-${var.environment}-events"
  tags = { Name = "idp-${var.environment}-events" }
}

# Rule: log all IDP events to CloudWatch
resource "aws_cloudwatch_event_rule" "all_events" {
  name           = "idp-${var.environment}-all-events"
  event_bus_name = aws_cloudwatch_event_bus.idp.name

  event_pattern = jsonencode({
    source = [{ prefix = "dss." }]
  })
}

resource "aws_cloudwatch_log_group" "events" {
  name              = "/idp/${var.environment}/events"
  retention_in_days = 30
}

output "event_bus_name" { value = aws_cloudwatch_event_bus.idp.name }
output "event_bus_arn" { value = aws_cloudwatch_event_bus.idp.arn }
