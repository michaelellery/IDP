# HITL Case Management — Technical Architecture

**Author:** Adam Chen, Senior Solutions Architect
**Date:** 2026-03-06
**Status:** Draft v1.0
**Source PRD:** HITL-PRD.md (Jessica Chen)

---

## 1. System Architecture

### 1.1 How HITL Fits Into the Existing Pipeline

The existing Step Functions pipeline already has HITL and Fraud Review routing built in. The `ConfidenceGate` Choice state routes documents with extraction confidence < 0.85 to `RouteToHITL`, and fraud-flagged documents to `RouteToFraudReview`. Both use the `sqs:sendMessage.waitForTaskToken` integration pattern — the pipeline **pauses** until a human calls `SendTaskSuccess` or `SendTaskFailure`.

**What exists today:**
- `RouteToHITL` → sends to SQS queue `idp-dev-hitl-queue` with `waitForTaskToken` (timeout: 86,400s = 24h)
- `RouteToFraudReview` → sends to SQS queue `idp-dev-fraud-review-queue` with `waitForTaskToken` (timeout: 172,800s = 48h)
- Both pass `taskToken` in the SQS message body
- After either completes → `MarkComplete` Lambda → pipeline ends

**What we're building:**
- SQS consumer Lambda that reads messages and inserts into `hitl_queue` table
- HITL API endpoints added to the existing `idp-api` Lambda
- A new frontend (single HTML file, like the existing viewer) for the review workflow
- `SendTaskSuccess` / `SendTaskFailure` calls from the API Lambda on approve/reject

### 1.2 Component Diagram

```
                        ┌─────────────────────────────┐
                        │   Step Functions Pipeline    │
                        │                              │
                        │  Decomposition → Quality →   │
                        │  Classification → Parallel   │
                        │  (Extraction + Fraud) →      │
                        │  ContentValidation →         │
                        │  ConfidenceGate              │
                        └──────┬──────────┬────────────┘
                               │          │
                    conf < 0.85│          │flagged
                               ▼          ▼
                    ┌──────────────┐  ┌──────────────────┐
                    │ SQS: hitl-   │  │ SQS: fraud-      │
                    │ queue        │  │ review-queue      │
                    │              │  │                   │
                    │ (waitFor     │  │ (waitForTaskToken)│
                    │  TaskToken)  │  │                   │
                    └──────┬───────┘  └──────┬────────────┘
                           │                 │
                           ▼                 ▼
                    ┌─────────────────────────────────┐
                    │  SQS Consumer Lambda (NEW)      │
                    │  - Reads SQS message            │
                    │  - Inserts into hitl_queue table │
                    │  - Stores task token             │
                    │  - Calculates SLA deadline       │
                    └──────────────┬──────────────────┘
                                   │
                                   ▼
┌────────────────┐    ┌─────────────────────────┐    ┌─────────────┐
│                │    │   Aurora PostgreSQL      │    │             │
│  HITL UI       │◄──►│                         │◄──►│ idp-api     │
│  (Browser)     │    │  document_metadata      │    │ Lambda      │
│                │    │  paystub / w2 / etc.     │    │ (extended)  │
│  - Queue view  │    │  hitl_queue  (NEW)       │    │             │
│  - Review form │    │  hitl_reviews (NEW)      │    │ + HITL      │
│  - PDF viewer  │    │  hitl_locks  (NEW)       │    │   endpoints │
│                │    │  hitl_notes  (NEW)       │    │             │
└───────┬────────┘    └─────────────────────────┘    └──────┬──────┘
        │                                                    │
        │              API Gateway (existing)                │
        └────────────────────────────────────────────────────┘
                                                             │
                                            on approve/reject│
                                                             ▼
                                              ┌──────────────────────┐
                                              │ Step Functions API   │
                                              │ SendTaskSuccess /    │
                                              │ SendTaskFailure      │
                                              └──────────┬───────────┘
                                                         │
                                                         ▼
                                              ┌──────────────────────┐
                                              │ MarkComplete Lambda  │
                                              │ (existing)           │
                                              └──────────────────────┘
```

### 1.3 Data Flow: End-to-End

1. Pipeline reaches `ConfidenceGate` → routes to `RouteToHITL` or `RouteToFraudReview`
2. Step Functions sends SQS message with `{ documentId, matterId, documentType, extractionResult, taskToken }`
3. Pipeline **pauses** waiting for task token callback
4. **SQS Consumer Lambda** (new, triggered by SQS event source mapping) reads message:
   - Inserts row into `hitl_queue` with task token, SLA deadline, queue type
   - Updates `document_metadata.status` to `HITL_REVIEW` or `FRAUD_REVIEW`
5. Reviewer opens HITL UI → sees document in queue (`GET /api/hitl/queue`)
6. Reviewer claims document (`POST /api/hitl/claim/{id}`) → lock created in `hitl_locks`
7. Reviewer views document details (`GET /api/hitl/document/{id}`) → PDF + extracted fields
8. Frontend sends heartbeats (`POST /api/hitl/heartbeat/{id}`) every 60s
9. Reviewer approves (`PUT /api/hitl/review/{id}` with `action: "approve"`):
   - API Lambda reads task token from `hitl_queue`
   - Calls `SendTaskSuccess({ taskToken, output: JSON.stringify(correctedData) })`
   - Inserts audit record into `hitl_reviews`
   - Deletes from `hitl_queue`, deletes lock from `hitl_locks`
   - Updates `document_metadata.status` to `COMPLETE`
10. Step Functions resumes → `MarkComplete` Lambda runs → pipeline succeeds

---

## 2. Database Schema

### 2.1 Schema Design

Jessica's PRD appendix has the right tables but needs several improvements for production use. Key changes from her schema:

- **`hitl_queue`** (new) — the PRD only has locks and reviews, but we need a dedicated queue table to store the task token and SLA metadata. Without this, we'd have to query SQS or store tokens in `document_metadata`.
- **`hitl_locks`** — keeping as PRD specified, but adding `lock_id` UUID for idempotent release operations.
- **`hitl_reviews`** — improved with execution ARN for traceability.
- **`hitl_notes`** — unchanged from PRD, it's fine.
- **No `hitl_users` table** — Phase 1 uses a simple hardcoded user list in the API (see Section 7). Phase 2 adds Cognito.

