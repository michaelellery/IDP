# Source Sync: TS ↔ Deployed JS Reconciliation

**Date:** 2026-03-06
**Author:** Automated reconciliation

## Summary

Compared TypeScript source at `packages/dss-core/src/lambdas/` with deployed JavaScript at `/tmp/idp-lambdas/`. The major divergence was in **mark-complete**, which had been completely rewritten in JS directly on the deployed Lambda. All other lambdas had only minor differences (type annotations added).

## Changes by File

### 🔴 `mark-complete/index.ts` — **MAJOR REWRITE**

The deployed JS version was completely different from the TS source. Changes:

| Aspect | Old TS | New TS (matches deployed) |
|--------|--------|--------------------------|
| DB writes | Simple `UPDATE document_metadata` | Full upserts to `document_metadata`, `paystub`, `categorization`, `document_tampering` |
| EventBridge | Published completion event | **Removed** — no EventBridge calls |
| Field validation | None | Required field checks per doc type (Paystub: employeesFullName, grossPay, netPay) |
| Date validation | None | Validates date fields, rejects XX/xx placeholders and unparseable dates |
| HITL routing | None | Missing fields → `HITL_REVIEW` status (confidence capped at 0.7); invalid dates → `HITL_REVIEW` (capped at 0.75) |
| Input shape | Flat event | Reads from `processingResults[]` array (parallel branch output) |
| Helpers | None | Added `safeDate()` and `safeNum()` utility functions |
| Return value | `{ documentId, status: 'COMPLETE' }` | `{ documentId, status, confidence, extractedFields, missingRequired }` |

### 🟡 `lib/types.ts` — **EXPANDED**

- Added proper event types: `DecompositionEvent`, `QualityCheckEvent`, `ClassificationEvent`, `DataExtractionEvent`, `FraudCheckEvent`, `MarkCompleteEvent`, `MarkRejectedEvent`, `SendFeedbackEvent`
- Added `PaystubFields` interface for extraction field typing
- Added `MarkCompleteResult`, `MarkRejectedResult`, `FeedbackResult` return types
- Added DB record types: `DocumentMetadataRecord`, `PaystubRecord`, `CategorizationRecord`, `DocumentTamperingRecord`
- Added `processingTimeMs` to `QualityResult`, `FraudResult`, `ClassificationResult`
- Removed stale `DocumentMetadata` interface (replaced by `PipelineEventBase`)
- Changed `ExtractionResult.fields` from `Record<string, { value, confidence }>` to flat `PaystubFields` (matches actual extraction output)

### 🟢 All Other Lambdas — **Minor type annotation updates**

These lambdas already matched the deployed JS behavior. Changes were:
- Added typed event parameters (replacing `event: any`)
- Added return type annotations
- Added `import type` for shared types
- `quality-check`: Confirmed 1KB threshold (was already correct in TS source)
- `fraud-check`: Made `s3Bucket`/`s3Key` optional in event type (not used by handler)
- `send-feedback`: Added null-safe access to `qualityResult.issues`

### 🔧 `lib/llm-client.ts` — **No changes needed**

The shared LLM client is not used by the deployed lambdas (classification and data-extraction call Anthropic directly). The client remains available for future use.

### 🔧 Test files — **Minimal fix**

- `decomposition.test.ts`: Added `as any` cast for intentional `undefined` documentId test case

## Compilation Status

```
npx tsc --noEmit → 0 errors in packages/dss-core/
```

(Dashboard package has pre-existing JSX config errors, unrelated to this sync.)

## Notes

1. **mark-complete no longer uses EventBridge** — the deployed version writes directly to RDS and returns status. The old TS code published a `dss.document.complete` event which is no longer the pattern.
2. **Classification and data-extraction use Anthropic SDK directly** rather than the shared `llm-client.ts`. This is intentional — the shared client adds retry/cost-tracking overhead that these lambdas handle differently.
3. **The `ExtractionResult.fields` type changed** from nested `{ value, confidence }` objects to flat key-value pairs. This matches how Claude's tool_use actually returns data.
