# HITL Case Management — Product Requirements Document

**Author:** Jessica Chen, Senior Product Manager
**Date:** 2026-03-06
**Status:** Draft v1.0
**Stakeholders:** IDP Engineering, Operations, Compliance

---

## Executive Summary

The IDP platform automates loan origination document processing but routes low-confidence extractions and fraud-flagged documents to human reviewers. Today, reviewers have a read-only viewer with no workflow tooling — no claiming, no editing, no approval flow. This PRD defines a full HITL Case Management interface that enables reviewers to efficiently process queued documents, correct extractions, and resume the automated pipeline via Step Functions task tokens.

**Goal:** Reduce average document review time to under 3 minutes while maintaining 99%+ data accuracy on reviewed documents.

---

## 1. User Personas

### 1.1 Document Reviewer

| Attribute | Detail |
|---|---|
| **Role** | Processes HITL queue items — corrects extracted data, approves or rejects |
| **Volume** | 40–80 documents per shift (8 hrs) |
| **Skills** | Familiar with loan doc types, data entry, basic financial literacy |
| **Pain points** | Currently uses read-only viewer + manual Slack escalation; no editing capability; no way to track what they've already reviewed |
| **Needs** | Fast claim → review → submit loop; keyboard shortcuts; side-by-side PDF + form |

### 1.2 Fraud Analyst

| Attribute | Detail |
|---|---|
| **Role** | Reviews fraud-flagged documents with deeper investigation |
| **Volume** | 10–25 documents per shift (lower volume, higher complexity) |
| **Skills** | Fraud detection training, document forensics basics, regulatory knowledge |
| **Pain points** | No visibility into why a document was flagged; no tools to compare against known fraud patterns |
| **Needs** | Fraud signal details, risk score breakdown, ability to flag for law enforcement escalation, access to original vs extracted data comparison |

### 1.3 Team Lead / Supervisor

| Attribute | Detail |
|---|---|
| **Role** | Monitors queue health, reassigns work, handles escalations |
| **Volume** | Oversees 5–10 reviewers |
| **Skills** | Operations management, domain expertise |
| **Pain points** | No visibility into queue depth, SLA breaches, or individual reviewer throughput |
| **Needs** | Real-time dashboard, ability to reassign locked documents, SLA alerts |

### 1.4 Quality Auditor

| Attribute | Detail |
|---|---|
| **Role** | Spot-checks completed reviews for accuracy |
| **Volume** | Reviews 10–15% of completed items |
| **Skills** | Deep domain expertise, attention to detail |
| **Pain points** | No audit trail; can't see what the reviewer changed vs. what the model extracted |
| **Needs** | Diff view (original extraction vs. reviewer edits), searchable history, ability to flag reviews for re-work |

---

## 2. User Stories

### P0 — Must Have (Launch Blockers)

| ID | As a... | I want to... | So that... | Acceptance Criteria |
|---|---|---|---|---|
| **S01** | Reviewer | View a filterable queue of pending HITL documents | I can find and prioritize my work | Queue shows document ID, type, borrower name, received time, SLA countdown, confidence score. Filterable by doc type, date range, priority. Sortable by any column. |
| **S02** | Reviewer | Claim a document for review | No one else works on it simultaneously | Clicking "Claim" locks the doc to me. Others see it as "In Review — [name]". Lock auto-expires after 30 min of inactivity. |
| **S03** | Reviewer | View the PDF alongside extracted data in a split pane | I can verify extractions against the source | PDF on left (zoomable, rotatable, multi-page nav). Editable form on right with all extracted fields. Fields show confidence scores via color coding. |
| **S04** | Reviewer | Edit extracted field values | I can correct errors before approval | Each field is editable with type-appropriate input (text, number, date, currency). Changed fields are visually marked. Original value shown on hover. |
| **S05** | Reviewer | Approve a document | The pipeline resumes with corrected data | Approve calls `SendTaskSuccess` with the corrected extraction payload. Document status → `COMPLETED`. Task token is consumed. |
| **S06** | Reviewer | Reject a document with a reason | The document is removed from the pipeline with explanation | Reject requires selecting a reason code + optional free-text. Calls `SendTaskFailure`. Document status → `REJECTED`. |
| **S07** | Fraud Analyst | View fraud signals and risk score for flagged documents | I can make informed fraud decisions | Fraud review workspace shows: risk score (0–100), fraud signal list with descriptions, flagged regions highlighted on PDF. |
| **S08** | Reviewer | Release a claimed document back to the queue | Someone else can pick it up if I can't finish | "Release" button unclaims the doc. My partial edits are discarded (or optionally saved as draft — P1). |

### P1 — Should Have (Fast Follow)