### 2.2 DDL — Ready to Execute

```sql
-- =============================================================
-- HITL Queue: pending review items with task tokens
-- =============================================================
CREATE TABLE hitl_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL,
    matter_id VARCHAR(64),
    document_type VARCHAR(50) NOT NULL,
    queue_type VARCHAR(20) NOT NULL DEFAULT 'hitl',  -- 'hitl' or 'fraud'
    task_token TEXT NOT NULL,                          -- Step Functions callback token
    execution_arn TEXT,                                -- for debugging / tracing
    confidence NUMERIC(5,4),
    extraction_data JSONB,                            -- snapshot of extraction at queue time
    fraud_signals JSONB,                              -- fraud check results (fraud queue only)
    status VARCHAR(20) NOT NULL DEFAULT 'pending',    -- pending, in_review, escalated
    priority INTEGER NOT NULL DEFAULT 0,              -- higher = more urgent
    sla_deadline TIMESTAMPTZ NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sqs_message_id VARCHAR(128),                      -- for deduplication
    CONSTRAINT fk_hitl_queue_document FOREIGN KEY (document_id)
        REFERENCES document_metadata(document_name)
);

-- Queue listing: filter by status + sort by SLA
CREATE INDEX idx_hitl_queue_status_sla ON hitl_queue(queue_type, status, sla_deadline);
-- Lookup by document
CREATE INDEX idx_hitl_queue_document ON hitl_queue(document_id);
-- Deduplication on SQS re-delivery
CREATE UNIQUE INDEX idx_hitl_queue_sqs_dedup ON hitl_queue(sqs_message_id) WHERE sqs_message_id IS NOT NULL;

-- =============================================================
-- HITL Locks: document-level pessimistic locks with expiry
-- =============================================================
CREATE TABLE hitl_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL UNIQUE,
    locked_by VARCHAR(64) NOT NULL,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_hitl_locks_document FOREIGN KEY (document_id)
        REFERENCES document_metadata(document_name)
);

CREATE INDEX idx_hitl_locks_expires ON hitl_locks(expires_at);

-- =============================================================
-- HITL Reviews: immutable audit trail of all review actions
-- =============================================================
CREATE TABLE hitl_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL,
    queue_id UUID,                                    -- reference to hitl_queue row
    reviewer_id VARCHAR(64) NOT NULL,
    reviewer_name VARCHAR(128),
    action VARCHAR(20) NOT NULL,                      -- approve, reject, escalate, confirm_fraud, false_positive
    corrected_fields JSONB,                           -- { fieldName: newValue, ... }
    original_fields JSONB,                            -- { fieldName: originalValue, ... } (snapshot)
    rejection_reason VARCHAR(50),
    rejection_note TEXT,
    escalation_reason TEXT,
    fraud_type VARCHAR(50),
    fraud_evidence TEXT,
    review_duration_seconds INTEGER,                  -- claimed_at → reviewed_at
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_hitl_reviews_document FOREIGN KEY (document_id)
        REFERENCES document_metadata(document_name)
);

CREATE INDEX idx_hitl_reviews_document ON hitl_reviews(document_id);
CREATE INDEX idx_hitl_reviews_reviewer ON hitl_reviews(reviewer_id);
CREATE INDEX idx_hitl_reviews_created ON hitl_reviews(created_at DESC);
CREATE INDEX idx_hitl_reviews_action ON hitl_reviews(action, created_at DESC);

-- =============================================================
-- HITL Notes: comments on documents
-- =============================================================
CREATE TABLE hitl_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL,
    author_id VARCHAR(64) NOT NULL,
    author_name VARCHAR(128),
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_hitl_notes_document FOREIGN KEY (document_id)
        REFERENCES document_metadata(document_name)
);

CREATE INDEX idx_hitl_notes_document ON hitl_notes(document_id, created_at);

-- =============================================================
-- Add columns to document_metadata for HITL tracking
-- =============================================================
ALTER TABLE document_metadata
    ADD COLUMN IF NOT EXISTS hitl_queued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS hitl_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS hitl_reviewer_id VARCHAR(64);
```

### 2.3 Index Strategy Notes

- **`idx_hitl_queue_status_sla`** is the primary query path — every queue listing filters by `(queue_type, status)` and sorts by `sla_deadline`. This composite index covers the exact query pattern.
- **`idx_hitl_queue_sqs_dedup`** is a partial unique index — only applies when `sqs_message_id` is set, keeping index size small. Prevents double-processing on SQS redelivery.
- **`idx_hitl_reviews_created DESC`** — audit log queries almost always sort newest-first.
- Locks table is small (max = number of concurrent reviewers ≈ 50), so the single `expires_at` index is sufficient for expired lock cleanup.

---

## 3. API Architecture

### 3.1 Endpoint Review — Jessica's 14 Endpoints

Jessica's PRD defines 14 endpoints. My assessment:

| # | Endpoint | PRD | Verdict | Notes |
|---|----------|-----|---------|-------|
| 1 | `GET /api/hitl/queue` | ✅ | **Keep as-is** | Well-specified. Add `assignedTo` filter. |
| 2 | `POST /api/hitl/claim/{id}` | ✅ | **Keep** | Return full document detail to save a round-trip. |
| 3 | `POST /api/hitl/release/{id}` | ✅ | **Keep** | |
| 4 | `POST /api/hitl/heartbeat/{id}` | ✅ | **Keep** | |
| 5 | `GET /api/hitl/document/{id}` | ✅ | **Keep** | Extend existing `/api/documents/{id}` with HITL fields. |
| 6 | `PUT /api/hitl/review/{id}` | ✅ | **Keep** | This is the critical path — approve/reject/escalate. |
| 7 | `POST /api/hitl/document/{id}/notes` | ✅ | **Keep** | |
| 8 | `POST /api/hitl/reassign/{id}` | ✅ | **Defer to P1+** | Supervisor only. Not MVP. |
| 9 | `GET /api/hitl/stats` | ✅ | **Keep, simplify** | MVP: just queue counts + SLA breaches. |
| 10 | `GET /api/hitl/history` | ✅ | **Keep** | |
| 11 | `GET /api/hitl/document/{id}/history` | ✅ | **Merge with #5** | Return history in the document detail response. |
| 12–14 | WebSocket endpoints (PRD §5.3 SLA alerts) | Implied | **Defer** | Use polling in Phase 1. WebSocket adds complexity. |

