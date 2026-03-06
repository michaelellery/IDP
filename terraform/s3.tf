###############################################################################
# s3.tf — Intake and Documents Buckets
###############################################################################

resource "aws_s3_bucket" "intake" {
  bucket = "${local.name_prefix}-intake-${local.account_id}"
  tags   = { Name = "${local.name_prefix}-intake" }
}

resource "aws_s3_bucket_versioning" "intake" {
  bucket = aws_s3_bucket.intake.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "intake" {
  bucket = aws_s3_bucket.intake.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}

resource "aws_s3_bucket_public_access_block" "intake" {
  bucket                  = aws_s3_bucket.intake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_notification" "intake" {
  bucket = aws_s3_bucket.intake.id
  lambda_function {
    lambda_function_arn = aws_lambda_function.functions["s3-trigger"].arn
    events              = ["s3:ObjectCreated:*"]
  }
  depends_on = [aws_lambda_permission.s3_trigger]
}

resource "aws_lambda_permission" "s3_trigger" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.functions["s3-trigger"].function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.intake.arn
}

resource "aws_s3_bucket" "documents" {
  bucket = "${local.name_prefix}-documents-${local.account_id}"
  tags   = { Name = "${local.name_prefix}-documents" }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
