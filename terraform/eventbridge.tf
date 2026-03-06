###############################################################################
# eventbridge.tf — Event Bus and Rules
###############################################################################

resource "aws_cloudwatch_event_bus" "main" {
  name = "${local.name_prefix}-events"
  tags = { Name = "${local.name_prefix}-events" }
}

resource "aws_cloudwatch_event_rule" "extraction_available" {
  name           = "${local.name_prefix}-extraction-available"
  event_bus_name = aws_cloudwatch_event_bus.main.name
  event_pattern = jsonencode({
    source      = ["idp.pipeline"]
    detail-type = ["dss.extraction.available"]
  })
  tags = { Name = "${local.name_prefix}-extraction-available" }
}

resource "aws_cloudwatch_event_rule" "pipeline_failure" {
  name           = "${local.name_prefix}-pipeline-failure"
  event_bus_name = aws_cloudwatch_event_bus.main.name
  event_pattern = jsonencode({
    source      = ["idp.pipeline"]
    detail-type = ["dss.pipeline.failed"]
  })
  tags = { Name = "${local.name_prefix}-pipeline-failure" }
}