| ID | As a... | I want to... | So that... |
|---|---|---|---|
| **S09** | Reviewer | Escalate a document to a supervisor or fraud team | Edge cases get proper handling |
| **S10** | Reviewer | Add notes/comments to a document | Context is preserved for the next person |
| **S11** | Supervisor | View a dashboard of queue metrics and SLA status | I can manage team workload |
| **S12** | Supervisor | Reassign a locked document to a different reviewer | Work doesn't get stuck |
| **S13** | Auditor | View the diff between original extraction and reviewer edits | I can assess review quality |
| **S14** | Auditor | Flag a completed review for re-work | Errors get corrected |
| **S15** | Reviewer | Use keyboard shortcuts for common actions | I can work faster |
| **S16** | Reviewer | Auto-advance to the next document after submitting | I maintain flow without returning to queue |
| **S17** | Supervisor | Receive alerts when SLA thresholds are approaching | I can intervene before breaches |

### P2 — Nice to Have (Future)

| ID | As a... | I want to... | So that... |
|---|---|---|---|
| **S18** | Reviewer | Save draft edits without submitting | I can return to complex reviews later |
| **S19** | Supervisor | Configure auto-assignment rules | Work distributes evenly without manual intervention |
| **S20** | Auditor | Generate accuracy reports by reviewer | We can identify training needs |
| **S21** | Reviewer | See similar previously-reviewed documents | I have reference points for ambiguous cases |
| **S22** | System | Auto-assign documents round-robin to online reviewers | Queue drains without manual claiming |

---

## 3. UI Layout & Wireframes

### 3.1 Queue Dashboard

```
┌─────────────────────────────────────────────────────────────────────────┐
│  IDP Case Management                          [Jessica C.] [🔔] [⚙️]  │
├────────┬────────────────────────────────────────────────────────────────┤
│        │  Queue Dashboard                                              │
│ 📋 Queue│                                                              │
│ 📊 Stats│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│ 📝 Audit│  │ Pending  │ │In Review│ │ Urgent  │ │Avg Time │           │
│        │  │   47     │ │   12    │ │   3 ⚠️  │ │ 2m 34s  │           │
│        │  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
│        │                                                              │
│        │  Filters: [Doc Type ▾] [Priority ▾] [Date Range] [🔍 Search]│
│        │  View:    (●) HITL Queue  ( ) Fraud Queue  ( ) All           │
│        │                                                              │
│        │  ┌──┬──────────┬──────────┬────────┬────────┬──────┬───────┐ │
│        │  │☐ │ Doc ID   │ Type     │Borrower│ Conf.  │ SLA  │Action │ │
│        │  ├──┼──────────┼──────────┼────────┼────────┼──────┼───────┤ │
│        │  │☐ │ DOC-4821 │ Paystub  │ J.Smith│  62%   │ 2h13m│[Claim]│ │
│        │  │☐ │ DOC-4819 │ W-2      │ R.Jones│  45%   │ 1h02m│[Claim]│ │
│        │  │☐ │ DOC-4815 │ Bank Stmt│ A.Lee  │  71%   │ 3h41m│[Claim]│ │
│        │  │☐ │ DOC-4812 │ Paystub  │ M.Park │  58%   │ 0h22m│[Claim]│ │
│        │  │  │          │          │        │        │  ⚠️  │       │ │
│        │  └──┴──────────┴──────────┴────────┴────────┴──────┴───────┘ │
│        │                                          Page 1 of 4  [< >]  │
└────────┴────────────────────────────────────────────────────────────────┘
```

**Notes:**
- SLA column shows countdown. Red/⚠️ when < 30 min remaining.
- Confidence column color-coded: red < 50%, yellow 50–70%, green > 70%.
- Clicking a row opens the Review Workspace. Clicking "Claim" claims + opens.
- Bulk actions (via checkboxes): assign to reviewer, change priority.

