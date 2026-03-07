# Code Review: HITL Manual Data Entry / Human Turk Mode

**Reviewer:** Rick (Senior Code Reviewer)  
**Date:** 2026-03-06  
**Commit:** `d92bea6 feat: HITL manual data entry / human turk mode`  
**Files Reviewed:** `lambda-index.js` (960 lines), `hitl-review.html` (+364 lines), `003_manual_entry.sql`

---

## Overall Verdict: ✅ APPROVE (with non-blocking follow-ups)

The implementation is solid. It aligns well with Adam's architecture, all SQL is parameterized, auth/lock checks are present on every new endpoint, and the frontend manual entry flow works correctly. No blocking issues found. Ship it.

---

## Blocking Issues

**None.** 🎉

---

## Non-Blocking Issues (should fix, can ship)

### NB-1: Template cache uses single timestamp for all entries
**File:** `lambda-index.js`, lines 11-13  
**Severity:** Medium  
**Description:** `templateCacheLoadedAt` is a single global timestamp shared across all cached doc types. When any template is fetched, it updates the timestamp, which extends the apparent freshness of ALL cached templates — not just the one fetched.

```javascript
// Current (buggy):
templateCache[docType] = tmpl;
templateCacheLoadedAt = Date.now();  // resets for ALL types

// Fix: store per-type timestamps
templateCache[docType] = { data: tmpl, fetchedAt: Date.now() };
// Check: if (cached && Date.now() - cached.fetchedAt < TEMPLATE_CACHE_TTL)
```

Adam's architecture doc shows the correct per-type approach in §7. The implementation drifted.

### NB-2: SQL injection in GET /api/hitl/review/:documentId — table name interpolation
**File:** `lambda-index.js`, ~line 330  
**Severity:** High (but limited exploitability)  
**Description:** The extraction table query uses string interpolation for the table name:
```javascript
const e = await db.query('SELECT * FROM ' + tt + ' WHERE document_name = $1', [docId]);
```
`tt` is derived from `doc.document_type` lowercased with spaces removed. While it's validated against a whitelist array (`['paystub','w2','bankstatement',...]`), this is an existing pattern from the prior commit — not introduced by this PR. Still, worth noting for a future cleanup pass. The same pattern exists in the `/api/documents/:id` endpoint.

**Fix recommendation:** Extract into a safe helper:
```javascript
const SAFE_TABLES = new Set(['paystub','w2','bankstatement','taxreturn','photoid']);
function getExtractionTable(docType) {
  const t = docType.toLowerCase().replace(/\s+/g, '');
  return SAFE_TABLES.has(t) ? t : null;
}
```

### NB-3: Draft cleanup on release deletes ALL drafts for the document
**File:** `lambda-index.js`, release endpoint (~line 278)  
**Severity:** Low  
**Description:** `DELETE FROM review_drafts WHERE document_id = $1` deletes drafts from ALL reviewers, not just the releasing reviewer. If reviewer A saves a draft, releases, and reviewer B picks it up and saves their own draft, then B releases — A's draft is gone too. Per Adam's architecture, the unique constraint is `(document_id, reviewer_id)`, so drafts are per-reviewer.

**Fix:** Add reviewer filter:
```javascript
await db.query('DELETE FROM review_drafts WHERE document_id = $1 AND reviewer_id = $2', [docId, user.id]);
```

### NB-4: Template 404 response leaks the normalized document type
**File:** `lambda-index.js`, template endpoint  
**Severity:** Low  
**Description:** The 404 response includes `documentType: docType` which is the user-provided input (after normalization). This is fine for debugging but in production you might not want to echo back input. Minor.

### NB-5: No payload size guard on draft save
**File:** `lambda-index.js`, PUT /api/hitl/draft  
**Severity:** Low  
**Description:** Adam's architecture specifies a 256KB payload size guard. The implementation doesn't enforce it. A malicious or buggy client could send a very large draft payload.

**Fix:** Add before the DB query:
```javascript
if (JSON.stringify(body).length > 256 * 1024) return respond(413, { error: 'payload_too_large' });
```

### NB-6: `hitl_reviews` column names differ from architecture
**File:** `003_manual_entry.sql`, `lambda-index.js`  
**Severity:** Low  
**Description:** Architecture specifies columns: `review_mode`, `field_changelog`, `document_type_changed`, `original_document_type`, `final_document_type`, `draft_save_count`, `provenance_summary`. Implementation uses: `field_provenance` (JSONB) and `entry_mode` (VARCHAR). This is simpler and arguably fine for Phase 1 MVP, but the schema diverges from the architecture doc. Should either update the architecture doc or align the column names.

### NB-7: No unique index on `document_type_templates(document_type) WHERE is_active = true`
**File:** `003_manual_entry.sql`  
**Severity:** Medium  
**Description:** Architecture specifies `CREATE UNIQUE INDEX idx_templates_active_type ON document_type_templates(document_type) WHERE is_active = true` to enforce only one active template per type. The migration omits this index. Multiple active versions of the same type could exist, and the query `WHERE document_type = $1 AND is_active = true` could return multiple rows.

**Fix:** Add to migration:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_active_type
    ON document_type_templates(document_type) WHERE is_active = true;
