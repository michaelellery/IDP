# Classification Lambda: Sonnet → Haiku Migration

**Date:** 2026-03-06
**Status:** ✅ Deployed to idp-dev

## What Changed

- **Model:** `claude-sonnet-4-20250514` → `claude-haiku-3-5-20241022`
- **Lambda:** `idp-classification` (account 430695043165, us-east-1)
- **Files updated:**
  - `packages/dss-core/src/lambdas/classification/index.ts` (TS source)
  - `/tmp/idp-lambdas/classification/index.js` (deployed bundle)

## What Didn't Change

- **Data-extraction Lambda** stays on `claude-sonnet-4-20250514` — needs Sonnet for complex field extraction
- **Prompt** unchanged — classification is simple enough for Haiku
- **max_tokens** stays at 256

## Cost Impact

| Metric | Sonnet | Haiku |
|--------|--------|-------|
| Cost per doc | ~$0.02 | ~$0.002 |
| Monthly (2M docs) | ~$40,000 | ~$4,000 |
| **Savings** | | **~$36,000/month** |

## Verification

Monitor after deployment:
- CloudWatch for classification accuracy (confidence scores)
- Verify `correctDocument` field stays consistent
- Watch for increased "Other" classifications (would indicate Haiku struggling)

## Rollback

Change model back to `claude-sonnet-4-20250514` in both files and redeploy:
```bash
cd /tmp/idp-lambdas/classification
zip -r /tmp/classification-lambda.zip index.js
aws lambda update-function-code --function-name idp-classification \
  --zip-file fileb:///tmp/classification-lambda.zip \
  --profile idp-dev --region us-east-1
```