### 3.2 Review Workspace

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Queue    DOC-4821 • Paystub • J. Smith    SLA: 2h13m  🔒   │
├─────────────────────────────────┬───────────────────────────────────────┤
│                                 │  Extracted Data          [Conf: 62%] │
│                                 │                                      │
│   ┌───────────────────────┐     │  Employer ─────────────────────────  │
│   │                       │     │  Company Name: [Acme Corp_______] 🟢│
│   │                       │     │  EIN:          [12-3456789______] 🟡│
│   │     PDF VIEWER        │     │                                      │
│   │                       │     │  Employee ─────────────────────────  │
│   │   (zoom/rotate/pan)   │     │  Name:     [John Smith_________] 🟢│
│   │                       │     │  SSN:      [***-**-1234________] 🟡│
│   │                       │     │                                      │
│   │                       │     │  Pay Period ───────────────────────  │
│   │                       │     │  Start:    [2026-01-01_________] 🟢│
│   │                       │     │  End:      [2026-01-15_________] 🟢│
│   │                       │     │  Pay Date: [2026-01-20_________] 🔴│
│   │                       │     │                                      │
│   │   Page [1] of 3       │     │  Earnings ───────────────────────── │
│   │   [◀] [▶] [🔍+] [🔍-]│     │  Gross Pay:  [$4,250.00________] 🟡│
│   │   [↻ rotate]          │     │  Net Pay:    [$3,102.47________] 🟢│
│   └───────────────────────┘     │  YTD Gross:  [$8,500.00________] 🟢│
│                                 │                                      │
│  ┌────────────────────────────┐ │  ─────────────────────────────────── │
│  │ 💬 Notes (2)              │ │                                      │
│  │ [Add note...            ] │ │  [Approve ✓]  [Reject ✗]  [Escalate]│
│  │ Mar 6 14:02 - Auto: Low  │ │                                      │
│  │ confidence on pay date    │ │  Keyboard: A=approve R=reject        │
│  └────────────────────────────┘ │  E=escalate   N=add note            │
└─────────────────────────────────┴───────────────────────────────────────┘
```

**Notes:**
- Confidence indicators per field: 🟢 > 85%, 🟡 50–85%, 🔴 < 50%.
- Clicking a field in the form highlights the corresponding region on the PDF (if bounding box data available).
- Changed fields show a blue left-border and "Modified" badge. Hover to see original value.
- Split pane is resizable via drag handle.

### 3.3 Fraud Review Workspace

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Queue   DOC-4799 • W-2 • R. Jones   SLA: 0h42m  🔒 FRAUD  │
├──────────────────────┬──────────────────────┬───────────────────────────┤
│                      │  Extracted Data      │  Fraud Signals            │
│                      │                      │                           │
│  ┌────────────────┐  │  [Same as Review     │  Risk Score: ███████░ 78  │
│  │                │  │   Workspace form]    │                           │
│  │  PDF VIEWER    │  │                      │  ⚠️ Font inconsistency    │
│  │                │  │                      │    detected in employer   │
│  │                │  │                      │    name region (p=0.91)   │
│  │                │  │                      │                           │
│  │                │  │                      │  ⚠️ EIN does not match    │
│  │                │  │                      │    known employer DB      │
│  │                │  │                      │    (p=0.87)               │
│  │                │  │                      │                           │
│  │                │  │                      │  ⚠️ Metadata: PDF created │
│  │                │  │                      │    with editor tool, not  │
│  │                │  │                      │    scanned (p=0.95)       │
│  │                │  │                      │                           │
│  └────────────────┘  │                      │  ────────────────────     │
│                      │                      │  Prior flags: 0           │
│                      │                      │  Borrower history: Clean  │
│                      │                      │                           │
│                      │ [Approve] [Reject]   │  [Confirm Fraud]          │
│                      │ [Escalate to LE]     │  [False Positive]         │
└──────────────────────┴──────────────────────┴───────────────────────────┘
```

**Notes:**
- Three-pane layout: PDF | Data | Fraud Signals.
- "Confirm Fraud" triggers a different downstream workflow (compliance notification, borrower flagging).
- "Escalate to LE" (Law Enforcement) is a P2 feature — button present but disabled in Phase 1 with tooltip "Coming soon."