**Net: 10 endpoints for MVP.** This is manageable in the existing Lambda.

### 3.2 Lambda Architecture — Extend `idp-api`

**Decision: Extend the existing `idp-api` Lambda.** Reasons:
- Same DB connection pattern (Secrets Manager → pg Client)
- Same API Gateway
- Same IAM role (just needs `states:SendTaskSuccess` and `states:SendTaskFailure` added)
- The existing Lambda is ~150 lines. Adding HITL routes keeps it under 500 — well within a single-file Lambda.

**New Lambda needed:** An SQS consumer Lambda (`idp-hitl-queue-consumer`) triggered by SQS event source mappings on both queues. This is a separate Lambda because SQS triggers use a different invocation pattern (event source mapping, not API Gateway).

**IAM Policy additions to `idp-api` role:**

```json
{
  "Effect": "Allow",
  "Action": [
    "states:SendTaskSuccess",
    "states:SendTaskFailure"
  ],
  "Resource": "arn:aws:states:us-east-1:430695043165:stateMachine:idp-dev-document-pipeline"
}
```

### 3.3 Handler Structure

```javascript
// Added to existing idp-api/index.js handler, after existing routes:

const method = event.requestContext?.http?.method || 'GET';

// HITL Queue listing
if (path === '/api/hitl/queue') { return handleHitlQueue(db, qs, event); }

// Claim a document
if (path.match(/^\/api\/hitl\/claim\/[^/]+$/) && method === 'POST') {
  const docId = decodeURIComponent(path.split('/')[4]);
  return handleHitlClaim(db, docId, event);
}

// Release a claimed document
if (path.match(/^\/api\/hitl\/release\/[^/]+$/) && method === 'POST') {
  const docId = decodeURIComponent(path.split('/')[4]);
  return handleHitlRelease(db, docId, event);
}

// Heartbeat
if (path.match(/^\/api\/hitl\/heartbeat\/[^/]+$/) && method === 'POST') {
  const docId = decodeURIComponent(path.split('/')[4]);
  return handleHitlHeartbeat(db, docId, event);
}

// Get document for review (extends existing /api/documents/:id)
if (path.match(/^\/api\/hitl\/document\/[^/]+$/) && method === 'GET') {
  const docId = decodeURIComponent(path.split('/')[4]);
  return handleHitlDocumentGet(db, docId);
}

// Submit review decision
if (path.match(/^\/api\/hitl\/review\/[^/]+$/) && method === 'PUT') {
  const docId = decodeURIComponent(path.split('/')[4]);
  const body = JSON.parse(event.body || '{}');
  return handleHitlReview(db, docId, body, event);
}

// Add note
if (path.match(/^\/api\/hitl\/document\/[^/]+\/notes$/) && method === 'POST') {
  const docId = decodeURIComponent(path.split('/')[4]);
  const body = JSON.parse(event.body || '{}');
  return handleHitlNoteAdd(db, docId, body, event);
}

// Stats
if (path === '/api/hitl/stats') { return handleHitlStats(db, qs); }

// Audit history
if (path === '/api/hitl/history') { return handleHitlHistory(db, qs); }

// Reassign (supervisor)
if (path.match(/^\/api\/hitl\/reassign\/[^/]+$/) && method === 'POST') {
  const docId = decodeURIComponent(path.split('/')[4]);
  const body = JSON.parse(event.body || '{}');
  return handleHitlReassign(db, docId, body, event);
}
```

### 3.4 Request/Response Schemas (TypeScript Interfaces)

```typescript
// ── Queue ──────────────────────────────────────────────

interface HitlQueueItem {
  id: string;                    // hitl_queue.id (UUID)
  documentId: string;            // document_name
  documentType: string;
  matterId: string | null;
  borrowerName: string | null;   // derived from extraction
  confidenceScore: number;
  status: 'pending' | 'in_review' | 'escalated';
  queueType: 'hitl' | 'fraud';
  lockedBy: string | null;
  lockedByName: string | null;
  queuedAt: string;             // ISO 8601
  slaDeadline: string;          // ISO 8601
  slaStatus: 'ok' | 'warning' | 'breached';
  priority: number;
  lowConfidenceFields: string[];
}

interface HitlQueueResponse {
  items: HitlQueueItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

// ── Claim ──────────────────────────────────────────────

interface HitlClaimResponse {
  lockId: string;
  expiresAt: string;
  document: HitlDocumentDetail; // full doc returned to save round-trip
}

interface HitlClaimConflict {
  error: 'already_locked';
  lockedBy: string;
  lockedByName: string;
  lockedAt: string;
}

// ── Document Detail ────────────────────────────────────

interface HitlDocumentDetail {
  id: string;
  documentType: string;
  matterId: string | null;
  pdfUrl: string;               // pre-signed S3 URL (15 min expiry)
  status: string;
  lockedBy: string | null;
  queuedAt: string;
  slaDeadline: string;
  extractedData: {
    fields: Record<string, {
      value: string | number | null;
      confidence: number;
      boundingBox?: { x: number; y: number; w: number; h: number; page: number };
    }>;
  };
  fraudSignals: {
    riskScore: number;
    signals: Array<{
      type: string;
      description: string;
      probability: number;
      region?: { x: number; y: number; w: number; h: number; page: number };
    }>;
  } | null;
  notes: Array<{
    id: string;
    authorName: string;
    text: string;
    createdAt: string;
  }>;
  history: Array<{
    action: string;
    actorName: string;
    timestamp: string;
    details?: string;
  }>;
}

// ── Review Submission ──────────────────────────────────

interface HitlReviewRequest {
  action: 'approve' | 'reject' | 'escalate' | 'confirm_fraud' | 'false_positive';
  correctedFields?: Record<string, string | number>;   // only for approve
  rejectionReason?: string;      // ILLEGIBLE | WRONG_DOC_TYPE | INCOMPLETE_DOCUMENT | DUPLICATE | OTHER
  rejectionNote?: string;
  escalationReason?: string;
  fraudType?: string;            // FORGED_DOCUMENT | ALTERED_AMOUNTS | IDENTITY_FRAUD | SYNTHETIC_IDENTITY | OTHER
  fraudEvidence?: string;
}

interface HitlReviewResponse {
  status: 'completed' | 'rejected' | 'escalated' | 'fraud_confirmed';
  nextDocumentId: string | null; // next pending doc in queue for auto-advance
}

// ── Stats ──────────────────────────────────────────────

interface HitlStatsResponse {
  queues: {
    hitl: { pending: number; inReview: number; completedToday: number; slaBreaches: number };
    fraud: { pending: number; inReview: number; completedToday: number; slaBreaches: number };
  };
  slaCompliance: { hitl: number; fraud: number }; // 0.0-1.0
  avgReviewTimeSeconds: { hitl: number; fraud: number };
}

// ── History ────────────────────────────────────────────

interface HitlHistoryItem {
  id: string;
  documentId: string;
  reviewerId: string;
  reviewerName: string;
  action: string;
  duration: number | null;       // seconds
  fieldChanges: Array<{
    field: string;
    original: string;
    corrected: string;
    confidence: number;
  }> | null;
  timestamp: string;
}
```

