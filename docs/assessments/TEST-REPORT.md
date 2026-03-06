# IDP Test Suite Report

**Date:** 2026-03-06
**Author:** Haresh (QA Engineer)
**Framework:** Jest 29 + ts-jest
**Run command:** `npm test` from repo root

## Summary

| Category | Suites | Tests | Status |
|----------|--------|-------|--------|
| Unit Tests | 8 | 52 | ✅ All pass |
| Integration Tests | 1 | 12 | ✅ All pass |
| Regression Tests | 1 | 12 | ✅ All pass |
| **Total** | **10** | **76** | **✅ All pass** |

## Test Structure

```
packages/dss-core/src/__tests__/
├── fixtures/
│   ├── mock-data.ts          # Shared mock events, LLM responses, PDF bytes
│   └── s3-mock.ts            # S3 client mock helper
├── unit/
│   ├── decomposition.test.ts  # 6 tests
│   ├── quality-check.test.ts  # 9 tests
│   ├── classification.test.ts # 6 tests
│   ├── data-extraction.test.ts# 6 tests
│   ├── fraud-check.test.ts    # 4 tests
│   ├── mark-complete.test.ts  # 6 tests
│   ├── mark-rejected.test.ts  # 2 tests
│   └── send-feedback.test.ts  # 4 tests
├── integration/
│   └── pipeline-flow.test.ts  # 12 tests
└── regression/
    └── known-bugs.test.ts     # 12 tests
```

## Unit Test Coverage

### decomposition (6 tests)
- ✅ Single-page passthrough
- ✅ 3-page passthrough (boundary)
- ✅ Multi-page split (5 pages → 5 docs)
- ✅ S3 failure propagation
- ✅ Missing documentId generates UUID
- ✅ Default sourceChannel = 'api'

### quality-check (9 tests)
- ✅ Valid PDF passes
- ✅ Non-PDF format rejected
- ✅ Empty/tiny file (< 1KB) rejected
- ✅ Oversized file (> 50MB) rejected
- ✅ PDF with 0 pages rejected
- ✅ Tiny page dimensions rejected
- ✅ S3 error propagation
- ✅ **Valid 1.5KB PDF passes (regression: was 5KB threshold)**
- ✅ Returns processingTimeMs

### classification (6 tests)
- ✅ Happy path classification as Paystub
- ✅ Wrong document type detection (key implies paystubs)
- ✅ LLM garbage fallback → Other/0.5
- ✅ JSON in markdown code block parsing
- ✅ S3 failure propagation
- ✅ LLM API failure propagation

### data-extraction (6 tests)
- ✅ Happy path tool_use extraction
- ✅ Default to Paystub when classification missing
- ✅ No tool_use block → empty fields, default confidence
- ✅ S3 error propagation
- ✅ LLM error propagation
- ✅ Low confidence extraction

### fraud-check (4 tests)
- ✅ Return shape validation
- ✅ Score range 0–1 (20 iterations)
- ✅ Flagged documents have signals
- ✅ Clean documents have no signals

### mark-complete (6 tests)
- ✅ Happy path — DB update + EventBridge event
- ✅ HITL result resolves HITL record
- ✅ DB connection failure propagation
- ✅ DB query failure propagation
- ✅ EventBridge failure propagation
- ✅ Always calls dbClient.end() (finally block)

### mark-rejected (2 tests)
- ✅ Happy path — rejected status + EventBridge event
- ✅ EventBridge failure propagation

### send-feedback (4 tests)
- ✅ Quality failure feedback message
- ✅ Classification mismatch feedback
- ✅ Unknown feedback fallback
- ✅ EventBridge error propagation

## Integration Tests (12 tests)

### Pipeline Flow Validation
- ✅ Full happy path: quality → classification → extraction → complete
- ✅ Quality fail → rejected
- ✅ Wrong classification → rejected
- ✅ Low confidence → HITL
- ✅ Fraud flagged → fraud review
- ✅ Low confidence takes priority over fraud flag
- ✅ Invalid dates ("1/7/XX") detection
- ✅ Valid ISO dates pass
- ✅ Missing date fields not flagged
- ✅ Missing required fields (employeesFullName/grossPay/netPay) → HITL
- ✅ ASL ConfidenceGate uses correct nested extractionResult path
- ✅ ASL DataExtraction ResultPath is $.extractionResult

## Regression Tests (12 tests)

### BUG: Silent .catch(() => {}) swallowing DB errors
- ✅ mark-complete propagates DB errors (not silently caught)
- ✅ Source code scan: no `.catch(() => {})` pattern

### BUG: ConfidenceGate path error
- ✅ ASL uses `$.processingResults[0].extractionResult.confidence` (not `$.processingResults[0].confidence`)
- ✅ DataExtraction ResultPath confirmed as `$.extractionResult`

### BUG: Date type mismatch ("1/7/XX" into DATE column)
- ✅ Rejects: "1/7/XX", "Jan 7", "13/2025", "N/A", "unknown", "", "1/7/2X"
- ✅ Accepts: "2025-01-07", "2025-12-31", "2024-02-29"
- ✅ null/undefined dates are invalid

### BUG: Quality check 5KB threshold rejecting valid PDFs
- ✅ Source code uses `sizeKB < 1` (not `sizeKB < 5`)
- ✅ 1.5KB PDF passes
- ✅ 2KB PDF passes
- ✅ 0.5KB PDF correctly fails

## Mocking Strategy

| Dependency | Mock Approach |
|-----------|---------------|
| S3 Client | `jest.mock('@aws-sdk/client-s3')` — returns configurable byte arrays |
| Anthropic SDK | `jest.mock('@anthropic-ai/sdk')` — returns fixture JSON/tool_use responses |
| pg (PostgreSQL) | `jest.mock('pg')` — mock connect/query/end |
| EventBridge | `jest.mock('@aws-sdk/client-eventbridge')` — mock send |
| pdf-lib | `jest.mock('pdf-lib')` — configurable page count/dimensions |

## CI Integration

Tests run via `npm test` at repo root, which delegates to each workspace.
Add to CI pipeline:

```yaml
- name: Run tests
  run: npm test
```
