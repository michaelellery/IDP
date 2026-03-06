# IDP Platform — Architectural Health Assessment

**Assessor:** Adam (Senior Solutions Architect)
**Date:** 2026-03-06
**Environment:** idp-dev (430695043165, us-east-1)
**State Machine:** `idp-dev-document-pipeline` (STANDARD type)

---

## Executive Summary

The IDP platform is a well-structured serverless document processing pipeline with a sound core design. However, there are **critical security issues** (plaintext secrets in Lambda env vars), **significant observability gaps** (logging and tracing both OFF on the state machine), and several reliability concerns that need immediate attention before production readiness.

| Area | Rating | Priority |
|------|--------|----------|
| 1. System Reliability | 🟡 YELLOW | High |
| 2. State Machine Design | 🟢 GREEN | — |
| 3. Data Flow Integrity | 🟡 YELLOW | High |
| 4. Scalability | 🟡 YELLOW | Medium |
| 5. Security Posture | 🔴 RED | **Critical** |
| 6. Observability | 🔴 RED | **Critical** |
| 7. Cost Optimization | 🟡 YELLOW | Low |
| 8. Disaster Recovery | 🟡 YELLOW | Medium |
| 9. API Design | 🟡 YELLOW | Medium |
| 10. HITL Workflow | 🟢 GREEN | — |

---

## 1. System Reliability — 🟡 YELLOW

### Findings

**Good:**
- Decomposition has proper Retry on `Lambda.ServiceException` and `Lambda.TooManyRequestsException` (3 attempts, exponential backoff)
- Quality Check has Retry on `Lambda.ServiceException` (2 attempts)
- Data Extraction has Retry (3 attempts)
- Top-level Catch on Decomposition routes to `HandleProcessingError` → `PipelineFailed`
- The `llm-client.ts` has application-level retries for Anthropic 429/529/5xx with exponential backoff

**Issues:**

1. **No Catch on the Map state (`ProcessDocuments`)** — If one document in the Map iteration throws an unhandled error, the entire Map state fails and there is no Catch on it. All other documents' results are lost.

2. **FraudCheck has NO Retry policy** — If the fraud check service is temporarily unavailable, the entire Parallel branch fails immediately.

3. **MarkComplete has NO Retry policy** — This is the DB write step. A transient Aurora connection issue will fail the document with no retry.

4. **Classification and SendFeedback have NO Retry policies** — Classification calls Anthropic API which can rate-limit; relying solely on application-level retries is fragile when Step Functions could handle it natively.

5. **No DLQ on SQS queues** — Both `idp-dev-hitl-queue` and `idp-dev-fraud-review-queue` have no `RedrivePolicy`. If a HITL task token callback fails, the message is retried until `MessageRetentionPeriod` (14 days) expires, then silently dropped.

6. **No Catch on individual Map iteration states** — Within the Map iterator, only QualityCheck has limited retry. If Classification, DataExtraction, or FraudCheck fail with an unexpected error, the individual document iteration fails and poisons the Map.

### Remediation

```
P0: Add Catch on ProcessDocuments Map state → route failures per-document to DocumentRejected
P0: Add Retry to FraudCheck, MarkComplete, Classification, SendFeedback, MarkRejected
P0: Add DLQs to both SQS queues
P1: Add per-iteration Catch in the Map iterator to isolate document-level failures
P1: Add TooManyRequestsException to all Lambda Retry policies
```

---

## 2. State Machine Design — 🟢 GREEN

### Findings

**Well done:**
- Clean linear flow: Decomposition → Map(QualityCheck → Classification → Parallel[Extraction, Fraud] → ConfidenceGate → Terminal states)
- Proper use of `ResultPath` throughout — each step writes to a unique path (`$.decomposition`, `$.qualityResult`, `$.classificationResult`, `$.processingResults`, etc.) preserving the full event context
- Choice states use appropriate comparisons (BooleanEquals, NumericLessThan)
- Parallel state correctly runs DataExtraction and FraudCheck concurrently, with results at `$.processingResults[0]` and `$.processingResults[1]`
- Map state with `MaxConcurrency: 10` provides bounded parallelism

**Minor Issues:**

1. **ConfidenceGate ordering** — The Choice state checks extraction confidence first, then fraud. If a document is BOTH low-confidence AND fraud-flagged, it routes to HITL (not fraud review). This may be intentional but should be explicitly documented.

2. **No default ResultPath on MarkComplete/MarkRejected** — These are terminal states (`End: true`) so this is acceptable, but for debugging, adding a ResultPath would capture the return value in execution history.