### 3.4 Supervisor Dashboard

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Supervisor Dashboard                              [Today] [This Week] │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ HITL Pending │ │ Fraud Pending│ │ SLA Breaches │ │ Completed    │  │
│  │     47       │ │      8       │ │    3 🔴      │ │   142 today  │  │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘  │
│                                                                         │
│  Queue Depth (24h)                 SLA Compliance                       │
│  80│ ╭─╮                           ┌────────────────────────┐          │
│  60│╭╯ ╰─╮    ╭╮                   │ HITL:  96.2%  (target  │          │
│  40│╯    ╰──╮╭╯╰╮                  │        95%)   🟢       │          │
│  20│        ╰╯   ╰──               │ Fraud: 88.1%  (target  │          │
│   0└──────────────────              │        95%)   🔴       │          │
│    6am  9am  12pm 3pm              └────────────────────────┘          │
│                                                                         │
│  Reviewer Performance                                                   │
│  ┌───────────────┬────────┬──────────┬───────────┬──────────┐          │
│  │ Reviewer      │ Done   │ Avg Time │ Accuracy  │ Active   │          │
│  ├───────────────┼────────┼──────────┼───────────┼──────────┤          │
│  │ A. Martinez   │   31   │  2m 12s  │   98.2%   │ ● Online │          │
│  │ B. Thompson   │   28   │  2m 45s  │   96.8%   │ ● Online │          │
│  │ C. Williams   │   22   │  3m 01s  │   97.5%   │ ○ Away   │          │
│  └───────────────┴────────┴──────────┴───────────┴──────────┘          │
│                                                                         │
│  SLA Breaches                                                           │
│  • DOC-4812 — Paystub — 22min overdue — Unassigned [Assign ▾]         │
│  • DOC-4798 — W-2 — 11min overdue — Locked by C. Williams [Reassign]  │
│  • DOC-4801 — Bank Stmt — 3min overdue — Unassigned [Assign ▾]        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Audit Log

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Audit Log                                                              │
├─────────────────────────────────────────────────────────────────────────┤
│  Filters: [Reviewer ▾] [Action ▾] [Doc Type ▾] [Date Range] [🔍]     │
│  [☐ Show field-level changes]                                          │
│                                                                         │
│  ┌───────────┬──────────┬──────────┬────────┬──────────┬─────────────┐ │
│  │ Timestamp │ Doc ID   │ Reviewer │ Action │ Duration │ Details     │ │
│  ├───────────┼──────────┼──────────┼────────┼──────────┼─────────────┤ │
│  │ 14:32:01  │ DOC-4820 │ A.Martin │Approved│  1m 48s  │ 2 fields    │ │
│  │           │          │          │        │          │ modified    │ │
│  │ 14:28:15  │ DOC-4818 │ B.Thomps │Rejected│  0m 42s  │ Reason:     │ │
│  │           │          │          │        │          │ Illegible   │ │
│  │ 14:25:03  │ DOC-4816 │ A.Martin │Approved│  2m 31s  │ 0 fields    │ │
│  │           │          │          │        │          │ modified    │ │
│  │ 14:22:47  │ DOC-4799 │ F.Lee    │Confirm │  8m 12s  │ Fraud       │ │
│  │           │          │          │ Fraud  │          │ confirmed   │ │
│  └───────────┴──────────┴──────────┴────────┴──────────┴─────────────┘ │
│                                                                         │
│  Expand row → shows field-level diff:                                   │
│  ┌─────────────────────────────────────────────────────┐               │
│  │ DOC-4820 changes:                                   │               │
│  │  • Pay Date: 2026-01-20 → 2026-01-22 (conf: 34%)   │               │
│  │  • Gross Pay: $4,520.00 → $4,250.00 (conf: 61%)    │               │
│  └─────────────────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Requirements

### 4.1 Editable Fields by Document Type

#### Paystub

| Field | Type | Required | Validation |
|---|---|---|---|
| Employer Name | text | ✅ | Non-empty, max 200 chars |
| Employer EIN | text | ✅ | Format: `XX-XXXXXXX` |
| Employee Name | text | ✅ | Non-empty |
| Employee SSN | masked text | ✅ | Format: `XXX-XX-XXXX`, last 4 visible |
| Pay Period Start | date | ✅ | Valid date, ≤ Pay Period End |
| Pay Period End | date | ✅ | Valid date, ≥ Pay Period Start |
| Pay Date | date | ✅ | Valid date, ≥ Pay Period End |
| Gross Pay | currency | ✅ | Positive number, 2 decimal places |
| Net Pay | currency | ✅ | Positive, ≤ Gross Pay |
| YTD Gross | currency | ✅ | Positive, ≥ Gross Pay |
| Federal Tax Withheld | currency | ❌ | Non-negative |
| State Tax Withheld | currency | ❌ | Non-negative |
| Pay Frequency | select | ✅ | Weekly / Bi-weekly / Semi-monthly / Monthly |

#### W-2

| Field | Type | Required | Validation |
|---|---|---|---|
| Tax Year | number | ✅ | 4-digit year, 2020–current |
| Employer Name | text | ✅ | Non-empty |
| Employer EIN | text | ✅ | Format: `XX-XXXXXXX` |
| Employee Name | text | ✅ | Non-empty |
| Employee SSN | masked text | ✅ | Format: `XXX-XX-XXXX` |
| Box 1 — Wages | currency | ✅ | Non-negative |
| Box 2 — Federal Tax | currency | ✅ | Non-negative, ≤ Box 1 |
| Box 3 — SS Wages | currency | ❌ | Non-negative |
| Box 4 — SS Tax | currency | ❌ | Non-negative |
| Box 5 — Medicare Wages | currency | ❌ | Non-negative |
| Box 6 — Medicare Tax | currency | ❌ | Non-negative |
| Box 16 — State Wages | currency | ❌ | Non-negative |
| Box 17 — State Tax | currency | ❌ | Non-negative |

#### Bank Statement

