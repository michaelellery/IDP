###############################################################################
# secrets.tf — Secrets Manager Secrets
###############################################################################

resource "aws_secretsmanager_secret" "db_credentials" {
  name        = "${local.name_prefix}/db-credentials"
  description = "IDP database credentials"
  tags        = { Name = "${local.name_prefix}-db-credentials" }
}

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name        = "${local.name_prefix}/anthropic-api-key"
  description = "Anthropic API key for IDP document processing"
  tags        = { Name = "${local.name_prefix}-anthropic-api-key" }
}