3. **Map state `ItemsPath: $.decomposition.documents`** — Correct, but if decomposition returns an empty array, the Map succeeds with empty results, and `PipelineComplete` is reached. May want a Choice gate after Decomposition to handle zero-document case.

### Remediation

```
P2: Document ConfidenceGate priority ordering in runbook
P2: Add Choice after Decomposition for empty document array
P3: Add ResultPath to terminal states for execution history debugging
```

---

## 3. Data Flow Integrity — 🟡 YELLOW

### Findings

**Good:**
- `mark-complete` uses `ON CONFLICT ... DO UPDATE` (upsert) for all DB writes — idempotent
- Extraction data and metadata written in same `try` block with a single DB connection
- Document decomposition writes individual pages to S3 before returning references

**Issues:**

1. **No transaction wrapping in mark-complete** — The `document_metadata`, `paystub`, `categorization`, and `document_tampering` writes are separate queries. If the Lambda times out after writing metadata but before writing extraction data, the document shows as COMPLETE with no extraction data. These should be wrapped in `BEGIN/COMMIT`.

2. **Non-critical writes silently swallowed** — `categorization` and `document_tampering` writes use `.catch(e => console.warn(...))`. If these fail, the document is marked COMPLETE but fraud data is missing. This should at minimum be logged at ERROR level.

3. **Parallel state output merging** — The Parallel state outputs an array. ConfidenceGate accesses `$.processingResults[0].extractionResult.confidence` and `$.processingResults[1].fraudResult.fraudResult.flagged`. The double-nesting (`fraudResult.fraudResult`) matches the fraud-check Lambda output `{ fraudResult: { flagged, ... } }` — this is correct but fragile. A future refactor could break the path reference.

4. **Race condition on document_metadata** — If two executions process the same `documentId` (e.g., duplicate S3 trigger), both will upsert, and the last writer wins. No optimistic locking.

5. **S3 decomposition has no cleanup** — If decomposition creates page files in S3 but the pipeline later fails, orphaned S3 objects remain indefinitely.

### Remediation

```
P0: Wrap mark-complete DB writes in a transaction (BEGIN/COMMIT/ROLLBACK)
P1: Elevate categorization/tampering write failures to ERROR level
P1: Add S3 lifecycle policy for processed/ prefix (auto-delete after 90 days)
P2: Add execution ID or version column for optimistic concurrency control
P2: Consider flattening fraud-check output to avoid double-nesting
```

---

## 4. Scalability — 🟡 YELLOW

### Findings

**Lambda Configuration:**

| Function | Memory | Timeout | VPC | Concern |
|----------|--------|---------|-----|---------|
| idp-decomposition | 512 MB | 60s | No | OK for PDF splitting |
| idp-quality-check | 1024 MB | 30s | No | OK |
| idp-classification | 1024 MB | 60s | No | Anthropic call may timeout |
| idp-data-extraction | 1024 MB | 120s | Yes | Good timeout for LLM |
| idp-fraud-check | 512 MB | 60s | No | OK |
| idp-mark-complete | 256 MB | 30s | Yes | OK |
| idp-mark-rejected | 256 MB | 10s | No | Tight timeout |
| idp-send-feedback | 256 MB | 10s | No | OK |
| idp-api | 256 MB | 30s | Yes | See API section |

**Issues:**

1. **No reserved concurrency on any Lambda** — All functions share the account's 1000 default concurrent execution limit. A burst of document uploads could cause ALL Lambdas (including the API) to be throttled.

2. **No connection pooling for Aurora** — `mark-complete` and `idp-api` create a new `pg.Client()` per invocation. Under high concurrency, this will exhaust Aurora's `max_connections` (typically 256 for small instances).

3. **Map MaxConcurrency: 10** — Reasonable, but with the Parallel state inside, each Map iteration spawns 2 concurrent Lambda invocations (extraction + fraud). A single pipeline execution uses up to 20 concurrent Lambdas for the parallel phase. A burst of 50 concurrent pipeline executions = 1000+ Lambda invocations.