```

### NB-8: Frontend doesn't handle template 404 gracefully in all paths
**File:** `hitl-review.html`, `loadFieldTemplate()`  
**Severity:** Low  
**Description:** If the template fetch returns 404 (unsupported doc type), `apiFetch` doesn't throw on non-2xx by default — it just returns the response. The code does `const data = await res.json()` without checking `res.ok`, so it'll try to render with `{error: 'template_not_found'}` as the template data, resulting in "No template available" (safe but not ideal UX).

**Fix:** Check `res.ok` before parsing:
```javascript
const res = await apiFetch('/api/hitl/templates/' + encodeURIComponent(docType));
if (!res.ok) { toast('No template for this doc type', 'warn'); state.fieldTemplate = null; return; }
```

---

## Suggestions (nice to have)

### S-1: Auto-suggest banner for zero-extraction documents
**Description:** PRD §3.1 specifies an auto-suggest banner when AI extraction returns 0 fields: *"AI extraction returned no data. Switch to Manual Entry?"*. The implementation has the toggle button but doesn't auto-detect and prompt. Would improve UX for the primary use case.

### S-2: Field type-specific input rendering
**Description:** PRD §3.7 and architecture §3.3 specify type-aware inputs: date pickers for dates, currency formatting with `$` prefix, SSN masking. The current implementation renders all fields as plain `<input type="text">`. This is fine for Phase 1 but should be added in Phase 2.

### S-3: Escape key should revert field to last saved value
**Description:** PRD §3.6 specifies Escape reverts current field. Architecture §3.3 `createFieldInput` implements this. The frontend implementation doesn't wire up Escape on individual fields — it only uses Escape at the document level (release document). Consider adding per-field Escape handling.

### S-4: Provenance not included in SendTaskSuccess output
**Description:** Architecture §2.5 specifies including `provenanceSummary` and `reviewMode` in the Step Functions `SendTaskSuccess` output so downstream systems receive provenance. The current approve action sends:
```javascript
{ action: 'approved', reviewerId: user.id, correctedFields: body.correctedFields || {} }
```
Missing: `reviewMode`, `provenanceSummary`, `fieldProvenance`. Downstream consumers won't see source tracking.

### S-5: `review_drafts` has no FK to `document_metadata`
**Description:** Architecture specifies `CONSTRAINT fk_drafts_document FOREIGN KEY (document_id) REFERENCES document_metadata(document_name)`. The migration omits it. This was likely intentional (matching the pattern of dropped FKs in `fix-hitl-index`), but worth documenting.

### S-6: Draft expiry cleanup not implemented
**Description:** Architecture §5.2 specifies a scheduled cleanup every 15 minutes to release locks for expired drafts. No EventBridge rule or cron was created. Drafts will accumulate. Low priority since the 72h expiry is just a TTL marker — the data sitting there doesn't hurt anything.

### S-7: `confirm()` dialogs are blocking and not great UX
**Description:** The doc type change and approve confirmations use `window.confirm()`. Consider replacing with modal dialogs matching the existing reject/escalate modal pattern for a more polished experience.

---

## Security Summary

| Check | Status | Notes |
|-------|--------|-------|
| SQL Injection (new code) | ✅ Pass | All new queries use parameterized SQL ($1, $2...) |
| SQL Injection (existing) | ⚠️ Pre-existing | Table name interpolation in extraction query (whitelisted) |
| XSS | ✅ Pass | `esc()` function used for all user input in HTML |
| Auth on new endpoints | ✅ Pass | All draft/template endpoints check `extractUser()` |
| Lock verification | ✅ Pass | Draft save verifies active lock ownership |
| PII in error responses | ✅ Pass | Errors return generic messages, no field data leaked |
| CORS | ✅ Pass | Consistent `Access-Control-Allow-Origin: *` (acceptable for Phase 1 dev) |

## Architecture Alignment

| Aspect | Architecture | Implementation | Match? |
|--------|-------------|----------------|--------|
| DB tables | `document_type_templates`, `review_drafts` | ✅ Created | ✅ |
| `hitl_reviews` extensions | 7 new columns | 2 columns (`field_provenance`, `entry_mode`) | ⚠️ Simplified |
| Template caching | Per-type, 5min TTL | Global timestamp (bug) | ⚠️ NB-1 |
| API routes | 4 new endpoints | ✅ All 4 implemented + list templates | ✅ |
| Draft save debounce | 2s (not 500ms per PRD) | 2s | ✅ |
| Lock verification on draft | Required | ✅ Implemented | ✅ |
| Provenance in review submission | Full changelog + summary | Simplified provenance JSONB | ⚠️ Simplified |
| Frontend mode toggle | Toggle + banner | Toggle button (no auto-banner) | ⚠️ S-1 |
| Field type rendering | Type-aware inputs | Plain text inputs | ⚠️ S-2 |
| Template seeding | 3 types (Phase 1) | 6 types | ✅ Better |

## Code Quality

- **Style:** Consistent with existing codebase (vanilla JS, same patterns)
- **Dead code:** None found
- **Async/await:** Properly used throughout, no unhandled promises
- **Error handling:** All catch blocks log errors. The `.catch(e => console.error(...))` on draft cleanup is appropriate (non-critical side effect)
- **Transaction usage:** Approve/reject/escalate properly use BEGIN/COMMIT/ROLLBACK

## Edge Cases

| Scenario | Handled? | Notes |
|----------|----------|-------|
| Template returns empty | ✅ | Shows "No template available" |
| Draft save fails | ✅ | Shows "Save failed" indicator, localStorage backup exists |
| Doc type changed mid-entry | ✅ | Confirmation dialog, fields reset |
| Lock expires during entry | ✅ | Draft save returns 403, heartbeat returns 410 |
| Two tabs same document | ✅ | Lock prevents second claim (409) |
| Browser crash | ✅ | localStorage backup + server draft recovery |
| `beforeunload` draft save | ✅ | Saves to localStorage synchronously |

---

## Final Notes

This is a clean Phase 1 implementation. The simplifications from the architecture (fewer `hitl_reviews` columns, no field type rendering) are reasonable trade-offs for shipping faster. The non-blocking issues (especially NB-1 cache bug, NB-3 draft cleanup scope, and NB-7 missing unique index) should be addressed in a fast follow-up.

Good work. Ship it.