### 3.5 Error Handling Pattern

Every HITL handler follows this pattern:

```javascript
async function handleHitlReview(db, docId, body, event) {
  const user = extractUser(event);  // from auth header
  if (!user) return respond(401, { error: 'unauthorized' });

  // 1. Validate the lock belongs to this user
  const lock = await db.query(
    'SELECT * FROM hitl_locks WHERE document_id = $1 AND locked_by = $2 AND expires_at > NOW()',
    [docId, user.id]
  );
  if (!lock.rows.length) return respond(403, {
    error: 'no_active_lock',
    message: 'You do not hold the lock on this document'
  });

  // 2. Get the queue item (has the task token)
  const queueItem = await db.query(
    'SELECT * FROM hitl_queue WHERE document_id = $1', [docId]
  );
  if (!queueItem.rows.length) return respond(404, { error: 'not_in_queue' });

  // 3. Execute DB changes in a transaction
  try {
    await db.query('BEGIN');

    // Insert audit record
    await db.query(`INSERT INTO hitl_reviews (...) VALUES (...)`, [...]);

    // Update document_metadata status
    await db.query(
      `UPDATE document_metadata SET status = $1, hitl_completed_at = NOW(),
       hitl_reviewer_id = $2, updated_at = NOW() WHERE document_name = $3`,
      [body.action === 'approve' ? 'COMPLETE' : 'REJECTED', user.id, docId]
    );

    // Delete from queue and locks
    await db.query('DELETE FROM hitl_queue WHERE document_id = $1', [docId]);
    await db.query('DELETE FROM hitl_locks WHERE document_id = $1', [docId]);

    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    return respond(500, { error: 'review_failed', message: e.message });
  }

  // 4. Call Step Functions AFTER commit
  // If this fails, a reconciliation job will retry
  try {
    if (body.action === 'approve') {
      await sfnClient.send(new SendTaskSuccessCommand({
        taskToken: queueItem.rows[0].task_token,
        output: JSON.stringify({ /* see §4.2 */ })
      }));
    } else if (body.action === 'reject') {
      await sfnClient.send(new SendTaskFailureCommand({
        taskToken: queueItem.rows[0].task_token,
        error: body.rejectionReason || 'REJECTED',
        cause: body.rejectionNote || 'Rejected by reviewer'
      }));
    }
  } catch (sfnErr) {
    console.error('SendTask failed — reconciliation needed:', sfnErr);
    // Don't fail the request — DB is already committed
  }

  // 5. Get next document for auto-advance
  const next = await db.query(
    `SELECT document_id FROM hitl_queue
     WHERE queue_type = $1 AND status = 'pending'
     ORDER BY sla_deadline ASC LIMIT 1`,
    [queueItem.rows[0].queue_type]
  );

  return respond(200, {
    status: body.action === 'approve' ? 'completed' : 'rejected',
    nextDocumentId: next.rows[0]?.document_id || null
  });
}
```

### 3.6 Authentication — Phase 1

**Decision: API key in header.** Simple, unblocking, swappable for Cognito JWT in Phase 2.

```
Authorization: Bearer idp-hitl-<random-32-chars>
```

Phase 1 auth implementation:

```javascript
const HITL_USERS = {
  'idp-hitl-reviewer-abc123': { id: 'user-1', name: 'A. Martinez', role: 'reviewer' },
  'idp-hitl-reviewer-def456': { id: 'user-2', name: 'B. Thompson', role: 'reviewer' },
  'idp-hitl-fraud-ghi789':   { id: 'user-3', name: 'F. Lee', role: 'fraud_analyst' },
  'idp-hitl-admin-jkl012':   { id: 'user-4', name: 'Admin', role: 'supervisor' },
};

function extractUser(event) {
  const auth = (event.headers?.authorization || '').replace('Bearer ', '');
  return HITL_USERS[auth] || null;
}
```

Store these keys in Secrets Manager alongside DB credentials. Distribute to reviewers. Swap for Cognito JWT validation in Phase 2 — the `extractUser()` function signature stays the same.

---

## 4. Step Functions Integration

### 4.1 Task Token Lifecycle

The SQS message body sent by Step Functions looks like this (from the state machine definition):

**HITL queue message:**
```json
{
  "documentId": "full-john-smith-paystub-2026",
  "matterId": "MATTER-1234",
  "documentType": "Paystub",
  "extractionResult": {
    "extractionResult": {
      "confidence": 0.62,
      "fields": { "...": "..." }
    }
  },
  "taskToken": "AQC...very-long-token...=="
}
```