4. **Anthropic API rate limiting** — Classification and extraction both call Claude. The classification Lambda calls Anthropic directly with no retry (doesn't use `llm-client.ts`).

5. **VPC cold starts** — `idp-data-extraction`, `idp-mark-complete`, and `idp-api` are in VPC with no Provisioned Concurrency.

### Remediation

```
P0: Implement RDS Proxy for connection pooling
P1: Set reserved concurrency: idp-api=50, idp-classification=20, idp-data-extraction=20
P1: Refactor classification to use llm-client.ts for consistent retry behavior
P2: Add Provisioned Concurrency for idp-api (keep warm for viewer)
P2: Implement Anthropic token-bucket rate limiter in llm-client.ts
```

---

## 5. Security Posture — 🔴 RED

### Critical Findings

1. **🚨 PLAINTEXT SECRETS IN ENVIRONMENT VARIABLES** — Lambda env vars contain:
   - `ANTHROPIC_API_KEY`: Full API key in plaintext
   - `DB_PASSWORD`: Full database password in plaintext
   - `DB_USER`, `DB_HOST`: Connection details exposed

   Anyone with `Lambda:GetFunctionConfiguration` permission can read these. They appear in CloudTrail logs, AWS Config snapshots, and potentially in error messages.

2. **Inconsistent VPC placement** — `idp-fraud-check` has DB credentials in env vars but is NOT in a VPC. `idp-classification` is also outside VPC with the Anthropic API key exposed.

3. **SSL with `rejectUnauthorized: false`** — Both `mark-complete` and `idp-api` connect to Aurora with certificate validation disabled, vulnerable to MITM attacks.

4. **No API authentication** — The `idp-api` Lambda has CORS `Access-Control-Allow-Origin: '*'` and no authentication mechanism. Anyone who discovers the API Gateway URL can read all document data.

5. **SQL injection risk** — In `idp-api`, the documents endpoint does: `` `SELECT * FROM ${docType}` `` — if `docType` is manipulated, this is a SQL injection vector. The timeseries endpoint interpolates `hours` directly into SQL.

6. **SSN stored in plaintext** — The `paystub` table stores `ssn VARCHAR(11)` with no encryption.

7. **Presigned S3 URLs with 1-hour expiry** — Combined with no auth on the API, anyone can download any document.

### Remediation

```
P0-IMMEDIATE: Rotate the Anthropic API key
P0-IMMEDIATE: Rotate the DB password
P0: Move all secrets to AWS Secrets Manager or SSM Parameter Store (SecureString)
P0: Add authentication to idp-api (Cognito authorizer or API key)
P0: Fix SQL injection in table name lookup — use allowlist validation
P0: Enable ssl.rejectUnauthorized with RDS CA bundle
P1: Encrypt SSN at application level (AWS KMS envelope encryption)
P1: Place all Lambdas that need DB access in VPC; remove DB creds from Lambdas that don't need DB
P2: Reduce presigned URL expiry to 300 seconds
P2: Restrict CORS to specific origins
```

---

## 6. Observability — 🔴 RED

### Findings

**From the state machine configuration:**
```json
"loggingConfiguration": { "level": "OFF", "includeExecutionData": false },
"tracingConfiguration": { "enabled": false }
```

Both logging AND X-Ray tracing are completely disabled.

**Issues:**

1. **Step Functions logging OFF** — No execution history beyond the default 90-day console retention.
2. **X-Ray tracing disabled** — No distributed tracing across the pipeline.
3. **No structured logging standard** — Inconsistent `console.log` formats across Lambdas.
4. **No CloudWatch alarms** — No alarms on execution failures, Lambda errors, queue depth, or Aurora connections.
5. **No custom metrics** — No tracking of documents/hour, straight-through rate, cost/document.
6. **`llm-client.ts` does log structured JSON** — Good, but classification and extraction don't use it.

### Remediation

```
P0: Enable Step Functions logging (level: ALL) and X-Ray tracing
P0: Create CloudWatch alarms for execution failures and Lambda errors
P1: Standardize structured logging with correlation ID (matterId + documentId)
P1: Refactor classification/extraction to use llm-client.ts
P1: Create CloudWatch dashboard with key operational metrics
P2: Implement custom metrics via CloudWatch EMF
```

---

## 7. Cost Optimization — 🟡 YELLOW

### Findings

1. **Standard Step Functions** — At $0.025/1000 state transitions, a 10-document pipeline run = ~100 transitions = $0.0025. At 10K docs/day ≈ $25/day. **Express Workflows would save 80%+** for the inner Map iteration.

2. **Lambda memory potentially over-provisioned:** quality-check and classification at 1024 MB likely need only 512 MB. Fraud-check is a mock/stub at 512 MB — 128 MB sufficient.

3. **Double S3 reads** — Both classification and extraction independently read the same document from S3.

4. **Anthropic model choice** — Using `claude-sonnet-4` for classification. A cheaper model (Haiku) could reduce classification costs 10x.

### Remediation

```
P2: Consider Express Workflows for inner Map iteration
P2: Run Lambda Power Tuning on all functions
P2: Evaluate Claude Haiku for classification
P3: Implement S3 read caching in Lambda /tmp
```

---

## 8. Disaster Recovery — 🟡 YELLOW

### Findings

1. **Aurora PostgreSQL** — Using Aurora cluster with automatic multi-AZ replication and automated backups. Backup retention should be reviewed.
2. **S3** — 11 9s durability. Documents safe.
3. **Single-region** — us-east-1 only. Regional outage = full platform outage.
4. **No IaC visible** — No CloudFormation, CDK, SAM, or Terraform in the repository. Infrastructure cannot be reliably recreated.
5. **SQS retention** — 14 days. Extended review system outage would lose pending tasks.

### Remediation

```
P0: Implement IaC (CDK recommended) for all resources
P1: Increase Aurora backup retention to 7+ days
P1: Create operational runbook
P2: Document RTO/RPO targets and validate
P3: Evaluate multi-region active-passive for production
```

---

## 9. API Design — 🟡 YELLOW

### Findings

**Good:** Clean REST endpoints, pagination, presigned URLs for downloads, CORS enabled.

**Issues:**

1. **No authentication** — Critical. See Security.
2. **SQL injection via table name** — `SELECT * FROM ${docType}` where docType comes from DB content.
3. **N+1 query problem** — `/api/documents` makes 1 + N queries (one per document for extraction data).
4. **New DB connection per request** — No connection pooling.
5. **No input validation** — `limit=999999` would scan entire table.

### Remediation

```
P0: Add authentication and fix SQL injection (see Security)
P1: Implement RDS Proxy for connection pooling
P1: Replace N+1 queries with JOINs
P2: Add input validation (max limit=100, hours=168)
```

---

## 10. HITL Workflow — 🟢 GREEN

### Findings

**Well implemented:**
- `waitForTaskToken` pattern correctly used on both HITL and fraud review states
- Task token properly extracted via `$$.Task.Token`
- Reasonable timeouts: 24h (HITL), 48h (fraud review)
- Rich context in SQS messages (documentId, matterId, documentType, extractionResult)
- Post-review flow routes to MarkComplete

**Minor Issues:**
1. **No HITL service implementation found** — Callback mechanism likely exists elsewhere.
2. **No SLA monitoring** — No alarm when tasks approach timeout.
3. **No Catch on HITL/fraud states** — A timeout produces `States.Timeout` which fails the Map iteration.

### Remediation

```
P1: Add Catch on RouteToHITL and RouteToFraudReview for States.Timeout
P1: Add CloudWatch alarm on HITL queue age (warn at 12h, critical at 20h)
P2: Add DLQ to both queues with alerting
```

---

## Priority Summary

### 🔴 P0 — Do Now

| # | Action | Area |
|---|--------|------|
| 1 | **Rotate Anthropic API key immediately** | Security |
| 2 | **Rotate DB password immediately** | Security |
| 3 | Move all secrets to Secrets Manager / SSM SecureString | Security |
| 4 | Add authentication to idp-api | Security |
| 5 | Fix SQL injection in table name lookup | Security / API |
| 6 | Enable Step Functions logging and X-Ray tracing | Observability |
| 7 | Wrap mark-complete DB writes in a transaction | Data Integrity |
| 8 | Add Catch on ProcessDocuments Map state | Reliability |
| 9 | Add Retry to all Lambda states missing it | Reliability |
| 10 | Create CloudWatch alarms for failures and errors | Observability |

### 🟡 P1 — Next Sprint

| # | Action | Area |
|---|--------|------|
| 1 | Implement RDS Proxy for connection pooling | Scalability / API |
| 2 | Set reserved concurrency on Lambdas | Scalability |
| 3 | Add DLQs to SQS queues | Reliability |
| 4 | Implement IaC (CDK) | DR |
| 5 | Encrypt SSN at application level | Security |
| 6 | Enable ssl.rejectUnauthorized with RDS CA bundle | Security |
| 7 | Standardize structured logging with correlation IDs | Observability |
| 8 | Add HITL timeout handling and SLA alarms | HITL |
| 9 | Refactor classification to use llm-client.ts | Reliability / Cost |
| 10 | Fix N+1 query in API | API |

### 🟢 P2/P3 — Backlog

- Lambda Power Tuning
- Express Workflows evaluation
- Multi-region DR planning
- Input validation hardening
- Claude Haiku for classification
- S3 lifecycle policies
- Operational runbook

---

*Assessment complete. The platform has a solid architectural foundation — the Step Functions design, HITL pattern, and data model are sound. The critical gaps are operational: secrets management, observability, and transaction safety. Fixing P0 items eliminates the highest-risk issues and brings the platform to production-ready baseline.*