| Field | Type | Required | Validation |
|---|---|---|---|
| Account Holder Name | text | ✅ | Non-empty |
| Bank Name | text | ✅ | Non-empty |
| Account Number (last 4) | text | ✅ | 4 digits |
| Statement Period Start | date | ✅ | Valid date |
| Statement Period End | date | ✅ | Valid date, > Start |
| Beginning Balance | currency | ✅ | Number, 2 decimal |
| Ending Balance | currency | ✅ | Number, 2 decimal |
| Total Deposits | currency | ✅ | Non-negative |
| Total Withdrawals | currency | ✅ | Non-negative |
| Average Daily Balance | currency | ❌ | Non-negative |
| Number of NSF/Overdrafts | number | ❌ | Non-negative integer |

### 4.2 Confidence Score Display

- Each field has a confidence score from the extraction model (0.0–1.0).
- Display as color-coded indicator: 🔴 < 0.50 | 🟡 0.50–0.85 | 🟢 > 0.85.
- Fields with 🔴 should be visually prominent (bold border, sorted to top of form).
- Hovering the indicator shows exact score (e.g., "Confidence: 0.34").

### 4.3 Read-Only Fields (System-Managed)

- Document ID
- Upload timestamp
- Pipeline stage history
- Classification result + confidence
- Quality check result
- Task token (hidden from UI, used by backend)
- S3 path to source PDF

---

## 5. Workflow Rules

### 5.1 Document Locking

- **Claim** locks the document to the reviewer. Stored in Aurora: `locked_by`, `locked_at`.
- Lock auto-expires after **30 minutes** of no activity (no field edits, no page interaction).
- Backend heartbeat: frontend pings `/api/hitl/heartbeat/:id` every 60 seconds while the review workspace is open. If 2 consecutive heartbeats are missed, lock is released.
- A supervisor can forcibly reassign a locked document.
- Attempting to claim an already-locked doc returns `409 Conflict` with lock holder info.

### 5.2 Auto-Assignment (P2 — Not Phase 1)

Phase 1 is pull-based: reviewers claim from the queue. Phase 2 will add push-based assignment:
- Round-robin among online reviewers
- Weighted by current workload (fewer active claims = higher priority to receive)
- Fraud queue assigns only to users with `fraud_analyst` role

### 5.3 SLA Timers

| Queue | SLA Target | Warning At | Breach At |
|---|---|---|---|
| HITL (standard) | 4 hours from queue entry | 3 hours | 4 hours |
| Fraud Review | 1 hour from queue entry | 30 minutes | 1 hour |

- SLA countdown is visible on the queue dashboard and review workspace.
- At warning threshold: row turns yellow in queue; supervisor dashboard highlights it.
- At breach: row turns red; supervisor receives real-time alert (WebSocket push).
- SLA clock pauses while a document is in `ESCALATED` status (waiting for supervisor input).

### 5.4 Escalation Paths

```
Document Reviewer ──escalate──→ Team Lead / Supervisor
                                      │
                                      ├── Reassign to another reviewer
                                      ├── Reassign to fraud queue
                                      └── Reject with override

Fraud Analyst ──escalate──→ Team Lead / Supervisor
                                      │
                                      ├── Confirm fraud
                                      ├── Reassign to senior fraud analyst
                                      └── Escalate to compliance (P2)
```

- Escalation adds the document to the supervisor's attention queue with a reason.
- Original reviewer's lock is released on escalation.

### 5.5 Approval Flow (SendTaskSuccess)

When a reviewer clicks **Approve**:

1. Frontend validates all required fields are populated and pass validation rules.
2. `PUT /api/hitl/review/:id` with `action: "approve"` and corrected field data.
3. Backend:
   a. Updates Aurora: `status → COMPLETED`, `reviewed_by`, `reviewed_at`, stores field-level diff.
   b. Calls `SendTaskSuccess` with the task token and payload: `{ correctedData: {...}, reviewerId, reviewedAt }`.
   c. Step Functions resumes the pipeline with corrected data.
   d. Releases the document lock.
4. Frontend shows success toast and auto-advances to next queued document.

### 5.6 Rejection Flow (SendTaskFailure)

When a reviewer clicks **Reject**:

1. Modal requires: rejection reason code (select) + optional free-text explanation.
2. Reason codes: `ILLEGIBLE`, `WRONG_DOC_TYPE`, `INCOMPLETE_DOCUMENT`, `DUPLICATE`, `OTHER`.
3. `PUT /api/hitl/review/:id` with `action: "reject"`, reason code, and explanation.
4. Backend:
   a. Updates Aurora: `status → REJECTED`, stores rejection reason.
   b. Calls `SendTaskFailure` with `{ error: reasonCode, cause: explanation }`.
   c. Step Functions marks the execution as failed.
   d. Releases the document lock.