**Fraud queue message:**
```json
{
  "documentId": "full-john-smith-w2-2026",
  "matterId": "MATTER-1234",
  "fraudSignals": { "...": "..." },
  "contentValidation": { "...": "..." },
  "taskToken": "AQC...very-long-token...=="
}
```

**Important:** The task token is a large opaque string (typically 1-2KB). It must be stored exactly as received — no truncation, no encoding changes.

**SQS Consumer Lambda** (`idp-hitl-queue-consumer`):

```javascript
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

exports.handler = async (event) => {
  const db = /* ... same DB connection pattern as idp-api ... */;
  await db.connect();

  const failedItems = [];
  try {
    for (const record of event.Records) {
      try {
        const body = JSON.parse(record.body);
        const queueType = record.eventSourceARN.includes('fraud-review') ? 'fraud' : 'hitl';
        const slaHours = queueType === 'fraud' ? 1 : 4;

        await db.query(`
          INSERT INTO hitl_queue (document_id, matter_id, document_type, queue_type,
            task_token, confidence, extraction_data, fraud_signals,
            sla_deadline, sqs_message_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
            NOW() + make_interval(hours => $9), $10)
          ON CONFLICT (sqs_message_id) DO NOTHING
        `, [
          body.documentId,
          body.matterId,
          body.documentType || 'unknown',
          queueType,
          body.taskToken,
          body.extractionResult?.extractionResult?.confidence || null,
          JSON.stringify(body.extractionResult || body),
          queueType === 'fraud' ? JSON.stringify(body.fraudSignals) : null,
          slaHours,
          record.messageId
        ]);

        const statusVal = queueType === 'fraud' ? 'FRAUD_REVIEW' : 'HITL_REVIEW';
        await db.query(
          `UPDATE document_metadata SET status = $1, hitl_queued_at = NOW(), updated_at = NOW()
           WHERE document_name = $2`,
          [statusVal, body.documentId]
        );
      } catch (itemErr) {
        console.error('Failed to process record:', record.messageId, itemErr);
        failedItems.push({ itemIdentifier: record.messageId });
      }
    }
  } finally {
    await db.end();
  }

  // Partial batch failure reporting
  return { batchItemFailures: failedItems };
};
```

### 4.2 SendTaskSuccess Payload

When a reviewer approves, the `output` is what Step Functions passes to the next state (`MarkComplete` via `$.hitlResult`):

```javascript
const output = JSON.stringify({
  reviewResult: 'approved',
  reviewerId: user.id,
  reviewerName: user.name,
  reviewedAt: new Date().toISOString(),
  correctedData: {
    documentType: queueItem.document_type,
    fields: mergedFields  // original extraction + reviewer corrections
  },
  fieldChanges: Object.keys(body.correctedFields || {}).map(field => ({
    field,
    original: String(originalFields[field] || ''),
    corrected: String(body.correctedFields[field])
  }))
});

await sfnClient.send(new SendTaskSuccessCommand({
  taskToken: queueItem.task_token,
  output: output
}));
```

The `MarkComplete` Lambda receives this in `$.hitlResult` and should use `correctedData` to update the extraction tables with reviewer-corrected values.

### 4.3 SendTaskFailure Payload

```javascript
await sfnClient.send(new SendTaskFailureCommand({
  taskToken: queueItem.task_token,
  error: body.rejectionReason || 'REJECTED',  // max 256 chars
  cause: JSON.stringify({                       // max 32,768 chars
    reason: body.rejectionReason,
    note: body.rejectionNote,
    reviewerId: user.id,
    reviewerName: user.name,
    reviewedAt: new Date().toISOString(),
    fraudType: body.fraudType || null,
    fraudEvidence: body.fraudEvidence || null
  })
}));
```

**Note:** `SendTaskFailure` causes the `RouteToHITL` / `RouteToFraudReview` state to fail. Since there's no `Catch` on these states in the current state machine definition, the entire Map iteration for this document will fail. **This is correct behavior** — rejected documents should not proceed to `MarkComplete`.

The API Lambda should update `document_metadata.status` to `REJECTED` before calling `SendTaskFailure`, since the existing `idp-mark-rejected` Lambda won't be invoked in this path.

### 4.4 Timeout Handling

Current timeouts:
- HITL queue: `TimeoutSeconds: 86400` (24 hours)
- Fraud queue: `TimeoutSeconds: 172800` (48 hours)

These are separate from SLA targets (HITL: 4h, Fraud: 1h). SLAs are soft deadlines for operational tracking; SF timeouts are hard deadlines after which the task token becomes invalid.

**Recommendation:** Add a `Catch` block on both `RouteToHITL` and `RouteToFraudReview` states to handle timeouts gracefully — route to an error handler that marks the document as `TIMEOUT` and alerts ops. This is a CDK/CloudFormation change, not a HITL UI concern, but should be done concurrently.

**Reconciliation:** Run a periodic check (every 5 min via CloudWatch scheduled rule) to detect `hitl_queue` rows where the SF timeout has passed without review. Clean up orphaned rows and alert ops.

---

## 5. Frontend Architecture

### 5.1 Approach: New Standalone HTML File

**Decision: New standalone `hitl-review.html`**, not an extension of the existing `idp-viewer.html`.

Rationale:
- The existing viewer is a read-only document browser. The HITL UI is a workflow tool with queue management, forms, locking, etc. Mixing them creates a maintenance nightmare.
- Both share the same API Gateway and S3 bucket for hosting.
- The existing viewer continues to serve its purpose (ops/debugging view of all documents).

**Tech stack for Phase 1:** Single HTML file with inline JS/CSS, using:
- **pdf.js** (CDN) for PDF rendering
- **Vanilla JS** — no React for Phase 1. A single-file approach ships faster and has zero build step. Migrate to React in Phase 2 if needed.

### 5.2 Application State

