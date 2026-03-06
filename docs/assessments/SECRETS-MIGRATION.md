# Secrets Migration Summary

**Date:** 2026-03-06
**Account:** 430695043165 (idp-dev)
**Region:** us-east-1

## What Was Done

### 1. Created Secrets Manager Secrets

| Secret Name | Contents |
|---|---|
| `idp-dev/db-credentials` | `host`, `port`, `dbname`, `username`, `password` for the RDS cluster |
| `idp-dev/anthropic-api-key` | `apiKey` for Anthropic Claude API |

### 2. IAM Policy Update

Added inline policy `SecretsManagerAccess` to role `idp-dev-lambda-role` granting `secretsmanager:GetSecretValue` on both secrets (ARN-scoped).

### 3. Lambda Code Updates

All Lambdas now fetch credentials from Secrets Manager at cold start and cache them for the lifetime of the execution environment.

| Lambda | Changes |
|---|---|
| `idp-mark-complete` | Replaced `process.env.DB_*` with `getDbConfig()` from secrets-helper (bundled via esbuild) |
| `idp-api` | Replaced `process.env.DB_*` with inline Secrets Manager fetch; `@aws-sdk/client-secrets-manager` added to node_modules |
| `idp-populate-db` | Same pattern as idp-api |
| `idp-data-extraction` | Patched bundled code to lazy-init Anthropic client with key from Secrets Manager instead of `process.env.ANTHROPIC_API_KEY` |

### 4. Environment Variables Removed

Removed from all four Lambdas: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
Removed from `idp-data-extraction`: `ANTHROPIC_API_KEY`

**Retained** (non-secret): `S3_BUCKET` (idp-api, idp-data-extraction), `EVENT_BUS_NAME` (idp-data-extraction)

### 5. Deployment

All four Lambdas redeployed with updated code and cleaned environment variables.

## Secret Rotation

To rotate the DB password:
1. Update the password in RDS
2. Update the secret: `aws secretsmanager update-secret --secret-id idp-dev/db-credentials --secret-string '...' --profile idp-dev --region us-east-1`
3. No Lambda redeployment needed — new cold starts will pick up the new value

To rotate the Anthropic key:
1. Generate new key at console.anthropic.com
2. Update the secret: `aws secretsmanager update-secret --secret-id idp-dev/anthropic-api-key --secret-string '{"apiKey":"sk-ant-..."}' --profile idp-dev --region us-east-1`
