# HITL Manual Data Entry — Implementation Summary

**Date:** 2026-03-06
**Status:** Deployed to dev (hitl.dev.openhomebase.com)

## What Was Built

### Database Changes (Migration 003)
- **`document_type_templates`** — Stores field schemas per document type with versioning
- **`review_drafts`** — Auto-save drafts with JSONB data, per reviewer per document, 72h TTL
- **`hitl_reviews`** extended with `field_provenance` (JSONB) and `entry_mode` (VARCHAR) columns
- **6 templates seeded:** paystub, w2, bank_statement, tax_return, photo_id, 1099

### New API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hitl/templates/:documentType` | Returns field template schema (5-min memory cache) |
| GET | `/api/hitl/templates` | Lists all active templates |
| PUT | `/api/hitl/draft/:documentId` | Save draft (requires active lock) |
| GET | `/api/hitl/draft/:documentId` | Load saved draft |
| DELETE | `/api/hitl/draft/:documentId` | Discard draft |
| POST | `/api/migrate-manual-entry` | Run manual entry DDL + seed templates |

### Modified API Endpoints
- **PUT `/api/hitl/review/:documentId`** — Now accepts `fieldProvenance` and `entryMode`, stores in DB, cleans up drafts on approve
- **POST `/api/hitl/release/:documentId`** — Cleans up drafts on release

### Frontend Features
1. **Manual Entry Mode Toggle** — "📝 Manual Entry" button in review header, toggles between review and manual entry modes
2. **Field Template Rendering** — Loads all fields from template, organized by groups (Employee, Employer, Pay Period, Earnings, Taxes, etc.)
3. **Provenance Tracking** — Per-field source tracking: 🤖 AI (green), 👤 Human (blue), 🔄 Corrected (orange)
4. **Auto-Save Drafts** — 2-second debounce, saves to server + localStorage backup, shows "Saving..." → "Saved ✓" indicator
5. **Draft Recovery** — On page load, checks server draft and localStorage; prompts if local is newer
6. **Required Field Validation** — Red asterisks on required fields, blocks approve if missing, highlights empty required fields
7. **Document Type Selector** — Dropdown to change doc type, warns before resetting fields, reloads template
8. **Keyboard Navigation** — Tab/Shift+Tab between fields, Ctrl+S force save, Ctrl+Enter approve

### Template Schema Structure
```json
{
  "fieldGroups": [
    {
      "name": "Employee",
      "order": 1,
      "fields": [
        { "key": "employeesFullName", "label": "Employee Full Name", "type": "text", "required": true, "order": 1 }
      ]
    }
  ]
}
```

### Field Types Supported
- `text` — Free text input
- `currency` — Monetary values
- `date` — Date picker-ready
- `ssn` — Social Security Number (masked input)
- `ein` — Employer ID Number

## Architecture Decisions
- **Template caching:** 5-minute in-memory TTL in Lambda (cold starts refresh)
- **Draft storage:** Server-side via `review_drafts` table + client-side localStorage fallback
- **Provenance tracking:** Client-side state, submitted with review action
- **No framework:** Vanilla JS per existing patterns
- **Lock verification:** Draft saves require active lock ownership

## Files Changed
- `packages/dss-api/src/lambda-index.js` — API Lambda (all backend changes)
- `packages/dashboard/hitl-review.html` — HITL review UI (all frontend changes)
- `db/migrations/003_manual_entry.sql` — Database migration

## Testing
Smoke tested in dev:
- ✅ Queue loads (776+ items)
- ✅ Document claim works
- ✅ Manual Entry toggle activates mode with visual badge
- ✅ Template loads for Paystub (5 field groups, 16 fields)
- ✅ Templates API returns all 6 seeded templates
- ✅ Required field asterisks display
- ✅ Doc type selector switches templates
- ✅ Keyboard shortcuts displayed in action bar
