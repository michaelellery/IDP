# IDP Terraform Migration Summary

## Overview

Created complete Terraform configuration at `/tmp/IDP/terraform/` to replace CLI-deployed infrastructure for the IDP platform on AWS account `430695043165` (idp-dev).

## Files Created (13 + README)

| File | Description |
|------|-------------|
| `providers.tf` | AWS provider, S3 backend config |
| `variables.tf` | All configurable parameters with workspace overrides |
| `vpc.tf` | VPC (10.0.0.0/16), 2 public + 2 private subnets, NAT gateway, security groups |
| `aurora.tf` | Aurora Serverless v2 PostgreSQL 16.4 (0.5–4.0 ACU dev, 2–16 prod) |
| `s3.tf` | Intake + documents buckets with encryption, versioning, public access blocks |
| `lambda.tf` | 12 Lambda functions (nodejs20.x) with shared IAM role, VPC config |
| `stepfunctions.tf` | Document processing pipeline state machine with clean retry policies |
| `sqs.tf` | HITL + fraud review queues with DLQs and redrive policies |
| `eventbridge.tf` | Custom event bus + rules for extraction/failure events |
| `api.tf` | HTTP API Gateway with Lambda proxy integration |
| `secrets.tf` | Secrets Manager: db-credentials, anthropic-api-key |
| `monitoring.tf` | SNS topic, CloudWatch alarms (Lambda errors, SFN failures, Aurora CPU, DLQ depth), dashboard |
| `outputs.tf` | All key ARNs and endpoints |
| `README.md` | Bootstrap instructions + full import commands for all existing resources |

## Discovered Infrastructure

- **12 Lambda functions** (idp-s3-trigger, idp-decomposition, idp-quality-check, idp-classification, idp-data-extraction, idp-fraud-check, idp-send-feedback, idp-mark-rejected, idp-mark-complete, idp-handle-error, idp-populate-db, idp-api)
- **1 Step Functions state machine** (idp-dev-document-pipeline) — complex pipeline with Map, Parallel, Choice states, SQS waitForTaskToken for HITL
- **1 Aurora Serverless v2** cluster (PostgreSQL 16.4, 0.5–4.0 ACU)
- **2 S3 buckets** (intake, documents)
- **2 SQS queues** (HITL, fraud review)
- **1 EventBridge custom bus** (idp-dev-events, no rules yet)
- **1 HTTP API Gateway** (idp-api)
- **2 Secrets Manager secrets** (db-credentials, anthropic-api-key)
- **1 VPC** with 4 subnets, NAT gateway, 2 security groups

## Key Improvements Over CLI Deployment

1. **Cleaned up retry policies** — original state machine had hundreds of duplicated retry blocks (bug in CLI deployment); Terraform version uses a shared `local.lambda_retry`
2. **DLQs added** — HITL and fraud review queues now have dead letter queues with alarms
3. **Monitoring** — CloudWatch alarms for Lambda errors, SFN failures, Aurora CPU, DLQ messages; dashboard for pipeline visibility
4. **Workspace support** — `dev` and `prod` workspaces with per-env config (Aurora capacity, retention, deletion protection)
5. **Managed master password** — Aurora uses `manage_master_user_password` instead of hardcoded password in Lambda env vars
6. **S3 hardening** — versioning, encryption, public access blocks on all buckets

## Migration Steps

1. Bootstrap state backend (see README.md)
2. `terraform init && terraform workspace new dev`
3. Run all `terraform import` commands from README.md
4. `terraform plan` — review drift
5. `terraform apply` to reconcile
6. Update Lambda deployment pipeline to use Terraform for code updates

## ⚠️ Important Notes

- **DB password in env vars**: The current Lambda `idp-api` has `DB_PASSWORD` hardcoded in environment variables. The Terraform config uses Secrets Manager instead — Lambda code needs updating to read from Secrets Manager.
- **Placeholder Lambda code**: Functions deploy with a stub handler; real code should be deployed via CI/CD updating the zip or S3 key.
- **Internet Gateway ID**: You'll need to look up the IGW ID for the import command (not captured in discovery).
- **Aurora instance ID**: Look up the RDS instance identifier for import.