```javascript
const AppState = {
  // Auth
  currentUser: null,        // { id, name, role }
  apiKey: '',               // from localStorage

  // Queue view
  queueItems: [],
  queueFilters: {
    queueType: 'hitl', status: 'pending',
    sortBy: 'sla_deadline', sortOrder: 'asc',
    page: 1, pageSize: 25
  },
  queuePagination: { totalItems: 0, totalPages: 0 },

  // Review view
  activeDocument: null,     // HitlDocumentDetail
  lockId: null,
  editedFields: {},         // { fieldName: newValue } — only modified fields
  heartbeatInterval: null,  // setInterval ID
  claimedAt: null,          // for duration tracking

  // UI state
  currentView: 'queue',    // 'queue' | 'review' | 'stats'
  pdfPage: 1,
  pdfZoom: 1.0,
  pdfDoc: null,             // pdf.js document object
};
```

### 5.3 View Structure

```
┌─ hitl-review.html ─────────────────────────────────────────┐
│                                                             │
│  [Queue View]                                               │
│  ├── Stats bar (pending / in-review / breached / avg time)  │
│  ├── Filter bar (queue type, status, doc type, search)      │
│  └── Sortable table → click row to claim + open review      │
│                                                             │
│  [Review View]                                              │
│  ├── Header bar (doc info, SLA countdown, back button)      │
│  ├── Split pane:                                            │
│  │   ├── Left: PDF viewer (pdf.js canvas)                   │
│  │   └── Right: Extraction form (generated from schema)     │
│  ├── Notes panel (collapsible)                              │
│  └── Action bar (Approve / Reject / Escalate / Release)     │
│                                                             │
│  [Stats View] (simple — just renders /api/hitl/stats)       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.4 PDF Viewer Integration

Use pdf.js directly (CDN: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs`):

```javascript
async function renderPdf(url) {
  const pdf = await pdfjsLib.getDocument(url).promise;
  AppState.pdfDoc = pdf;
  document.getElementById('page-count').textContent = pdf.numPages;
  renderPage(1);
}

async function renderPage(num) {
  const page = await AppState.pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: AppState.pdfZoom });
  const canvas = document.getElementById('pdf-canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({
    canvasContext: canvas.getContext('2d'),
    viewport
  }).promise;
  AppState.pdfPage = num;
  document.getElementById('page-num').textContent = num;
}
```

### 5.5 Form Generation from Extraction Schema

The form is generated dynamically based on `documentType`. Field schemas stored as a JS object:

```javascript
const FIELD_SCHEMAS = {
  'Paystub': [
    { key: 'employers_name', label: 'Employer Name', type: 'text', required: true },
    { key: 'employers_ein', label: 'Employer EIN', type: 'text', required: true,
      pattern: /^\d{2}-\d{7}$/, placeholder: 'XX-XXXXXXX' },
    { key: 'employees_full_name', label: 'Employee Name', type: 'text', required: true },
    { key: 'ssn', label: 'SSN', type: 'masked', required: true },
    { key: 'pay_period_start_date', label: 'Pay Period Start', type: 'date', required: true },
    { key: 'pay_period_end_date', label: 'Pay Period End', type: 'date', required: true },
    { key: 'pay_date', label: 'Pay Date', type: 'date', required: true },
    { key: 'gross_pay', label: 'Gross Pay', type: 'currency', required: true },
    { key: 'net_pay', label: 'Net Pay', type: 'currency', required: true },
    { key: 'ytd_gross_earnings', label: 'YTD Gross', type: 'currency', required: true },
    { key: 'ytd_net_earnings', label: 'YTD Net', type: 'currency', required: false },
  ],
  'W-2': [ /* ... similar ... */ ],
  'Bank Statement': [ /* ... similar ... */ ],
};

function renderExtractionForm(docType, extractedData) {
  const schema = FIELD_SCHEMAS[docType] || [];
  const container = document.getElementById('extraction-form');
  container.innerHTML = '';

  for (const field of schema) {
    const fieldData = extractedData.fields?.[field.key] || {};
    const confidence = fieldData.confidence || 0;
    const indicator = confidence > 0.85 ? '🟢' : confidence > 0.50 ? '🟡' : '🔴';

    const row = document.createElement('div');
    row.className = 'field-row' + (confidence < 0.50 ? ' low-confidence' : '');
    row.innerHTML = `
      <label>${field.label} ${field.required ? '*' : ''}</label>
      <div class="field-input-wrapper">
        <input type="${field.type === 'currency' ? 'number' : field.type === 'date' ? 'date' : 'text'}"
               value="${fieldData.value || ''}"
               data-field="${field.key}"
               data-original="${fieldData.value || ''}"
               ${field.type === 'currency' ? 'step="0.01"' : ''}
               ${field.pattern ? `pattern="${field.pattern.source}"` : ''} />
        <span class="confidence" title="Confidence: ${(confidence * 100).toFixed(1)}%">${indicator}</span>
      </div>
    `;
    container.appendChild(row);

    // Track edits
    row.querySelector('input').addEventListener('input', (e) => {
      const key = e.target.dataset.field;
      const original = e.target.dataset.original;
      if (e.target.value !== original) {
        AppState.editedFields[key] = e.target.value;
        row.classList.add('modified');
      } else {
        delete AppState.editedFields[key];
        row.classList.remove('modified');
      }
    });
  }
}
```

### 5.6 Keyboard Shortcuts

```javascript
document.addEventListener('keydown', (e) => {
  if (AppState.currentView !== 'review') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch(e.key.toLowerCase()) {
    case 'a': showApproveConfirmation(); break;
    case 'r': showRejectModal(); break;
    case 'e': showEscalateModal(); break;
    case 'n': focusNoteInput(); break;
    case 'arrowleft':  prevPdfPage(); break;
    case 'arrowright': nextPdfPage(); break;
    case '+': case '=': zoomIn(); break;
    case '-':           zoomOut(); break;
  }
  if (e.ctrlKey && e.key === 'Enter') submitCurrentModal();
  if (e.key === 'Escape') closeModal();
});
```

### 5.7 Heartbeat & Lock Management