5. Frontend shows confirmation and auto-advances.

### 5.7 Fraud Confirmation Flow

When a fraud analyst clicks **Confirm Fraud**:

1. Required: fraud type classification (select) + evidence notes (free text).
2. Fraud types: `FORGED_DOCUMENT`, `ALTERED_AMOUNTS`, `IDENTITY_FRAUD`, `SYNTHETIC_IDENTITY`, `OTHER`.
3. Backend:
   a. Updates Aurora: `status → FRAUD_CONFIRMED`, stores fraud classification.
   b. Calls `SendTaskFailure` with fraud-specific error payload.
   c. Creates a fraud case record for compliance tracking (separate table).
   d. Notifies compliance team via SNS topic (P1).

---

## 6. API Endpoints

Base URL: `https://rzeejg3ra4.execute-api.us-east-1.amazonaws.com`

All endpoints require `Authorization: Bearer <jwt>` header. JWT issued by Cognito User Pool (existing IDP auth).

### 6.1 Queue Management

#### `GET /api/hitl/queue`

List pending review items.

**Query Parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `queueType` | string | `hitl` | `hitl` or `fraud` |
| `status` | string | `pending` | `pending`, `in_review`, `escalated`, `all` |
| `docType` | string | — | Filter by document type |
| `sortBy` | string | `sla_deadline` | `sla_deadline`, `confidence`, `created_at` |
| `sortOrder` | string | `asc` | `asc` or `desc` |
| `page` | number | 1 | Page number |
| `pageSize` | number | 25 | Items per page (max 100) |
| `search` | string | — | Search borrower name or doc ID |

**Response 200:**

```json
{
  "items": [
    {
      "id": "doc-4821",
      "documentType": "paystub",
      "borrowerName": "John Smith",
      "applicationId": "APP-1234",
      "confidenceScore": 0.62,
      "status": "pending",
      "lockedBy": null,
      "queuedAt": "2026-03-06T14:22:00Z",
      "slaDeadline": "2026-03-06T18:22:00Z",
      "slaStatus": "ok",
      "lowConfidenceFields": ["payDate", "grossPay"]
    }
  ],
  "pagination": { "page": 1, "pageSize": 25, "totalItems": 47, "totalPages": 2 }
}
```

#### `POST /api/hitl/claim/{documentId}`

Claim/lock a document for review.

**Response 200:** `{ "lockId": "...", "expiresAt": "..." }`
**Response 409:** `{ "error": "already_locked", "lockedBy": "A. Martinez", "lockedAt": "..." }`

#### `POST /api/hitl/release/{documentId}`

Release a claimed document back to queue.

**Response 200:** `{ "status": "released" }`
**Response 403:** Not your lock (unless supervisor role).

#### `POST /api/hitl/heartbeat/{documentId}`

Keep-alive for active review session.

**Response 200:** `{ "lockExtendedTo": "..." }`
**Response 410:** Lock already expired.

### 6.2 Review Actions

#### `GET /api/hitl/document/{documentId}`

Get full document details for review.

**Response 200:**

```json
{
  "id": "doc-4821",
  "documentType": "paystub",
  "pdfUrl": "https://s3-presigned-url...",
  "status": "in_review",
  "lockedBy": "current-user",
  "extractedData": {
    "fields": {
      "employerName": { "value": "Acme Corp", "confidence": 0.94, "boundingBox": {} },
      "payDate": { "value": "2026-01-20", "confidence": 0.34, "boundingBox": {} }
    }
  },
  "fraudSignals": null,
  "notes": [],
  "history": []
}
```

#### `PUT /api/hitl/review/{documentId}`

Submit review decision.

**Request Body:**

```json
{
  "action": "approve | reject | escalate | confirm_fraud | false_positive",
  "correctedFields": {
    "payDate": "2026-01-22",
    "grossPay": 4250.00
  },
  "rejectionReason": "ILLEGIBLE",
  "rejectionNote": "Page 2 is completely unreadable",
  "escalationReason": "Unusual pay structure, need supervisor guidance",
  "fraudType": "FORGED_DOCUMENT",
  "fraudEvidence": "Font mismatch in employer name field"
}
```

**Response 200:** `{ "status": "completed", "nextDocumentId": "doc-4823" }`

#### `POST /api/hitl/document/{documentId}/notes`

Add a note/comment.

**Request:** `{ "text": "Called employer to verify — confirmed pay amount is correct" }`
**Response 201:** `{ "noteId": "...", "createdAt": "...", "author": "..." }`

### 6.3 Supervisor Actions

#### `POST /api/hitl/reassign/{documentId}`

Reassign a document (supervisor only).

