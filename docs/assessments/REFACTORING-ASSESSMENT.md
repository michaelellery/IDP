# IDP Codebase Refactoring Assessment

**Assessed by:** Bob (Senior Software Engineer)
**Date:** 2026-03-06
**Scope:** `/tmp/IDP/packages/` (source) + `/tmp/idp-lambdas/` (deployed artifacts)

---

## Executive Summary

The IDP codebase is a functional serverless pipeline, but has several critical issues that risk silent data loss in production. The most urgent findings are **SQL injection vulnerabilities**, **silent error swallowing**, and **source/deployed code drift**. The codebase also suffers from significant duplication, weak typing, and missing connection pooling.

**Finding counts:** 5 CRITICAL · 8 HIGH · 10 MEDIUM · 6 LOW

---

## 1. CRITICAL Findings

### C1. SQL Injection in API — String-Interpolated Query Parameters

**File:** `packages/dss-api/src/index.ts`, lines 86–87
**Severity:** CRITICAL

The `LIMIT`, `OFFSET`, and `hours` values from query string parameters are interpolated directly into SQL:

```typescript
query += ` ORDER BY m.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
```

```typescript
WHERE created_at > NOW() - INTERVAL '${hours} hours'
```

While `parseInt()` is called, a failure returns `NaN` which gets interpolated, and there's no validation. More critically, the pattern establishes a dangerous habit.

**Recommended fix:** Use parameterized queries for ALL values:
```typescript
params.push(limit, offset);
query += ` ORDER BY m.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
```

---

### C2. SQL Injection via Dynamic Table Name

**File:** `packages/dss-api/src/index.ts`, line 95
**Severity:** CRITICAL

```typescript
const extResult = await db.query(`SELECT * FROM ${docType} WHERE document_name = $1`, [row.document_name]);
```

The `docType` comes from database content (which originates from LLM classification output). If an attacker manipulates a document type, they can inject arbitrary SQL via the table name. The allowlist check on line 93 mitigates this partially, but the check uses `toLowerCase()` while the query uses the original casing—they could diverge.

**Recommended fix:** Use an explicit allowlist map of table names:
```typescript
const TABLE_MAP: Record<string, string> = {
  paystub: 'paystub',
  bankstatement: 'bank_statement',
  // ...
};
const tableName = TABLE_MAP[docType?.toLowerCase()];
if (tableName) {
  const extResult = await db.query(`SELECT * FROM ${tableName} WHERE document_name = $1`, [row.document_name]);
}
```

---

### C3. Silent Error Swallowing — Empty Catch Block

**File:** `packages/dss-api/src/index.ts`, line 98
**Severity:** CRITICAL

```typescript
} catch {}
```

When fetching extraction data from type-specific tables, **all errors are silently swallowed**. This means if the DB connection drops mid-request, if table schemas are wrong, or if there's a permissions issue, the API returns documents with `extraction_data: null` and nobody ever knows.

**Recommended fix:**
```typescript
} catch (err) {
  console.error(`Failed to fetch extraction data for ${row.document_name} from ${docType}:`, err);
}
```

---

### C4. Source Code ≠ Deployed Code — mark-complete Lambda Drift

**Files:** `packages/dss-core/src/lambdas/mark-complete/index.ts` vs `/tmp/idp-lambdas/mark-complete/index.js`
**Severity:** CRITICAL

The deployed `mark-complete` Lambda is a completely different implementation than the source TypeScript. The source code is essentially a stub that would lose all extraction data in production. Someone deployed a hand-edited JS file directly.

| Aspect | Source (TS) | Deployed (JS) |
|--------|------------|---------------|
| DB writes | Only UPDATE status | Full INSERT/UPSERT into document_metadata, paystub, categorization, document_tampering |
| HITL logic | Minimal | Validates required fields, date fields, forces HITL_REVIEW |
| Error handling | try/finally | try/catch/finally with .catch() on non-critical writes |

**Recommended fix:** Reconcile immediately. The deployed version should become the source of truth. Port the deployed JS back to TypeScript and commit it.

---

### C5. Non-Critical DB Writes Swallowed with `.catch()`

**File:** `/tmp/idp-lambdas/mark-complete/index.js` (deployed version)
**Severity:** CRITICAL

```javascript
).catch(e => console.warn(`Non-critical DB write failed: ${e.message}`));
```

The categorization and fraud/tampering writes use `.catch()` that logs a warning but continues. While labeled "non-critical," losing categorization and fraud data silently is a data integrity issue. If the DB connection pool is exhausted, these will fail systematically and silently.