```javascript
function startHeartbeat(docId) {
  AppState.heartbeatInterval = setInterval(async () => {
    try {
      const res = await apiFetch(`/api/hitl/heartbeat/${docId}`, { method: 'POST' });
      if (!res.ok) {
        if (res.status === 410) {
          showLockExpiredWarning();
          stopHeartbeat();
        }
      }
    } catch (e) {
      console.error('Heartbeat failed:', e);
    }
  }, 60000);
}

function stopHeartbeat() {
  if (AppState.heartbeatInterval) {
    clearInterval(AppState.heartbeatInterval);
    AppState.heartbeatInterval = null;
  }
}

// Also stop heartbeat when navigating away
window.addEventListener('beforeunload', () => {
  if (AppState.lockId) {
    // Best-effort release via sendBeacon
    navigator.sendBeacon(
      `${API_BASE}/api/hitl/release/${AppState.activeDocument.id}`,
      JSON.stringify({ apiKey: AppState.apiKey })
    );
  }
});
```

---

## 6. Queue Management

### 6.1 Document Ingestion Flow

```
SQS Queue (hitl / fraud)
        │
        ▼
idp-hitl-queue-consumer Lambda (event source mapping)
        │
        ├── INSERT INTO hitl_queue (task_token, sla_deadline, ...)
        │   ON CONFLICT (sqs_message_id) DO NOTHING  ← dedup
        │
        └── UPDATE document_metadata SET status = 'HITL_REVIEW'
```

One Lambda handles both queues — differentiate by `event.Records[i].eventSourceARN`.

**SQS Event Source Mapping config:**
- Batch size: 10
- Batch window: 5 seconds
- Function response types: `ReportBatchItemFailures`
- Concurrency: 2

### 6.2 Document Locking

**Lock lifecycle:**

```
[Claim] → INSERT INTO hitl_locks (..., expires_at = NOW() + 30 min)
                               ↓
[Heartbeat every 60s] → UPDATE hitl_locks SET last_heartbeat = NOW(),
                         expires_at = NOW() + INTERVAL '30 minutes'
                         WHERE document_id = $1 AND locked_by = $2
                               ↓
[Submit/Release] → DELETE FROM hitl_locks WHERE document_id = $1
```

**Atomic claim operation (handles expired locks):**

```sql
-- First, clean up any expired lock on this document
DELETE FROM hitl_locks WHERE document_id = $1 AND expires_at < NOW();

-- Then attempt to insert (UNIQUE constraint prevents double-claim)
INSERT INTO hitl_locks (document_id, locked_by, expires_at)
VALUES ($1, $2, NOW() + INTERVAL '30 minutes')
ON CONFLICT (document_id) DO NOTHING
RETURNING *;

-- If no rows returned → someone else holds a valid lock
-- Query who holds it for the 409 response:
SELECT locked_by, locked_at FROM hitl_locks WHERE document_id = $1;
```

**Also update hitl_queue status on claim:**
```sql
UPDATE hitl_queue SET status = 'in_review' WHERE document_id = $1;
```

### 6.3 SLA Tracking

SLA deadlines are computed at ingestion time and stored in `hitl_queue.sla_deadline`.

**Queue listing query with SLA status:**

```sql
SELECT q.*,
  l.locked_by, l.locked_at,
  CASE
    WHEN q.sla_deadline < NOW() THEN 'breached'
    WHEN q.queue_type = 'fraud' AND q.sla_deadline < NOW() + INTERVAL '30 minutes' THEN 'warning'
    WHEN q.queue_type = 'hitl' AND q.sla_deadline < NOW() + INTERVAL '1 hour' THEN 'warning'
    ELSE 'ok'
  END AS sla_status
FROM hitl_queue q
LEFT JOIN hitl_locks l ON q.document_id = l.document_id AND l.expires_at > NOW()
WHERE q.queue_type = $1 AND q.status = ANY($2)
ORDER BY q.sla_deadline ASC
LIMIT $3 OFFSET $4;
```

**Alerting:** CloudWatch custom metric published every 5 minutes by a scheduled Lambda rule:

```sql
SELECT
  queue_type,
  COUNT(*) FILTER (WHERE sla_deadline < NOW()) AS breached,
  COUNT(*) FILTER (WHERE status = 'pending') AS pending,
  COUNT(*) FILTER (WHERE status = 'in_review') AS in_review
FROM hitl_queue
GROUP BY queue_type;
```

### 6.4 Step Functions Timeout vs SLA

| | HITL | Fraud |
|---|---|---|
| **SLA (soft)** | 4 hours | 1 hour |
| **SF Timeout (hard)** | 24 hours | 48 hours |

These are independent. SLAs drive operational urgency (UI warnings, supervisor alerts). SF timeouts are the safety net — after 24h/48h without a callback, the execution fails. **No changes needed** to state machine timeouts.

---

## 7. Security Considerations (Phase 1)

### 7.1 Authentication

API key per user (§3.6). Keys stored in Secrets Manager (`idp-dev/hitl-api-keys`). Each key maps to a user identity and role.

**Role enforcement matrix:**

| Action | reviewer | fraud_analyst | supervisor | auditor |
|--------|----------|---------------|------------|---------|
| View HITL queue | ✅ | ❌ | ✅ | ✅ |
| View Fraud queue | ❌ | ✅ | ✅ | ✅ |
| Claim/Review | ✅ (hitl) | ✅ (fraud) | ✅ (both) | ❌ |
| Reassign | ❌ | ❌ | ✅ | ❌ |
| View stats | ❌ | ❌ | ✅ | ✅ |
| View history | ✅ (own) | ✅ (own) | ✅ (all) | ✅ (all) |

### 7.2 PII Handling

- **SSN masking:** API returns only last 4 digits in GET responses. Full SSN never leaves the DB for display.
- **PDF URLs:** Pre-signed S3 URLs with 15-minute expiry, generated per-request.
- **No PII in Lambda logs:** Log document IDs, actions, and user IDs only. Never log field values.
- **Task tokens:** Not PII but sensitive — never expose to frontend. Keep in DB, use only server-side.

### 7.3 Audit Logging

Every state change is recorded immutably:

| Event | Table | Key Fields |
|-------|-------|------------|
| Document enters queue | `hitl_queue` | document_id, queued_at, sla_deadline, queue_type |
| Reviewer claims | `hitl_locks` | document_id, locked_by, locked_at |
| Lock released/expired | `hitl_locks` DELETE | (implicit — no lock row = available) |
| Review submitted | `hitl_reviews` | All review details, field-level diffs, duration |
| Note added | `hitl_notes` | author, text, timestamp |

`hitl_reviews` is append-only — no UPDATEs or DELETEs. This provides an immutable audit trail for compliance.

---

## 8. Implementation Plan

### 8.1 MVP Build Order

```
Phase 1A: Foundation (Week 1-2)
├── 1. Database migration — run DDL from §2.2
├── 2. SQS Consumer Lambda — ingest from both queues into hitl_queue
├── 3. Core HITL API endpoints in idp-api:
│   ├── GET  /api/hitl/queue
│   ├── POST /api/hitl/claim/{id}
│   ├── POST /api/hitl/release/{id}
│   ├── POST /api/hitl/heartbeat/{id}
│   ├── GET  /api/hitl/document/{id}
│   └── PUT  /api/hitl/review/{id}  (approve + reject only)
├── 4. IAM policy update (states:SendTaskSuccess / SendTaskFailure)
└── 5. API key auth setup in Secrets Manager

Phase 1B: UI + Polish (Week 3-4)
├── 6. HITL Review UI (hitl-review.html)
│   ├── Queue view with filters/sorting
│   ├── Review workspace with PDF + extraction form
│   ├── Approve/Reject flows with confirmation
│   └── Keyboard shortcuts
├── 7. Notes endpoint + UI integration
├── 8. Stats endpoint + simple stats view
└── 9. History/audit endpoint

Phase 1C: Hardening (Week 5)
├── 10. Escalation flow
├── 11. Reassign endpoint (supervisor)
├── 12. SLA alerting (CloudWatch metrics + alarm)
├── 13. Lock expiry cleanup (scheduled)
└── 14. End-to-end testing with real pipeline documents
```

### 8.2 Dependencies

```
[1. DB Migration] ──┬──→ [2. SQS Consumer] ──→ (documents appear in queue)
                    └──→ [3. API Endpoints] ──→ [6. UI]
                                            ──→ [7. Notes]
                                            ──→ [8. Stats]
                                            ──→ [9. History]

[4. IAM Policy]  ──→ [3. API: review endpoint specifically]
[5. Auth Setup]  ──→ [3. API: all endpoints]
```

**Critical path:** DB migration → SQS consumer → API endpoints → UI.

### 8.3 Complexity Estimates

| Component | Effort | Risk | Notes |
|-----------|--------|------|-------|
| DB Migration | 0.5 day | Low | Execute DDL from §2.2 |
| SQS Consumer Lambda | 2 days | Medium | New Lambda, event source mapping, dedup |
| HITL API (10 endpoints) | 5 days | Medium | Extending existing Lambda; review endpoint is most complex |
| IAM Policy Update | 0.5 day | Low | Add SF permissions to existing role |
| Auth Setup | 0.5 day | Low | Hardcoded user map + Secrets Manager keys |
| HITL Review UI | 5 days | High | PDF rendering, form generation, state management |
| SLA Alerting | 1 day | Low | CloudWatch metric + alarm |
| E2E Testing | 3 days | Medium | Need real documents flowing through pipeline |
| **Total** | **~18 dev-days** | | **~4 weeks × 1 dev, ~2.5 weeks × 2 devs** |

### 8.4 Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Task token too large for TEXT column | Approve fails silently | Test with real token from pipeline in week 1 |
| SendTaskSuccess fails after DB commit | Document stuck in pipeline | Reconciliation job every 5 min compares `hitl_reviews` with `hitl_queue` |
| PDF.js slow on large documents | Poor reviewer experience | Lazy page rendering; profile with real docs early |
| Concurrent claim race condition | Two reviewers claim same doc | `INSERT ... ON CONFLICT DO NOTHING` at DB level; 409 response in UI |
| SQS redelivery creates duplicate queue items | Duplicate reviews possible | Unique index on `sqs_message_id` with `ON CONFLICT DO NOTHING` |

---

## Appendix A: SQS Event Source Mapping Setup

```bash
# Create event source mapping for HITL queue
aws lambda create-event-source-mapping \
  --function-name idp-hitl-queue-consumer \
  --event-source-arn arn:aws:sqs:us-east-1:430695043165:idp-dev-hitl-queue \
  --batch-size 10 \
  --maximum-batching-window-in-seconds 5 \
  --function-response-types ReportBatchItemFailures \
  --profile idp-dev --region us-east-1

# Create event source mapping for Fraud queue
aws lambda create-event-source-mapping \
  --function-name idp-hitl-queue-consumer \
  --event-source-arn arn:aws:sqs:us-east-1:430695043165:idp-dev-fraud-review-queue \
  --batch-size 10 \
  --maximum-batching-window-in-seconds 5 \
  --function-response-types ReportBatchItemFailures \
  --profile idp-dev --region us-east-1
```

## Appendix B: Existing Infrastructure Reference

| Resource | ARN / URL |
|----------|-----------|
| State Machine | `arn:aws:states:us-east-1:430695043165:stateMachine:idp-dev-document-pipeline` |
| HITL SQS Queue | `https://sqs.us-east-1.amazonaws.com/430695043165/idp-dev-hitl-queue` |
| Fraud SQS Queue | `https://sqs.us-east-1.amazonaws.com/430695043165/idp-dev-fraud-review-queue` |
| API Gateway | `https://rzeejg3ra4.execute-api.us-east-1.amazonaws.com` |
| API Lambda | `idp-api` |
| DB Credentials | Secrets Manager: `idp-dev/db-credentials` |
| S3 Intake Bucket | `idp-dev-intake-430695043165` |
| S3 Documents Bucket | `idp-dev-documents-430695043165` |

---

*End of architecture document. Questions → Adam Chen, Solutions Architecture.*
