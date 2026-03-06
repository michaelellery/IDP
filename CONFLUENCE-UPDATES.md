# Confluence Documentation Updates — 2026-03-06

**Space:** IDP (bouchard.atlassian.net)
**Total pages updated:** 14
**New pages created:** 1

## Updated Pages

| Page | ID | New Version | Changes |
|------|----|-------------|---------|
| **System Overview & Diagrams** | 589825 | v4 | Added security hardening (Secrets Manager, SQL injection fixes), reliability features (retry/catch on all states, field/date validation, atomic DB writes), fraud detection as two-tier system, 12 Lambda functions listed, observability stack |
| **Technology Stack** | 557072 | v4 | Updated AI model assignments (Haiku for classification, Sonnet for extraction, Haiku for fraud Tier 2), added Secrets Manager, CloudWatch/X-Ray, Terraform details, security stack table, test coverage (76 tests) |
| **Deployment Process** | 851969 | v4 | Updated with Terraform workflow, Secrets Manager config management, observability stack details, removed Staging references (dev+prod only), updated smoke tests |
| **Release Management** | 884737 | v4 | Added quality gates table (ESLint, typecheck, tests, PR review workflow), test coverage breakdown, updated branch strategy with CI/CD gates |
| **AWS Account Structure** | 786433 | v4 | Added complete resource inventory for dev account (12 Lambdas, Aurora, S3, SQS, EventBridge, SNS, Secrets Manager, 42 alarms, dashboard), Terraform workspace mapping |
| **Monorepo Structure** | 688129 | v4 | Updated directory tree to reflect actual structure, added TypeScript type system docs (8 event interfaces, 4 DB record types), source reconciliation details, CI/CD files |
| **Data Architecture** | 1441800 | v2 | Added categorization and document_tampering tables to ERD, atomic write pattern docs, field validation rules (required fields, date validation), HITL routing logic |
| **Sequence Diagrams** | 2097153 | v2 | Added SD-07 (Two-Tier Fraud Detection) and SD-08 (Field Validation → HITL Review), updated component legend with current tech |
| **LLM Model Selection** | 1802241 | v2 | Updated current model assignments (Haiku for classification instead of Gemini Flash), added Haiku migration cost analysis ($36K/mo savings), monitoring checklist, updated cost projections |
| **CI/CD Pipeline** | 458754 | v3 | Replaced placeholder with full documentation: CI pipeline (4 parallel jobs), PR review workflow (5 scans), ESLint config, PR template, coding standards, test coverage, branch protection |
| **Monitoring & Alerting** | 1048577 | v3 | Complete rewrite: full alarm inventory (42 alarms by category), dashboard link, X-Ray tracing, SF logging, SNS topic, next steps |
| **Infrastructure as Code** | 753680 | v3 | Complete rewrite: Terraform file structure, resources managed table, workspace strategy (dev/prod), improvements over CLI deployment, migration steps, key variables |
| **Secrets Management** | 1015809 | v3 | Complete rewrite: secrets inventory, IAM access, Lambda integration pattern (code example), env vars removed, rotation procedures, CI enforcement |
| **SD-05: Fraud Detection Flow** | 2162689 | v2 | Marked original Resistant.ai design as superseded, added current two-tier implementation summary, linked to SD-07 and Fraud Detection Architecture page |

## New Pages Created

| Page | ID | Parent | Description |
|------|----|--------|-------------|
| **Fraud Detection Architecture** | 3047425 | Architecture (557057) | Dedicated page: two-tier system overview, Tier 1 rule-based checks table, Tier 2 Claude visual analysis, scoring model, error handling (fails open), Lambda config, pipeline integration, future enhancements |

## What Changed Today (Summary)

### Security Hardening
- All Lambda credentials migrated from plaintext env vars to AWS Secrets Manager
- SQL injection fixes (parameterized queries, allowlist validation)
- Documented in: System Overview, Tech Stack, Secrets Management

### Observability
- 42 CloudWatch alarms, X-Ray tracing, SF ERROR logging, dashboard
- SNS topic for alerting (needs subscriptions)
- Documented in: Monitoring & Alerting, Deployment, AWS Account Structure

### Fraud Detection
- Two-tier: PDF forensics (pdf-lib) + Claude Haiku visual analysis
- Replaced Math.random() stub
- Documented in: Fraud Detection Architecture (NEW), System Overview, Sequence Diagrams (SD-07), SD-05 (updated)

### Classification Cost Optimization
- Switched from Sonnet ($0.02/doc) to Haiku ($0.002/doc)
- ~$36K/month savings at 2M docs/month
- Documented in: LLM Model Selection, Tech Stack

### Infrastructure as Code
- 13-file Terraform config (1,166 lines HCL)
- Workspace support for dev/prod
- Documented in: Infrastructure as Code, Deployment, AWS Account Structure

### CI/CD & Code Quality
- GitHub Actions CI + PR review workflow
- ESLint strict TypeScript, PR template, CONTRIBUTING.md
- 76 automated tests
- Documented in: CI/CD Pipeline, Release Management

### Pipeline Reliability
- Retry/Catch on all Step Functions states
- Atomic DB writes in mark-complete
- Field validation (required fields, dates) → HITL_REVIEW
- Documented in: System Overview, Data Architecture, Sequence Diagrams (SD-08)

### TypeScript Reconciliation
- All source matches deployed code
- 8 typed interfaces, 4 DB record types
- Documented in: Monorepo Structure