**Recommended fix:** At minimum, emit a metric or structured error log that can trigger an alarm:
```typescript
).catch(e => {
  console.error(JSON.stringify({ error: 'db_write_failed', table: 'categorization', documentId, message: e.message }));
});
```

---

## 2. HIGH Findings

### H1. No Connection Pooling — New DB Client Per Lambda Invocation

**Files:** `packages/dss-api/src/index.ts:7-15`, `packages/dss-core/src/lambdas/mark-complete/index.ts:8-16`
**Severity:** HIGH

Every Lambda invocation creates a new `pg.Client`, connects, runs queries, and disconnects. For warm Lambdas handling burst traffic, this hammers Aurora with connection churn.

```typescript
const db = new Client({ ... });
await db.connect();
// ...
await db.end();
```

**Recommended fix:** Use RDS Proxy or a module-scoped Pool with lazy init:
```typescript
import { Pool } from 'pg';
let pool: Pool;
function getPool() {
  if (!pool) pool = new Pool({ ...config, max: 1 });
  return pool;
}
```

---

### H2. Duplicated DB Connection Config (3x)

**Files:** `packages/dss-api/src/index.ts:7-15`, `packages/dss-core/src/lambdas/mark-complete/index.ts:8-16`, `/tmp/idp-lambdas/mark-complete/index.js`
**Severity:** HIGH

The identical DB connection configuration is copy-pasted across 3 files.

**Recommended fix:** Create `packages/dss-core/src/lib/db.ts` with shared config and pool.

---

### H3. Anthropic Client Created at Module Scope Without Lazy Init

**Files:** `packages/dss-core/src/lambdas/classification/index.ts:5`, `packages/dss-core/src/lambdas/data-extraction/index.ts:5`
**Severity:** HIGH

