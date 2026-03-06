# Fraud Check Lambda Upgrade

**Date:** 2026-03-06
**Lambda:** `idp-fraud-check`
**Handler:** `fraud-bundle.handler`
**Timeout:** 30s | **Memory:** 256MB

## What Changed

Replaced placeholder `Math.random() < 0.02` with a real two-tier fraud detection system.

### Tier 1: Rule-Based Checks (always runs)
- **Classification confidence** — flags if < 0.7 (+0.25)
- **File size anomalies** — paystubs outside 1KB-10MB range (+0.2-0.3)
- **Page count** — paystubs with > 3 pages (+0.15)
- **PDF metadata** — modification date significantly after creation date (+0.15)
- **Creator/Producer** — known image editors (Photoshop, GIMP, etc.) (+0.3 each)
- **Font count** — > 8 unique fonts is suspicious (+0.15)
- **PDF parse failure** — can't load PDF at all (+0.4)

### Tier 2: Claude Visual Analysis (conditional)
- **Only invoked when Tier 1 score is 0.3-0.7** (ambiguous range)
- Uses Claude 3.5 Haiku via Anthropic API (PDF document type)
- Checks: text alignment, digital manipulation, formatting anomalies, missing standard elements
- Final score = 40% Tier 1 + 60% Tier 2 (weighted blend)

### Scoring
- Score 0.0-1.0 (higher = more suspicious)
- **Flagged if score > 0.6** → routes to fraud review queue via ConfidenceGate
- Tier 1 score < 0.3 = clean (no Tier 2 needed)
- Tier 1 score > 0.7 = flagged (no Tier 2 needed)

### Error Handling
- **Fails open** — errors result in score=0, flagged=false (won't block document processing)
- Anthropic API key cached at Lambda cold start from Secrets Manager (`idp-dev/anthropic-api-key`)

### Dependencies
- `pdf-lib` — PDF parsing, metadata, page count
- `@aws-sdk/client-s3` — fetch PDF from S3
- `@aws-sdk/client-secrets-manager` — Anthropic API key
- Node 20 native `fetch` — Claude API calls

### Files Updated
- **TS source:** `packages/dss-core/src/lambdas/fraud-check/index.ts`
- **Deployed JS:** bundled via esbuild → `fraud-bundle.js` (232KB)
