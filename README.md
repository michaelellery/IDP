# IDP — Intelligent Document Processing Platform

A serverless, vendor-flexible document processing platform built on AWS.

## What It Does

Processes documents through an automated pipeline:

1. **Decomposition** — Split multi-document uploads into individual documents
2. **Quality Analysis** — 4-corner check, blur detection, completeness validation (real-time feedback <5s)
3. **Classification** — AI-powered document type identification with confidence scoring
4. **Data Extraction** — Structured field extraction into RDS per document type schema
5. **Fraud Detection** — Tampering analysis via Resistant.ai
6. **HITL Exception Handling** — Low-confidence documents routed to human review queue

## Architecture

- **AWS Step Functions** — Pipeline orchestration (replaces traditional BPMN engines)
- **AWS Lambda** — All processing logic (decomposition, classification, extraction, fraud)
- **Amazon Aurora PostgreSQL** — Extraction data storage with per-document-type schemas
- **Amazon S3** — Document binary storage
- **Amazon EventBridge** — Event bus for downstream consumers
- **Amazon SQS** — HITL work queue management

## Monorepo Structure

```
IDP/
├── packages/
│   ├── dss-core/              # DSS platform: slots, jobs, canonical models
│   ├── dss-api/               # GraphQL API layer
│   ├── dss-events/            # EventBridge event producers/consumers
│   ├── idp-providers/
│   │   ├── kofax-adapter/     # TotalAgility integration (Phase 1)
│   │   └── aws-adapter/       # AWS Textract integration (future)
│   ├── extraction-schemas/    # Per-doc-type schemas & validation
│   ├── hitl-service/          # Human-in-the-loop coordination
│   └── fraud-service/         # Resistant.ai integration
├── infra/
│   ├── terraform/             # Infrastructure as Code
│   └── scripts/               # Operational scripts
├── test/
│   ├── integration/
│   ├── load/
│   └── accuracy/              # Accuracy spot-check tooling
├── docs/
└── .github/workflows/         # CI/CD
```

## AWS Accounts

| Account | ID | Purpose |
|---------|-----|---------|
| IDP Dev | `430695043165` | Development, testing, POC |
| IDP Prod | `357621881068` | Production processing |

## Getting Started

```bash
# Prerequisites
aws configure --profile idp-dev
npm install

# Deploy to dev
cd infra/terraform/environments/dev
terraform init && terraform apply
```

## Documentation

Full documentation: [Confluence IDP Space](https://bouchard.atlassian.net/wiki/spaces/IDP)
