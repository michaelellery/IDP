# IDP Terraform Infrastructure

Terraform configuration for the IDP (Intelligent Document Processing) platform.

## Prerequisites

- Terraform >= 1.5.0
- AWS CLI configured with `idp-dev` profile
- Account: `430695043165`

## Bootstrap State Backend

Before first `terraform init`, create the state bucket and lock table:

```bash
aws s3api create-bucket \
  --bucket idp-terraform-state-430695043165 \
  --region us-east-1 \
  --profile idp-dev

aws s3api put-bucket-versioning \
  --bucket idp-terraform-state-430695043165 \
  --versioning-configuration Status=Enabled \
  --profile idp-dev

aws dynamodb create-table \
  --table-name idp-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1 \
  --profile idp-dev
```

## Quick Start

```bash
cd terraform/
terraform init
terraform workspace new dev    # or: terraform workspace select dev
terraform plan
terraform apply
```

## Workspaces

| Workspace | Account | Profile |
|-----------|---------|---------|
| dev       | 430695043165 | idp-dev |
| prod      | 357621881068 | idp-prod |

## Importing Existing Resources

The existing dev infrastructure was deployed via CLI. Import into Terraform state:

```bash
terraform workspace select dev

# VPC
terraform import aws_vpc.main vpc-01507db8d3aa6599b

# Subnets
terraform import 'aws_subnet.public[0]' subnet-09d015d52e166c3b8
terraform import 'aws_subnet.public[1]' subnet-0614ded3630d38871
terraform import 'aws_subnet.private[0]' subnet-0b21e480cd43f063d
terraform import 'aws_subnet.private[1]' subnet-0ab23b8d2d318ec20

# Internet Gateway
terraform import aws_internet_gateway.main <igw-id>

# NAT Gateway
terraform import aws_nat_gateway.main nat-07ca7d5ad85266e33

# Security Groups
terraform import aws_security_group.lambda sg-050ca6cb3f87fb653
terraform import aws_security_group.rds sg-013813e9c308b702e

# Aurora
terraform import aws_db_subnet_group.main idp-dev
terraform import aws_rds_cluster.main idp-dev
terraform import aws_rds_cluster_instance.main <instance-id>

# S3
terraform import aws_s3_bucket.intake idp-dev-intake-430695043165
terraform import aws_s3_bucket.documents idp-dev-documents-430695043165

# Lambda Functions
terraform import 'aws_lambda_function.functions["s3-trigger"]' idp-s3-trigger
terraform import 'aws_lambda_function.functions["decomposition"]' idp-decomposition
terraform import 'aws_lambda_function.functions["quality-check"]' idp-quality-check
terraform import 'aws_lambda_function.functions["classification"]' idp-classification
terraform import 'aws_lambda_function.functions["data-extraction"]' idp-data-extraction
terraform import 'aws_lambda_function.functions["fraud-check"]' idp-fraud-check
terraform import 'aws_lambda_function.functions["send-feedback"]' idp-send-feedback
terraform import 'aws_lambda_function.functions["mark-rejected"]' idp-mark-rejected
terraform import 'aws_lambda_function.functions["mark-complete"]' idp-mark-complete
terraform import 'aws_lambda_function.functions["handle-error"]' idp-handle-error
terraform import 'aws_lambda_function.functions["populate-db"]' idp-populate-db
terraform import 'aws_lambda_function.functions["api"]' idp-api

# IAM
terraform import aws_iam_role.lambda idp-dev-lambda-role
terraform import aws_iam_role.sfn idp-dev-sfn-role

# Step Functions
terraform import aws_sfn_state_machine.pipeline arn:aws:states:us-east-1:430695043165:stateMachine:idp-dev-document-pipeline

# SQS
terraform import aws_sqs_queue.hitl https://sqs.us-east-1.amazonaws.com/430695043165/idp-dev-hitl-queue
terraform import aws_sqs_queue.fraud_review https://sqs.us-east-1.amazonaws.com/430695043165/idp-dev-fraud-review-queue

# EventBridge
terraform import aws_cloudwatch_event_bus.main idp-dev-events

# API Gateway
terraform import aws_apigatewayv2_api.main rzeejg3ra4

# Secrets Manager
terraform import aws_secretsmanager_secret.db_credentials arn:aws:secretsmanager:us-east-1:430695043165:secret:idp-dev/db-credentials-tHL1Zq
terraform import aws_secretsmanager_secret.anthropic_api_key arn:aws:secretsmanager:us-east-1:430695043165:secret:idp-dev/anthropic-api-key-ObSrZ8
```

After importing, run `terraform plan` to verify drift and reconcile.

## Architecture

```
S3 Intake → Lambda (s3-trigger) → Step Functions Pipeline
  ├─ Decomposition
  ├─ Map: per-document
  │   ├─ Quality Check → reject/feedback
  │   ├─ Classification → reject/feedback
  │   ├─ Parallel: Data Extraction + Fraud Check
  │   ├─ Confidence Gate → HITL queue (SQS waitForTaskToken)
  │   ├─ Fraud Gate → Fraud Review queue
  │   └─ Mark Complete → EventBridge
  └─ Error Handler → Fail

API Gateway → Lambda (api) → Aurora PostgreSQL
```