**Request:** `{ "assignTo": "userId", "reason": "SLA approaching" }`
**Response 200:** `{ "status": "reassigned" }`

#### `GET /api/hitl/stats`

Queue metrics and performance data.

**Query:** `?period=today|week|month`

**Response 200:**

```json
{
  "queues": {
    "hitl": { "pending": 47, "inReview": 12, "completedToday": 142, "slaBreaches": 3 },
    "fraud": { "pending": 8, "inReview": 2, "completedToday": 11, "slaBreaches": 1 }
  },
  "slaCompliance": { "hitl": 0.962, "fraud": 0.881 },
  "avgReviewTime": { "hitl": 154, "fraud": 492 },
  "reviewers": [
    { "id": "...", "name": "A. Martinez", "completedToday": 31, "avgTime": 132, "accuracy": 0.982, "online": true }
  ],
  "hourlyVolume": [{ "hour": "06:00", "queued": 12, "completed": 8 }]
}
```

### 6.4 Audit & History

#### `GET /api/hitl/history`

Searchable audit trail.

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| `documentId` | string | Filter by specific document |
| `reviewerId` | string | Filter by reviewer |
| `action` | string | `approve`, `reject`, `escalate`, `confirm_fraud` |
| `dateFrom` | ISO date | Start of date range |
| `dateTo` | ISO date | End of date range |
| `page` | number | Pagination |
| `pageSize` | number | Pagination |
| `includeFieldChanges` | boolean | Include field-level diffs (default false) |

**Response 200:**

```json
{
  "items": [
    {
      "id": "review-001",
      "documentId": "doc-4820",
      "reviewerId": "user-123",
      "reviewerName": "A. Martinez",
      "action": "approve",
      "duration": 108,
      "fieldChanges": [
        { "field": "payDate", "original": "2026-01-20", "corrected": "2026-01-22", "confidence": 0.34 }
      ],
      "timestamp": "2026-03-06T14:32:01Z"
    }
  ]
}
```

#### `GET /api/hitl/document/{documentId}/history`

Full history of a single document through the pipeline.

---

## 7. Non-Functional Requirements

### 7.1 Performance

| Metric | Target |
|---|---|
| Queue list load time | < 500ms (p95) |
| Document detail load (incl. PDF URL generation) | < 1s (p95) |
| Review submission (through to SendTaskSuccess) | < 2s (p95) |
| PDF render (first page visible) | < 2s for documents up to 10 pages |
| WebSocket event delivery (SLA alerts) | < 500ms |

### 7.2 Scalability

- Support **50 concurrent reviewers** in Phase 1.
- Queue dashboard must handle up to **10,000 pending items** without degradation.
- Audit log must support queries over **1M+ records** with pagination.

### 7.3 Accessibility

- **WCAG 2.1 AA compliance** — this is a workplace tool used for extended periods.
- Full keyboard navigation for the review workflow (claim → review → approve should be completable without a mouse).
- Screen reader support for form fields, status indicators, and alerts.
- Color is never the only indicator — pair with icons/text (e.g., confidence uses color + emoji indicator).
- Minimum contrast ratio 4.5:1 for text.

### 7.4 Browser Support

- Chrome 100+ (primary — this is the only browser we actively test against)
- Firefox 100+ (supported)
- Safari 16+ (supported)
- Edge 100+ (supported)
- **No IE support.**

### 7.5 Mobile Responsiveness

**Not responsive. Desktop only.** Justification: The core workflow requires simultaneous PDF viewing and form editing in a split pane. This is fundamentally a desktop task requiring a wide viewport. Reviewers use company workstations. Building a responsive version would compromise the desktop experience for a use case that doesn't exist. Minimum viewport: 1280px.

### 7.6 Security

- All API calls authenticated via Cognito JWT.
- Role-based access: `reviewer`, `fraud_analyst`, `supervisor`, `auditor`.
- SSN fields masked in transit and at rest; only last 4 displayed.
- All review actions logged with immutable audit trail.
- PDF pre-signed URLs expire after 15 minutes.
- Rate limiting: 100 requests/minute per user.

---

## 8. Success Metrics

### Primary KPIs

| Metric | Current (Estimated) | Phase 1 Target | Measurement |
|---|---|---|---|
| Avg review time per document | 8–12 min (manual process) | < 3 min | Median of `reviewed_at - claimed_at` |
| Queue depth (end of day) | Unknown | < 20 items | Daily snapshot at 18:00 ET |
| SLA compliance (HITL) | N/A | > 95% | `docs reviewed within SLA / total docs` |
| SLA compliance (Fraud) | N/A | > 95% | Same |
| Reviewer accuracy | Unknown | > 97% | Auditor spot-check pass rate |
| Docs per reviewer per hour | ~6 (estimated) | > 15 | `completed reviews / active hours` |