```typescript
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

Created at module load time. Meanwhile, `lib/llm-client.ts` already has a proper lazy singleton — but these lambdas don't use it.

**Recommended fix:** Use the shared `llm-client.ts` module.

---

### H4. S3 Client Created at Module Scope in Every Lambda

**Files:** `classification/index.ts:3`, `data-extraction/index.ts:3`, `quality-check/index.ts:3`, `decomposition/index.ts:5`
**Severity:** HIGH

`new S3Client({})` duplicated in 4+ lambdas. Should be a shared utility.

---

### H5. `llm-client.ts` Exists But Lambdas Don't Use It

**Files:** `packages/dss-core/src/lib/llm-client.ts` vs `classification/index.ts`, `data-extraction/index.ts`
**Severity:** HIGH

A well-written LLM client with retry logic, cost tracking, and structured logging exists. But the classification and data-extraction lambdas directly instantiate Anthropic and make raw API calls without retries, cost logging, or error handling.

**Recommended fix:** Refactor both lambdas to use `callLLM()`.

---

### H6. No Input Validation on Lambda Event Parameters

**Files:** All 8 lambda handlers
**Severity:** HIGH

Every handler destructures `event` with no validation:
```typescript
const { documentId, s3Bucket, s3Key } = event;
```

**Recommended fix:** Add Zod schemas or manual validation at handler entry.

---

### H7. Fraud Check Is a Random Number Generator

**File:** `packages/dss-core/src/lambdas/fraud-check/index.ts`
**Severity:** HIGH

```typescript
const flagged = Math.random() < 0.02;
```

This is **deployed to production** and randomly flagging 2% of legitimate documents for fraud review.

**Recommended fix:** Return `{ flagged: false }` until the real Resistant.ai integration is ready.

---

### H8. Dashboard Fetches Every 5 Seconds with No Backoff

**File:** `packages/dashboard/src/App.tsx`, line 38
**Severity:** HIGH

```typescript
const interval = setInterval(fetchData, 5000);
```

Three API calls every 5 seconds, each creating a new DB connection. No error backoff. `@tanstack/react-query` is already a dependency but not used.

**Recommended fix:** Use react-query with staleTime/refetchInterval and exponential backoff.

---

## 3. MEDIUM Findings

### M1. Every Handler Typed as `event: any`

**Files:** All 8 lambda handlers
**Severity:** MEDIUM

Proper types exist in `lib/types.ts` but aren't used. Defeats TypeScript's value.

---

### M2. LLM Model Version Hardcoded in 3 Places

**Files:** `classification/index.ts:21`, `data-extraction/index.ts:39`, `lib/llm-client.ts:4`
**Severity:** MEDIUM

```typescript
model: 'claude-sonnet-4-20250514',
```

Should be `process.env.ANTHROPIC_MODEL || DEFAULT_MODEL`.

---

### M3. Extraction Tool Schema Duplicated

**File:** `packages/dss-core/src/lambdas/data-extraction/index.ts:7-24`
**Severity:** MEDIUM

The `PAYSTUB_TOOL` schema is defined inline. The `extraction-schemas` package exists but isn't used for tool definitions.

---

### M4. Classification JSON Parsing Fragile — Silent Fallback to "Other"

**File:** `packages/dss-core/src/lambdas/classification/index.ts:28-29`
**Severity:** MEDIUM

```typescript
catch { parsed = { documentType: 'Other', confidence: 0.5, rationale: 'Parse failed' }; }
```

On parse failure, silently classified as "Other". Should use tool_use for structured output or at least log the raw response.

---

### M5. EventBridge Client + PutEvents Pattern Duplicated 3x

**Files:** `send-feedback/index.ts`, `mark-rejected/index.ts`, `mark-complete/index.ts`
**Severity:** MEDIUM

Three lambdas have nearly identical EventBridge publishing patterns. Extract to `lib/events.ts`.

---

### M6. `ssl: { rejectUnauthorized: false }` on DB Connections

**Files:** All DB connection configs
**Severity:** MEDIUM

Should use RDS CA bundle in production.

---

### M7. No Timeout on Anthropic API Calls

**Files:** `classification/index.ts`, `data-extraction/index.ts`
**Severity:** MEDIUM

If the API hangs, the Lambda runs until its configured timeout, burning cost.

---

### M8. Decomposition Does Sequential S3 Uploads

**File:** `packages/dss-core/src/lambdas/decomposition/index.ts`
**Severity:** MEDIUM

For multi-page PDFs, each page is uploaded sequentially. Use `Promise.all` with batching.

---

### M9. No Structured Logging

**Files:** All lambdas
**Severity:** MEDIUM

Most lambdas use `console.log` with template strings. Only `llm-client.ts` uses structured JSON. All logs should be structured for CloudWatch Insights.

---

### M10. Dashboard Has No Error States

**File:** `packages/dashboard/src/App.tsx`
**Severity:** MEDIUM

The `catch` block only logs to console. No error state displayed to users. Dashboard silently shows stale data on API failure.

---

## 4. LOW Findings

### L1. `sharp` Dependency Not Used — +25MB Bundle Size

**File:** `packages/dss-core/package.json`
**Severity:** LOW

`sharp` is listed but not imported anywhere. Native module adds ~25MB.

---

### L2. `pdf-to-img` Dependency Not Used

**File:** `packages/dss-core/package.json`
**Severity:** LOW

Listed but not imported.

---

### L3. LLM Cost Constants Will Drift

**File:** `packages/dss-core/src/lib/llm-client.ts:3-4`
**Severity:** LOW

```typescript
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;
```

Should be env vars or config.

---

### L4. No Unit Tests

**Severity:** LOW

`jest` configured in every package but no test files exist.

---

### L5. Dashboard Uses Inline Styles Everywhere

**Files:** `packages/dashboard/src/` (all components)
**Severity:** LOW

Every component uses `style={{}}`. Consider CSS modules or Tailwind.

---

### L6. `pdf-lib` Bundled Entirely in Deployed Lambda

**File:** `/tmp/idp-lambdas/decomposition/index.js`
**Severity:** LOW

Full CJS build bundled. Consider tree-shaking.

---

## Priority Remediation Order

1. **Immediate (this sprint):** C1, C2, C3 — SQL injection and silent error swallowing
2. **Urgent (next sprint):** C4, C5, H1 — Source/deployed drift, connection pooling
3. **Important (2-4 weeks):** H3, H5, H6, H7 — Client consolidation, input validation, fraud mock
4. **Planned (next quarter):** M1-M10 — Type safety, deduplication, structured logging
5. **Backlog:** L1-L6 — Bundle optimization, tests, styling

---

## Architecture Recommendations

1. **Create `packages/dss-core/src/lib/db.ts`** — shared DB pool with lazy init, RDS Proxy support
2. **Create `packages/dss-core/src/lib/aws-clients.ts`** — shared S3, EventBridge singletons
3. **Create `packages/dss-core/src/lib/events.ts`** — shared EventBridge publishing utility
4. **Refactor all lambdas to use `llm-client.ts`** — don't bypass the retry/logging layer
5. **Add Zod validation at handler entry** — fail fast with clear errors
6. **Reconcile deployed JS with source TS** — establish CI/CD that prevents drift
7. **Add integration tests** — at minimum, test the mark-complete data flow end-to-end
