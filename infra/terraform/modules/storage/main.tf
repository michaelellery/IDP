variable "environment" { type = string }

resource "aws_s3_bucket" "intake" {
  bucket = "idp-${var.environment}-intake"
  tags   = { Name = "idp-${var.environment}-intake" }
}

resource "aws_s3_bucket" "documents" {
  bucket = "idp-${var.environment}-documents"
  tags   = { Name = "idp-${var.environment}-documents" }
}

resource "aws_s3_bucket_versioning" "intake" {
  bucket = aws_s3_bucket.intake.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "intake" {
  bucket = aws_s3_bucket.intake.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}

resource "aws_s3_bucket_public_access_block" "intake" {
  bucket                  = aws_s3_bucket.intake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "intake_bucket" { value = aws_s3_bucket.intake.id }
output "documents_bucket" { value = aws_s3_bucket.documents.id }