### Secondary KPIs

| Metric | Target | Purpose |
|---|---|---|
| Escalation rate | < 5% | High rate = model needs retraining or unclear guidelines |
| Rejection rate | < 10% | High rate = upstream quality issues |
| Fraud false positive rate | < 20% | High rate = fraud model needs tuning |
| System uptime | 99.9% | Standard ops |
| Time to first claim (new queue item) | < 10 min | Queue items shouldn't sit idle |

### Dashboarding

- Metrics available in supervisor dashboard (real-time).
- Weekly email summary to operations leadership (P1).
- CloudWatch metrics for all KPIs for alerting integration.

---

## 9. Out of Scope (Phase 1)

| Feature | Rationale | Planned Phase |
|---|---|---|
| **Auto-assignment / push-based routing** | Start with pull-based to understand reviewer behavior first | Phase 2 |
| **Law enforcement escalation workflow** | Requires compliance team process definition | Phase 2 |
| **Bulk actions (approve/reject multiple)** | Risk of rubber-stamping; need audit data first | Phase 2 |
| **ML model feedback loop** | Reviewer corrections should retrain the model, but infrastructure isn't ready | Phase 2 |
| **Mobile/tablet interface** | No use case — see NFR justification | Not planned |
| **Real-time collaboration** (2 reviewers on 1 doc) | Complexity not justified for Phase 1 volume | Phase 3 |
| **Custom review templates** per client | Single tenant for now | Phase 3 |
| **Integration with external fraud databases** | Requires vendor contracts | Phase 2 |
| **Reviewer training/onboarding module** | Use documentation + shadowing initially | Phase 2 |
| **Offline/PWA support** | Desktop-only, always-connected environment | Not planned |
| **Document comparison view** (2 docs side-by-side) | Useful for fraud but complex to build | Phase 2 |
| **SSO / SAML integration** | Cognito user pools sufficient for Phase 1 | Phase 2 |
| **Compliance reporting / SAR filing** | Needs legal review | Phase 2 |

---

## Appendix A: Tech Stack Assumptions

- **Frontend:** React + TypeScript (consistent with existing `idp-viewer.html` evolution path)
- **PDF Viewer:** `react-pdf` or `pdf.js` wrapper
- **State:** React Query for server state, local state for form edits
- **Real-time:** WebSocket via API Gateway for SLA alerts and queue updates
- **Backend:** Existing Lambda + API Gateway infrastructure; new endpoints added to existing stack
- **Database:** Aurora PostgreSQL (existing) — new tables for reviews, audit log, notes
- **Auth:** Cognito User Pool (existing) — add role claims to JWT

## Appendix B: Database Schema Additions

```sql
-- Review actions audit trail
CREATE TABLE hitl_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL REFERENCES documents(id),
    reviewer_id VARCHAR(64) NOT NULL,
    action VARCHAR(20) NOT NULL, -- approve, reject, escalate, confirm_fraud, false_positive
    corrected_fields JSONB,
    original_fields JSONB,
    rejection_reason VARCHAR(50),
    rejection_note TEXT,
    escalation_reason TEXT,
    fraud_type VARCHAR(50),
    fraud_evidence TEXT,
    review_duration_seconds INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Document locks
CREATE TABLE hitl_locks (
    document_id VARCHAR(64) PRIMARY KEY REFERENCES documents(id),
    locked_by VARCHAR(64) NOT NULL,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Notes/comments
CREATE TABLE hitl_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL REFERENCES documents(id),
    author_id VARCHAR(64) NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_reviews_document ON hitl_reviews(document_id);
CREATE INDEX idx_reviews_reviewer ON hitl_reviews(reviewer_id);
CREATE INDEX idx_reviews_created ON hitl_reviews(created_at);
CREATE INDEX idx_locks_expires ON hitl_locks(expires_at);
CREATE INDEX idx_notes_document ON hitl_notes(document_id);
```

## Appendix C: Keyboard Shortcuts

| Shortcut | Action | Context |
|---|---|---|
| `A` | Approve document | Review workspace |
| `R` | Reject document (opens modal) | Review workspace |
| `E` | Escalate (opens modal) | Review workspace |
| `N` | Add note (focuses note input) | Review workspace |
| `Tab` / `Shift+Tab` | Next/prev field | Review workspace |
| `Ctrl+Enter` | Submit current modal | Any modal |
| `Esc` | Close modal / cancel | Any modal |
| `←` / `→` | Previous/next PDF page | Review workspace |
| `+` / `-` | Zoom in/out PDF | Review workspace |
| `Ctrl+S` | Save draft (P2) | Review workspace |

---

*End of PRD. Questions → Jessica Chen, Product.*
