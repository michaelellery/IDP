-- HITL Case Management Tables - Migration 002 - 2026-03-06

CREATE TABLE IF NOT EXISTS hitl_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL,
    matter_id VARCHAR(64),
    document_type VARCHAR(50) NOT NULL,
    queue_type VARCHAR(20) NOT NULL DEFAULT 'hitl',
    task_token TEXT NOT NULL,
    execution_arn TEXT,
    confidence NUMERIC(5,4),
    extraction_data JSONB,
    fraud_signals JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 0,
    sla_deadline TIMESTAMPTZ NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sqs_message_id VARCHAR(128),
    CONSTRAINT fk_hitl_queue_document FOREIGN KEY (document_id) REFERENCES document_metadata(document_name)
);
CREATE INDEX IF NOT EXISTS idx_hitl_queue_status_sla ON hitl_queue(queue_type, status, sla_deadline);
CREATE INDEX IF NOT EXISTS idx_hitl_queue_document ON hitl_queue(document_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hitl_queue_sqs_dedup ON hitl_queue(sqs_message_id) WHERE sqs_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hitl_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL UNIQUE,
    locked_by VARCHAR(64) NOT NULL,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_hitl_locks_document FOREIGN KEY (document_id) REFERENCES document_metadata(document_name)
);
CREATE INDEX IF NOT EXISTS idx_hitl_locks_expires ON hitl_locks(expires_at);

CREATE TABLE IF NOT EXISTS hitl_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL,
    queue_id UUID,
    reviewer_id VARCHAR(64) NOT NULL,
    reviewer_name VARCHAR(128),
    action VARCHAR(20) NOT NULL,
    corrected_fields JSONB,
    original_fields JSONB,
    rejection_reason VARCHAR(50),
    rejection_note TEXT,
    escalation_reason TEXT,
    fraud_type VARCHAR(50),
    fraud_evidence TEXT,
    review_duration_seconds INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_hitl_reviews_document FOREIGN KEY (document_id) REFERENCES document_metadata(document_name)
);
CREATE INDEX IF NOT EXISTS idx_hitl_reviews_document ON hitl_reviews(document_id);
CREATE INDEX IF NOT EXISTS idx_hitl_reviews_reviewer ON hitl_reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_hitl_reviews_created ON hitl_reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hitl_reviews_action ON hitl_reviews(action, created_at DESC);

CREATE TABLE IF NOT EXISTS hitl_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL,
    author_id VARCHAR(64) NOT NULL,
    author_name VARCHAR(128),
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_hitl_notes_document FOREIGN KEY (document_id) REFERENCES document_metadata(document_name)
);
CREATE INDEX IF NOT EXISTS idx_hitl_notes_document ON hitl_notes(document_id, created_at);

ALTER TABLE document_metadata ADD COLUMN IF NOT EXISTS hitl_queued_at TIMESTAMPTZ;
ALTER TABLE document_metadata ADD COLUMN IF NOT EXISTS hitl_completed_at TIMESTAMPTZ;
ALTER TABLE document_metadata ADD COLUMN IF NOT EXISTS hitl_reviewer_id VARCHAR(64);
