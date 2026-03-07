const { Client } = require('pg');
const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = require('@aws-sdk/client-sfn');
const fs = require('fs');
const s3 = new S3Client({});
const sm = new SecretsManagerClient({});
const sfn = new SFNClient({ region: 'us-east-1' });

// Template cache
const templateCache = {};
let templateCacheLoadedAt = 0;
const TEMPLATE_CACHE_TTL = 300000;

let dbConfigPromise = null;
async function fetchDbConfig() {
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: 'idp-dev/db-credentials' }));
  const s = JSON.parse(resp.SecretString);
  return { host: s.host, port: +s.port || 5432, database: s.dbname || 'idp', user: s.username, password: s.password, ssl: { rejectUnauthorized: false } };
}
function ensureDbConfig() {
  if (!dbConfigPromise) dbConfigPromise = fetchDbConfig();
  return dbConfigPromise;
}

function getDb(config) { return new Client(config); }
function respond(code, body) {
  return { statusCode: code, headers: { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*' }, body: JSON.stringify(body) };
}
function safeDate(val) {
  if (!val) return null;
  const s = String(val);
  if (s.includes('XX') || s.includes('xx') || s.length < 6) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}
function safeNum(val) {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

// Phase 1 auth: API key → user mapping
const HITL_USERS = {
  'idp-hitl-reviewer-abc123': { id: 'user-1', name: 'A. Martinez', role: 'reviewer' },
  'idp-hitl-reviewer-def456': { id: 'user-2', name: 'B. Thompson', role: 'reviewer' },
  'idp-hitl-fraud-ghi789':   { id: 'user-3', name: 'F. Lee', role: 'fraud_analyst' },
  'idp-hitl-admin-jkl012':   { id: 'user-4', name: 'Admin', role: 'supervisor' },
};

function extractUser(event) {
  // Phase 1: Accept API key OR reviewer name from header/body
  const auth = (event.headers?.authorization || event.headers?.Authorization || '').replace('Bearer ', '');
  if (HITL_USERS[auth]) return HITL_USERS[auth];
  // Fallback: accept X-Reviewer-Id header or reviewerId from body
  const reviewerId = event.headers?.['x-reviewer-id'] || event.headers?.['X-Reviewer-Id'];
  if (reviewerId) return { id: reviewerId, name: reviewerId, role: 'reviewer' };
  try {
    const body = JSON.parse(event.body || '{}');
    if (body.reviewerId || body.reviewerName) return { id: body.reviewerId || body.reviewerName, name: body.reviewerName || body.reviewerId, role: 'reviewer' };
  } catch(e) {}
  return null;
}

exports.handler = async (event) => {
  const path = event.rawPath || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  const qs = event.queryStringParameters || {};
  const host = (event.headers?.host || '').toLowerCase();

  // Host-based root routing for custom domains
  if ((path === '/' || path === '') && method === 'GET') {
    if (host.startsWith('hitl.')) {
      const hitlHtml = require('fs').readFileSync(require('path').join(__dirname, 'hitl-review.html'), 'utf8');
      return { statusCode: 200, headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' }, body: hitlHtml };
    }
    if (host.startsWith('idp.')) {
      const viewerHtml = require('fs').readFileSync(require('path').join(__dirname, 'idp-viewer.html'), 'utf8');
      return { statusCode: 200, headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' }, body: viewerHtml };
    }
  }

  
  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key,X-Reviewer-Id', 'Access-Control-Max-Age': '86400' }, body: '' };
  }

  // Serve HITL frontend
  if (path === '/hitl' && method === 'GET') {
    const hitlHtml = require('fs').readFileSync(require('path').join(__dirname, 'hitl-review.html'), 'utf8');
    return { statusCode: 200, headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' }, body: hitlHtml };
  }
  const dbConfig = await ensureDbConfig();
  const db = getDb(dbConfig);
  try {
    await db.connect();

    // ===== HITL ENDPOINTS =====

    // Migrate endpoint - runs DDL
    if (path === '/api/migrate-manual-entry' && method === 'POST') {
      try {
        const meSql = `
CREATE TABLE IF NOT EXISTS document_type_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_type VARCHAR(50) NOT NULL,
    version VARCHAR(10) NOT NULL DEFAULT '1.0',
    field_schema JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_template_type_version UNIQUE (document_type, version)
);
CREATE TABLE IF NOT EXISTS review_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL,
    reviewer_id VARCHAR(64) NOT NULL,
    draft_data JSONB NOT NULL DEFAULT '{}',
    mode VARCHAR(20) NOT NULL DEFAULT 'review',
    document_type VARCHAR(50),
    save_count INTEGER NOT NULL DEFAULT 0,
    last_saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
    CONSTRAINT uq_draft_document_reviewer UNIQUE (document_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_drafts_document ON review_drafts(document_id);
CREATE INDEX IF NOT EXISTS idx_drafts_expires ON review_drafts(expires_at);
ALTER TABLE hitl_reviews ADD COLUMN IF NOT EXISTS field_provenance JSONB;
ALTER TABLE hitl_reviews ADD COLUMN IF NOT EXISTS entry_mode VARCHAR(20);
`;
        await db.query(meSql);
        const templates = [
          ['paystub', '1.0', {fieldGroups:[{name:'Employee',order:1,fields:[{key:'employeesFullName',label:'Employee Full Name',type:'text',required:true,order:1},{key:'ssn',label:'SSN',type:'ssn',required:false,order:2},{key:'address',label:'Address',type:'text',required:false,order:3}]},{name:'Employer',order:2,fields:[{key:'employersName',label:'Employer Name',type:'text',required:false,order:1},{key:'employersAddress',label:'Employer Address',type:'text',required:false,order:2},{key:'employersPhoneNumber',label:'Employer Phone',type:'text',required:false,order:3},{key:'employersEin',label:'Employer EIN',type:'ein',required:false,order:4}]},{name:'Pay Period',order:3,fields:[{key:'payPeriodStartDate',label:'Pay Period Start',type:'date',required:false,order:1},{key:'payPeriodEndDate',label:'Pay Period End',type:'date',required:false,order:2},{key:'payDate',label:'Pay Date',type:'date',required:false,order:3}]},{name:'Earnings',order:4,fields:[{key:'grossPay',label:'Gross Pay',type:'currency',required:true,order:1},{key:'netPay',label:'Net Pay',type:'currency',required:true,order:2},{key:'ytdGrossEarnings',label:'YTD Gross Earnings',type:'currency',required:false,order:3},{key:'ytdNetEarnings',label:'YTD Net Earnings',type:'currency',required:false,order:4}]},{name:'Taxes',order:5,fields:[{key:'federalTaxWithheld',label:'Federal Tax Withheld',type:'currency',required:false,order:1},{key:'stateTaxWithheld',label:'State Tax Withheld',type:'currency',required:false,order:2},{key:'socialSecurityWithheld',label:'Social Security Withheld',type:'currency',required:false,order:3},{key:'medicareWithheld',label:'Medicare Withheld',type:'currency',required:false,order:4}]}]}],
          ['w2', '1.0', {fieldGroups:[{name:'Employee',order:1,fields:[{key:'employeesFullName',label:'Employee Full Name',type:'text',required:true,order:1},{key:'ssn',label:'SSN',type:'ssn',required:true,order:2},{key:'address',label:'Address',type:'text',required:false,order:3}]},{name:'Employer',order:2,fields:[{key:'employersName',label:'Employer Name',type:'text',required:true,order:1},{key:'ein',label:'EIN',type:'ein',required:true,order:2}]},{name:'Wages',order:3,fields:[{key:'wagesTipsComp',label:'Wages, Tips, Compensation',type:'currency',required:true,order:1},{key:'federalTaxWithheld',label:'Federal Tax Withheld',type:'currency',required:true,order:2},{key:'socialSecurityWages',label:'Social Security Wages',type:'currency',required:false,order:3},{key:'socialSecurityTax',label:'Social Security Tax',type:'currency',required:false,order:4},{key:'medicareWages',label:'Medicare Wages',type:'currency',required:false,order:5},{key:'medicareTax',label:'Medicare Tax',type:'currency',required:false,order:6}]},{name:'State',order:4,fields:[{key:'stateWages',label:'State Wages',type:'currency',required:false,order:1},{key:'stateTax',label:'State Tax',type:'currency',required:false,order:2},{key:'stateId',label:'State ID',type:'text',required:false,order:3}]}]}],
          ['bank_statement', '1.0', {fieldGroups:[{name:'Account',order:1,fields:[{key:'accountHolderName',label:'Account Holder Name',type:'text',required:true,order:1},{key:'accountNumber',label:'Account Number',type:'text',required:false,order:2},{key:'bankName',label:'Bank Name',type:'text',required:false,order:3}]},{name:'Period',order:2,fields:[{key:'statementStartDate',label:'Statement Start Date',type:'date',required:true,order:1},{key:'statementEndDate',label:'Statement End Date',type:'date',required:true,order:2}]},{name:'Balances',order:3,fields:[{key:'beginningBalance',label:'Beginning Balance',type:'currency',required:true,order:1},{key:'endingBalance',label:'Ending Balance',type:'currency',required:true,order:2},{key:'totalDeposits',label:'Total Deposits',type:'currency',required:false,order:3},{key:'totalWithdrawals',label:'Total Withdrawals',type:'currency',required:false,order:4}]}]}],
          ['tax_return', '1.0', {fieldGroups:[{name:'Taxpayer',order:1,fields:[{key:'taxpayerName',label:'Taxpayer Name',type:'text',required:true,order:1},{key:'ssn',label:'SSN',type:'ssn',required:true,order:2},{key:'filingStatus',label:'Filing Status',type:'text',required:false,order:3}]},{name:'Income',order:2,fields:[{key:'totalIncome',label:'Total Income',type:'currency',required:true,order:1},{key:'adjustedGrossIncome',label:'Adjusted Gross Income',type:'currency',required:true,order:2},{key:'taxableIncome',label:'Taxable Income',type:'currency',required:false,order:3}]},{name:'Tax',order:3,fields:[{key:'totalTax',label:'Total Tax',type:'currency',required:false,order:1},{key:'totalPayments',label:'Total Payments',type:'currency',required:false,order:2},{key:'refundAmount',label:'Refund Amount',type:'currency',required:false,order:3},{key:'amountOwed',label:'Amount Owed',type:'currency',required:false,order:4}]}]}],
          ['photo_id', '1.0', {fieldGroups:[{name:'Identity',order:1,fields:[{key:'fullName',label:'Full Name',type:'text',required:true,order:1},{key:'dateOfBirth',label:'Date of Birth',type:'date',required:true,order:2},{key:'idNumber',label:'ID Number',type:'text',required:true,order:3},{key:'expirationDate',label:'Expiration Date',type:'date',required:false,order:4}]},{name:'Address',order:2,fields:[{key:'address',label:'Address',type:'text',required:false,order:1},{key:'state',label:'State',type:'text',required:false,order:2},{key:'zipCode',label:'Zip Code',type:'text',required:false,order:3}]}]}],
          ['1099', '1.0', {fieldGroups:[{name:'Recipient',order:1,fields:[{key:'recipientName',label:'Recipient Name',type:'text',required:true,order:1},{key:'recipientTin',label:'Recipient TIN',type:'ssn',required:true,order:2}]},{name:'Payer',order:2,fields:[{key:'payerName',label:'Payer Name',type:'text',required:true,order:1},{key:'payerTin',label:'Payer TIN',type:'ein',required:false,order:2}]},{name:'Income',order:3,fields:[{key:'nonemployeeCompensation',label:'Nonemployee Compensation',type:'currency',required:true,order:1},{key:'federalTaxWithheld',label:'Federal Tax Withheld',type:'currency',required:false,order:2},{key:'stateTaxWithheld',label:'State Tax Withheld',type:'currency',required:false,order:3}]}]}]
        ];
        for (const [dt, ver, schema] of templates) {
          await db.query(
            'INSERT INTO document_type_templates (document_type, version, field_schema, is_active) VALUES ($1, $2, $3, true) ON CONFLICT (document_type, version) DO UPDATE SET field_schema = $3, updated_at = NOW()',
            [dt, ver, JSON.stringify(schema)]
          );
        }
        return respond(200, { success: true, message: 'Manual entry migration completed', templates: templates.length });
      } catch(e) {
        console.error('Manual entry migration failed:', e);
        return respond(500, { error: e.message });
      }
    }

    if (path === '/api/migrate' && method === 'POST') {
      const migrationSql = `
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
`;
      await db.query(migrationSql);
      return respond(200, { success: true, message: 'HITL migration completed' });
    }

    // GET /api/hitl/queue — list pending reviews
    
  

    // POST /api/reset-hitl — clear broken HITL data
    if (path === '/api/reset-hitl' && method === 'POST') {
      try {
        await db.query('BEGIN');
        await db.query('ALTER TABLE hitl_queue ADD COLUMN IF NOT EXISTS s3_key TEXT');
        const q1 = await db.query('DELETE FROM hitl_queue');
        const q2 = await db.query('DELETE FROM hitl_locks');
        const q3 = await db.query('DELETE FROM hitl_notes');
        const q4 = await db.query("UPDATE document_metadata SET status = 'REJECTED', updated_at = NOW() WHERE status = 'HITL_REVIEW'");
        const q5 = await db.query("UPDATE document_metadata SET status = 'REJECTED', updated_at = NOW() WHERE status = 'FRAUD_REVIEW'");
        await db.query('COMMIT');
        return respond(200, {
          success: true,
          deleted: { hitl_queue: q1.rowCount, hitl_locks: q2.rowCount, hitl_notes: q3.rowCount },
          updated: { hitl_review_to_rejected: q4.rowCount, fraud_review_to_rejected: q5.rowCount }
        });
      } catch(e) {
        await db.query('ROLLBACK');
        return respond(500, { error: e.message });
      }
    }


    // POST /api/fix-schema — fix NOT NULL constraints
    if (path === '/api/fix-schema' && method === 'POST') {
      try {
        await db.query('ALTER TABLE document_metadata ALTER COLUMN matter_id DROP NOT NULL');
        await db.query('ALTER TABLE document_metadata ALTER COLUMN source_channel DROP NOT NULL');
        return respond(200, { success: true, message: 'Schema fixed - matter_id and source_channel now nullable' });
      } catch(e) {
        return respond(500, { error: e.message });
      }
    }

  if (path === '/api/hitl-diag' && method === 'GET') {
    try {
      const cols = await db.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'hitl_queue' ORDER BY ordinal_position");
      const idx = await db.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'hitl_queue'");
      const cnt = await db.query('SELECT count(*) as cnt FROM hitl_queue');
      return { statusCode: 200, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ columns: cols.rows, indexes: idx.rows, count: cnt.rows[0].cnt }) };
    } catch(e) { return { statusCode: 500, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ error: e.message }) }; }
  }

  if (path === '/api/fix-hitl-index' && method === 'POST') {
    try {
      await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_hitl_queue_sqs_dedup ON hitl_queue(sqs_message_id) WHERE sqs_message_id IS NOT NULL');
      await db.query('DROP INDEX IF EXISTS idx_hitl_queue_document'); await db.query('CREATE UNIQUE INDEX idx_hitl_queue_document ON hitl_queue(document_id)'); await db.query('ALTER TABLE hitl_queue DROP CONSTRAINT IF EXISTS fk_hitl_queue_document');
      await db.query('ALTER TABLE hitl_locks DROP CONSTRAINT IF EXISTS fk_hitl_locks_document');
      await db.query('ALTER TABLE hitl_locks DROP CONSTRAINT IF EXISTS fk_hitl_locks_queue');
      await db.query('ALTER TABLE hitl_reviews DROP CONSTRAINT IF EXISTS fk_hitl_reviews_document');
      await db.query('ALTER TABLE hitl_reviews DROP CONSTRAINT IF EXISTS fk_hitl_reviews_queue');
      await db.query('ALTER TABLE hitl_notes DROP CONSTRAINT IF EXISTS fk_hitl_notes_document');
      await db.query('ALTER TABLE hitl_notes DROP CONSTRAINT IF EXISTS fk_hitl_notes_queue');
      return { statusCode: 200, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ ok: true, message: 'Indexes created' }) };
    } catch(e) { console.error('fix-hitl-index error:', e); return { statusCode: 500, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ error: e.message }) }; }
  }

  if (path === '/api/hitl/queue' && method === 'GET') {
      const user = extractUser(event);
      const queueType = qs.queueType || 'hitl';
      const status = qs.status || 'pending';
      const sortBy = qs.sortBy || 'sla_deadline';
      const sortOrder = (qs.sortOrder || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      const page = Math.max(parseInt(qs.page || '1', 10), 1);
      const pageSize = Math.min(Math.max(parseInt(qs.pageSize || '25', 10), 1), 100);
      const offset = (page - 1) * pageSize;

      const validSorts = { sla_deadline: 'q.sla_deadline', confidence: 'q.confidence', created_at: 'q.queued_at' };
      const orderCol = validSorts[sortBy] || 'q.sla_deadline';

      let statusFilter = "q.status = 'pending'";
      if (status === 'in_review') statusFilter = "q.status = 'in_review'";
      else if (status === 'escalated') statusFilter = "q.status = 'escalated'";
      else if (status === 'all') statusFilter = '1=1';

      const params = [queueType, pageSize, offset];
      let searchFilter = '';
      if (qs.search) {
        params.push('%' + qs.search + '%');
        searchFilter = ` AND (q.document_id ILIKE $${params.length} OR q.matter_id ILIKE $${params.length})`;
      }
      let docTypeFilter = '';
      if (qs.docType) {
        params.push(qs.docType);
        docTypeFilter = ` AND q.document_type = $${params.length}`;
      }

      const countRes = await db.query(
        `SELECT COUNT(*) FROM hitl_queue q WHERE q.queue_type = $1 AND ${statusFilter}${searchFilter}${docTypeFilter}`,
        params.slice(0, 1).concat(qs.search ? ['%' + qs.search + '%'] : []).concat(qs.docType ? [qs.docType] : [])
      );
      const totalItems = parseInt(countRes.rows[0].count, 10);

      const rows = await db.query(`
        SELECT q.*, l.locked_by, l.locked_at,
          CASE
            WHEN q.sla_deadline < NOW() THEN 'breached'
            WHEN q.queue_type = 'fraud' AND q.sla_deadline < NOW() + INTERVAL '30 minutes' THEN 'warning'
            WHEN q.queue_type = 'hitl' AND q.sla_deadline < NOW() + INTERVAL '1 hour' THEN 'warning'
            ELSE 'ok'
          END AS sla_status
        FROM hitl_queue q
        LEFT JOIN hitl_locks l ON q.document_id = l.document_id AND l.expires_at > NOW()
        WHERE q.queue_type = $1 AND ${statusFilter}${searchFilter}${docTypeFilter}
        ORDER BY ${orderCol} ${sortOrder}
        LIMIT $2 OFFSET $3
      `, params);

      return respond(200, {
        items: rows.rows.map(r => ({
          id: r.id,
          documentId: r.document_id,
          documentType: r.document_type,
          matterId: r.matter_id,
          confidenceScore: r.confidence ? parseFloat(r.confidence) : null,
          status: r.status,
          queueType: r.queue_type,
          lockedBy: r.locked_by || null,
          queuedAt: r.queued_at,
          slaDeadline: r.sla_deadline,
          slaStatus: r.sla_status,
          priority: r.priority,
        })),
        pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) }
      });
    }

    // GET /api/hitl/queue/stats
    if (path === '/api/hitl/queue/stats' || path === '/api/hitl/stats') {
      const r = await db.query(`
        SELECT queue_type,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending,
          COUNT(*) FILTER (WHERE status = 'in_review') AS in_review,
          COUNT(*) FILTER (WHERE sla_deadline < NOW() AND status != 'completed') AS sla_breaches
        FROM hitl_queue GROUP BY queue_type
      `);
      const completedToday = await db.query(`
        SELECT
          COUNT(*) AS total_done,
          AVG(review_duration_seconds) AS avg_dur
        FROM hitl_reviews WHERE created_at >= CURRENT_DATE
      `);
      const ct = completedToday.rows[0] || {};
      const queues = { hitl: { pending: 0, inReview: 0, completedToday: 0, slaBreaches: 0 }, fraud: { pending: 0, inReview: 0, completedToday: 0, slaBreaches: 0 } };
      for (const row of r.rows) {
        const key = row.queue_type === 'fraud' ? 'fraud' : 'hitl';
        queues[key].pending = parseInt(row.pending);
        queues[key].inReview = parseInt(row.in_review);
        queues[key].slaBreaches = parseInt(row.sla_breaches);
      }
      queues.hitl.completedToday = parseInt(ct.total_done || 0);
      return respond(200, {
        queues,
        avgReviewTimeSeconds: { hitl: parseFloat(ct.hitl_avg || 0), fraud: parseFloat(ct.fraud_avg || 0) }
      });
    }

    // POST /api/hitl/claim/:documentId
    if (path.match(/^\/api\/hitl\/claim\//) && method === 'POST') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      const body = JSON.parse(event.body || '{}');
      const reviewer = user.id;

      // Clean expired locks
      await db.query('DELETE FROM hitl_locks WHERE document_id = $1 AND expires_at < NOW()', [docId]);

      // Attempt lock
      const lockRes = await db.query(
        `INSERT INTO hitl_locks (document_id, locked_by, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes') ON CONFLICT (document_id) DO NOTHING RETURNING *`,
        [docId, reviewer]
      );
      if (!lockRes.rows.length) {
        const existing = await db.query('SELECT locked_by, locked_at FROM hitl_locks WHERE document_id = $1', [docId]);
        return respond(409, { error: 'already_locked', lockedBy: existing.rows[0]?.locked_by, lockedAt: existing.rows[0]?.locked_at });
      }

      await db.query("UPDATE hitl_queue SET status = 'in_review' WHERE document_id = $1 AND status = 'pending'", [docId]);
      return respond(200, { status: 'in_review', lockId: lockRes.rows[0].id, expiresAt: lockRes.rows[0].expires_at, document: { documentId: docId } });
    }

    // POST /api/hitl/release/:documentId
    if (path.match(/^\/api\/hitl\/release\//) && method === 'POST') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });

      const del = await db.query('DELETE FROM hitl_locks WHERE document_id = $1 AND (locked_by = $2 OR $3 = true) RETURNING *',
        [docId, user.id, user.role === 'supervisor']);
      if (!del.rows.length) return respond(404, { error: 'no_lock_found' });

      await db.query("UPDATE hitl_queue SET status = 'pending' WHERE document_id = $1 AND status = 'in_review'", [docId]);
      // Clean up draft on release
      await db.query('DELETE FROM review_drafts WHERE document_id = $1', [docId]).catch(e => console.error('Draft cleanup on release:', e));
      return respond(200, { status: 'pending' });
    }

    // POST /api/hitl/heartbeat/:documentId
    if (path.match(/^\/api\/hitl\/heartbeat\//) && method === 'POST') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });

      const res = await db.query(
        `UPDATE hitl_locks SET last_heartbeat = NOW(), expires_at = NOW() + INTERVAL '30 minutes' WHERE document_id = $1 AND locked_by = $2 AND expires_at > NOW() RETURNING expires_at`,
        [docId, user.id]
      );
      if (!res.rows.length) return respond(410, { error: 'lock_expired' });
      return respond(200, { lockExtendedTo: res.rows[0].expires_at });
    }

    // GET /api/hitl/review/:documentId — full review context
    if (path.match(/^\/api\/hitl\/review\/[^/]+$/) && method === 'GET') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));

      let meta = await db.query('SELECT * FROM document_metadata WHERE document_name = $1', [docId]);
      // If not found by document_name, try via hitl_queue to find the linked document
      if (!meta.rows.length) {
        const qItem = await db.query('SELECT extraction_data, s3_key FROM hitl_queue WHERE document_id = $1', [docId]);
        if (qItem.rows.length && qItem.rows[0].extraction_data) {
          const ed = typeof qItem.rows[0].extraction_data === 'string' ? JSON.parse(qItem.rows[0].extraction_data) : qItem.rows[0].extraction_data;
          // Build a synthetic doc from queue data
          meta = { rows: [{ document_name: docId, document_type: ed.documentType || 'Unknown', status: 'HITL_REVIEW', confidence: ed.extractionResult?.confidence || ed.confidence || null, s3_key: qItem.rows[0].s3_key || ed.s3Key || ed.s3_key || null, extracted_data: ed }] };
        }
      }
      if (!meta.rows.length) return respond(404, { error: 'not_found' });
      const doc = meta.rows[0];

      const queueItem = await db.query('SELECT * FROM hitl_queue WHERE document_id = $1', [docId]);
      // Use s3_key from queue item if doc doesn't have one
      if (!doc.s3_key && queueItem.rows.length && queueItem.rows[0].s3_key) { doc.s3_key = queueItem.rows[0].s3_key; }
      const lock = await db.query('SELECT * FROM hitl_locks WHERE document_id = $1 AND expires_at > NOW()', [docId]);
      const notes = await db.query('SELECT * FROM hitl_notes WHERE document_id = $1 ORDER BY created_at', [docId]);
      const history = await db.query('SELECT * FROM hitl_reviews WHERE document_id = $1 ORDER BY created_at DESC', [docId]);

      // Get extraction data
      let extraction = null;
      const tt = (doc.document_type || '').toLowerCase().replace(/\s+/g, '');
      if (['paystub','w2','bankstatement','taxreturn','photoid'].includes(tt)) {
        try { const e = await db.query('SELECT * FROM ' + tt + ' WHERE document_name = $1', [docId]); if (e.rows.length) extraction = e.rows[0]; } catch(e) {}
      }

      // Generate presigned URL for PDF
      let pdfUrl = null;
      if (doc.s3_key) {
        const bucket = doc.s3_key.startsWith('intake/') ? 'idp-dev-intake-430695043165' : 'idp-dev-documents-430695043165';
        pdfUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: doc.s3_key }), { expiresIn: 900 });
      }

      const qi = queueItem.rows[0] || {};
      return respond(200, {
        id: docId,
        documentType: doc.document_type,
        matterId: doc.matter_id,
        pdfUrl,
        status: doc.status,
        lockedBy: lock.rows[0]?.locked_by || null,
        queuedAt: qi.queued_at,
        slaDeadline: qi.sla_deadline,
        confidence: qi.confidence ? parseFloat(qi.confidence) : doc.confidence,
        extractedData: qi.extraction_data || extraction || null,
        fraudSignals: qi.fraud_signals || null,
        notes: notes.rows.map(n => ({ id: n.id, authorId: n.author_id, authorName: n.author_name, text: n.text, createdAt: n.created_at })),
        history: history.rows.map(h => ({ id: h.id, action: h.action, reviewerName: h.reviewer_name, createdAt: h.created_at, correctedFields: h.corrected_fields, rejectionReason: h.rejection_reason })),
      });
    }


    // PUT /api/hitl/review/:documentId — unified review action (approve/reject/escalate)
    if (path.match(/^\/api\/hitl\/review\/[^/]+$/) && method === 'PUT') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      const body = JSON.parse(event.body || '{}');
      const action = body.action;
      if (!action) return respond(400, { error: 'action required' });

      const lock = await db.query('SELECT * FROM hitl_locks WHERE document_id = $1 AND locked_by = $2 AND expires_at > NOW()', [docId, user.id]);
      if (!lock.rows.length) return respond(403, { error: 'no_active_lock' });

      const qi = await db.query('SELECT * FROM hitl_queue WHERE document_id = $1', [docId]);
      if (!qi.rows.length) return respond(404, { error: 'not_in_queue' });
      const queueItem = qi.rows[0];
      const durationSeconds = body.reviewDurationSeconds || (lock.rows[0].locked_at ? Math.round((Date.now() - new Date(lock.rows[0].locked_at).getTime()) / 1000) : null);

      try {
        await db.query('BEGIN');
        if (action === 'approve') {
          await db.query(
            `INSERT INTO hitl_reviews (document_id, queue_id, reviewer_id, reviewer_name, action, corrected_fields, review_duration_seconds, field_provenance, entry_mode) VALUES ($1, $2, $3, $4, 'approve', $5, $6, $7, $8)`,
            [docId, queueItem.id, user.id, user.name, JSON.stringify(body.correctedFields || {}), durationSeconds, body.fieldProvenance ? JSON.stringify(body.fieldProvenance) : null, body.entryMode || 'review']
          );
          // Delete draft on successful review
          await db.query('DELETE FROM review_drafts WHERE document_id = $1', [docId]).catch(e => console.error('Draft cleanup error:', e));
          await db.query(`UPDATE document_metadata SET status = 'COMPLETE', hitl_completed_at = NOW(), hitl_reviewer_id = $1, updated_at = NOW() WHERE document_name = $2`, [user.id, docId]);
        } else if (action === 'reject') {
          await db.query(
            `INSERT INTO hitl_reviews (document_id, queue_id, reviewer_id, reviewer_name, action, rejection_reason, rejection_note, review_duration_seconds) VALUES ($1, $2, $3, $4, 'reject', $5, $6, $7)`,
            [docId, queueItem.id, user.id, user.name, body.rejectionReason || body.reason || 'OTHER', body.rejectionNote || body.note || null, durationSeconds]
          );
          await db.query(`UPDATE document_metadata SET status = 'REJECTED', hitl_completed_at = NOW(), hitl_reviewer_id = $1, updated_at = NOW() WHERE document_name = $2`, [user.id, docId]);
        } else if (action === 'escalate') {
          await db.query(
            `INSERT INTO hitl_reviews (document_id, queue_id, reviewer_id, reviewer_name, action, rejection_reason, rejection_note, review_duration_seconds) VALUES ($1, $2, $3, $4, 'escalate', $5, $6, $7)`,
            [docId, queueItem.id, user.id, user.name, body.escalationTarget || 'supervisor', body.escalationReason || null, durationSeconds]
          );
          await db.query(`UPDATE hitl_queue SET status = 'escalated', priority = priority + 10 WHERE document_id = $1`, [docId]);
          await db.query('DELETE FROM hitl_locks WHERE document_id = $1', [docId]);
          await db.query('COMMIT');
          return respond(200, { status: 'escalated' });
        } else {
          await db.query('ROLLBACK');
          return respond(400, { error: 'invalid action: ' + action });
        }
        await db.query('DELETE FROM hitl_queue WHERE document_id = $1', [docId]);
        await db.query('DELETE FROM hitl_locks WHERE document_id = $1', [docId]);
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('Review action failed:', e.message);
        return respond(500, { error: 'review_failed', message: e.message });
      }

      // Send task result to Step Functions
      try {
        if (action === 'approve') {
          await sfn.send(new SendTaskSuccessCommand({ taskToken: queueItem.task_token, output: JSON.stringify({ action: 'approved', reviewerId: user.id, correctedFields: body.correctedFields || {} }) }));
        } else if (action === 'reject') {
          await sfn.send(new SendTaskFailureCommand({ taskToken: queueItem.task_token, error: body.rejectionReason || 'REVIEWER_REJECTED', cause: body.rejectionNote || 'Rejected by reviewer' }));
        }
      } catch (sfnErr) { console.error('SFN task callback failed:', sfnErr.message); }

      const next = await db.query(`SELECT document_id FROM hitl_queue WHERE queue_type = $1 AND status = 'pending' ORDER BY sla_deadline ASC LIMIT 1`, [queueItem.queue_type]);
      return respond(200, { status: action + 'd', nextDocumentId: next.rows[0]?.document_id || null });
    }

    // POST /api/hitl/review/:documentId/approve
    if (path.match(/^\/api\/hitl\/review\/[^/]+\/approve$/) && method === 'POST') {
      const docId = decodeURIComponent(path.split('/')[4]);
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      const body = JSON.parse(event.body || '{}');

      const lock = await db.query('SELECT * FROM hitl_locks WHERE document_id = $1 AND locked_by = $2 AND expires_at > NOW()', [docId, user.id]);
      if (!lock.rows.length) return respond(403, { error: 'no_active_lock' });

      const qi = await db.query('SELECT * FROM hitl_queue WHERE document_id = $1', [docId]);
      if (!qi.rows.length) return respond(404, { error: 'not_in_queue' });
      const queueItem = qi.rows[0];

      const durationSeconds = lock.rows[0].locked_at ? Math.round((Date.now() - new Date(lock.rows[0].locked_at).getTime()) / 1000) : null;

      try {
        await db.query('BEGIN');

        await db.query(
          `INSERT INTO hitl_reviews (document_id, queue_id, reviewer_id, reviewer_name, action, corrected_fields, original_fields, review_duration_seconds)
           VALUES ($1, $2, $3, $4, 'approve', $5, $6, $7)`,
          [docId, queueItem.id, user.id, user.name, JSON.stringify(body.correctedData || {}), JSON.stringify(queueItem.extraction_data || {}), durationSeconds]
        );

        await db.query(
          `UPDATE document_metadata SET status = 'COMPLETE', hitl_completed_at = NOW(), hitl_reviewer_id = $1, updated_at = NOW() WHERE document_name = $2`,
          [user.id, docId]
        );

        await db.query('DELETE FROM hitl_queue WHERE document_id = $1', [docId]);
        await db.query('DELETE FROM hitl_locks WHERE document_id = $1', [docId]);

        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        return respond(500, { error: 'review_failed', message: e.message });
      }

      // Call Step Functions
      try {
        await sfn.send(new SendTaskSuccessCommand({
          taskToken: queueItem.task_token,
          output: JSON.stringify({
            reviewResult: 'approved',
            reviewerId: user.id,
            reviewerName: user.name,
            reviewedAt: new Date().toISOString(),
            correctedData: body.correctedData || {},
          })
        }));
      } catch (sfnErr) {
        console.error('SendTaskSuccess failed (DB already committed):', sfnErr.message);
      }

      // Get next doc for auto-advance
      const next = await db.query(
        `SELECT document_id FROM hitl_queue WHERE queue_type = $1 AND status = 'pending' ORDER BY sla_deadline ASC LIMIT 1`,
        [queueItem.queue_type]
      );

      return respond(200, { status: 'completed', nextDocumentId: next.rows[0]?.document_id || null });
    }

    // POST /api/hitl/review/:documentId/reject
    if (path.match(/^\/api\/hitl\/review\/[^/]+\/reject$/) && method === 'POST') {
      const docId = decodeURIComponent(path.split('/')[4]);
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      const body = JSON.parse(event.body || '{}');

      const lock = await db.query('SELECT * FROM hitl_locks WHERE document_id = $1 AND locked_by = $2 AND expires_at > NOW()', [docId, user.id]);
      if (!lock.rows.length) return respond(403, { error: 'no_active_lock' });

      const qi = await db.query('SELECT * FROM hitl_queue WHERE document_id = $1', [docId]);
      if (!qi.rows.length) return respond(404, { error: 'not_in_queue' });
      const queueItem = qi.rows[0];

      const durationSeconds = lock.rows[0].locked_at ? Math.round((Date.now() - new Date(lock.rows[0].locked_at).getTime()) / 1000) : null;

      try {
        await db.query('BEGIN');
        await db.query(
          `INSERT INTO hitl_reviews (document_id, queue_id, reviewer_id, reviewer_name, action, rejection_reason, rejection_note, review_duration_seconds)
           VALUES ($1, $2, $3, $4, 'reject', $5, $6, $7)`,
          [docId, queueItem.id, user.id, user.name, body.reason || 'OTHER', body.note || null, durationSeconds]
        );
        await db.query(`UPDATE document_metadata SET status = 'REJECTED', hitl_completed_at = NOW(), hitl_reviewer_id = $1, updated_at = NOW() WHERE document_name = $2`, [user.id, docId]);
        await db.query('DELETE FROM hitl_queue WHERE document_id = $1', [docId]);
        await db.query('DELETE FROM hitl_locks WHERE document_id = $1', [docId]);
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        return respond(500, { error: 'review_failed', message: e.message });
      }

      try {
        await sfn.send(new SendTaskFailureCommand({
          taskToken: queueItem.task_token,
          error: body.reason || 'REVIEWER_REJECTED',
          cause: body.note || 'Rejected by reviewer'
        }));
      } catch (sfnErr) {
        console.error('SendTaskFailure failed:', sfnErr.message);
      }

      const next = await db.query(`SELECT document_id FROM hitl_queue WHERE queue_type = $1 AND status = 'pending' ORDER BY sla_deadline ASC LIMIT 1`, [queueItem.queue_type]);
      return respond(200, { status: 'rejected', nextDocumentId: next.rows[0]?.document_id || null });
    }

    // POST /api/hitl/review/:documentId/escalate
    if (path.match(/^\/api\/hitl\/review\/[^/]+\/escalate$/) && method === 'POST') {
      const docId = decodeURIComponent(path.split('/')[4]);
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      const body = JSON.parse(event.body || '{}');

      await db.query(
        `INSERT INTO hitl_reviews (document_id, reviewer_id, reviewer_name, action, escalation_reason) VALUES ($1, $2, $3, 'escalate', $4)`,
        [docId, user.id, user.name, body.reason || '']
      );
      await db.query("UPDATE hitl_queue SET status = 'escalated' WHERE document_id = $1", [docId]);
      await db.query('DELETE FROM hitl_locks WHERE document_id = $1', [docId]);

      return respond(200, { status: 'escalated' });
    }

    // POST /api/hitl/review/:documentId/notes
    if (path.match(/^\/api\/hitl\/review\/[^/]+\/notes$/) && method === 'POST') {
      const docId = decodeURIComponent(path.split('/')[4]);
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      const body = JSON.parse(event.body || '{}');

      const res = await db.query(
        `INSERT INTO hitl_notes (document_id, author_id, author_name, text) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [docId, user.id, user.name, body.text || '']
      );
      return respond(201, { noteId: res.rows[0].id, createdAt: res.rows[0].created_at, author: user.name });
    }

    // GET /api/hitl/history
    if (path === '/api/hitl/history' && method === 'GET') {
      const page = Math.max(parseInt(qs.page || '1', 10), 1);
      const pageSize = Math.min(Math.max(parseInt(qs.pageSize || '25', 10), 1), 100);
      const offset = (page - 1) * pageSize;
      const params = [pageSize, offset];
      const conds = [];

      if (qs.documentId) { params.push(qs.documentId); conds.push(`document_id = $${params.length}`); }
      if (qs.reviewerId) { params.push(qs.reviewerId); conds.push(`reviewer_id = $${params.length}`); }
      if (qs.action) { params.push(qs.action); conds.push(`action = $${params.length}`); }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const rows = await db.query(`SELECT * FROM hitl_reviews ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, params);
      const countRes = await db.query(`SELECT COUNT(*) FROM hitl_reviews ${where}`, params.slice(2));
      const totalItems = parseInt(countRes.rows[0].count, 10);

      return respond(200, {
        items: rows.rows.map(r => ({
          id: r.id, documentId: r.document_id, reviewerId: r.reviewer_id, reviewerName: r.reviewer_name,
          action: r.action, duration: r.review_duration_seconds, correctedFields: r.corrected_fields,
          rejectionReason: r.rejection_reason, timestamp: r.created_at
        })),
        pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) }
      });
    }

    // GET /api/hitl/history/:documentId
    if (path.match(/^\/api\/hitl\/history\//) && method === 'GET') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));
      const rows = await db.query('SELECT * FROM hitl_reviews WHERE document_id = $1 ORDER BY created_at DESC', [docId]);
      return respond(200, { items: rows.rows });
    }


    // GET /api/hitl/templates/:documentType
    if (path.match(/^\/api\/hitl\/templates\/[^/]+$/) && method === 'GET') {
      const docType = decodeURIComponent(path.split('/')[4]).toLowerCase().replace(/[\s]+/g, '_').replace(/-/g, '_');
      // Check cache
      if (templateCache[docType] && Date.now() - templateCacheLoadedAt < TEMPLATE_CACHE_TTL) {
        return respond(200, templateCache[docType]);
      }
      try {
        const res = await db.query('SELECT * FROM document_type_templates WHERE document_type = $1 AND is_active = true', [docType]);
        if (!res.rows.length) return respond(404, { error: 'template_not_found', documentType: docType });
        const tmpl = { documentType: res.rows[0].document_type, version: res.rows[0].version, schema: typeof res.rows[0].field_schema === 'string' ? JSON.parse(res.rows[0].field_schema) : res.rows[0].field_schema };
        templateCache[docType] = tmpl;
        templateCacheLoadedAt = Date.now();
        return respond(200, tmpl);
      } catch(e) { console.error('Template fetch error:', e); return respond(500, { error: e.message }); }
    }

    // GET /api/hitl/templates — list all templates
    if (path === '/api/hitl/templates' && method === 'GET') {
      try {
        const res = await db.query('SELECT document_type, version FROM document_type_templates WHERE is_active = true ORDER BY document_type');
        return respond(200, { templates: res.rows.map(r => ({ documentType: r.document_type, version: r.version })) });
      } catch(e) { console.error('Templates list error:', e); return respond(500, { error: e.message }); }
    }

    // PUT /api/hitl/draft/:documentId
    if (path.match(/^\/api\/hitl\/draft\//) && method === 'PUT') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      const body = JSON.parse(event.body || '{}');
      // Verify lock
      const lock = await db.query('SELECT * FROM hitl_locks WHERE document_id = $1 AND locked_by = $2 AND expires_at > NOW()', [docId, user.id]);
      if (!lock.rows.length) return respond(403, { error: 'no_active_lock' });
      try {
        const res = await db.query(
          `INSERT INTO review_drafts (document_id, reviewer_id, draft_data, mode, document_type, save_count, last_saved_at)
           VALUES ($1, $2, $3, $4, $5, 1, NOW())
           ON CONFLICT (document_id, reviewer_id) DO UPDATE SET
             draft_data = $3, mode = $4, document_type = $5,
             save_count = review_drafts.save_count + 1,
             last_saved_at = NOW(),
             expires_at = NOW() + INTERVAL '72 hours'
           RETURNING last_saved_at, save_count`,
          [docId, user.id, JSON.stringify(body.draftData || {}), body.mode || 'review', body.documentType || '']
        );
        return respond(200, { saved: true, lastSavedAt: res.rows[0].last_saved_at, saveCount: res.rows[0].save_count });
      } catch(e) { console.error('Draft save error:', e); return respond(500, { error: e.message }); }
    }

    // GET /api/hitl/draft/:documentId
    if (path.match(/^\/api\/hitl\/draft\//) && method === 'GET') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      try {
        const res = await db.query('SELECT draft_data, mode, document_type, last_saved_at, save_count FROM review_drafts WHERE document_id = $1 AND reviewer_id = $2', [docId, user.id]);
        if (!res.rows.length) return respond(404, { error: 'no_draft' });
        const r = res.rows[0];
        return respond(200, { draftData: r.draft_data, mode: r.mode, documentType: r.document_type, lastSavedAt: r.last_saved_at, saveCount: r.save_count });
      } catch(e) { console.error('Draft load error:', e); return respond(500, { error: e.message }); }
    }

    // DELETE /api/hitl/draft/:documentId
    if (path.match(/^\/api\/hitl\/draft\//) && method === 'DELETE') {
      const docId = decodeURIComponent(path.split('/').slice(4).join('/'));
      const user = extractUser(event);
      if (!user) return respond(401, { error: 'unauthorized' });
      try {
        await db.query('DELETE FROM review_drafts WHERE document_id = $1 AND reviewer_id = $2', [docId, user.id]);
        return respond(200, { deleted: true });
      } catch(e) { console.error('Draft delete error:', e); return respond(500, { error: e.message }); }
    }

    // ===== EXISTING ENDPOINTS =====

    if (path === '/api/populate') {
      const key = qs.key || '_populate/records.json';
      const obj = await s3.send(new GetObjectCommand({ Bucket: 'idp-dev-intake-430695043165', Key: key }));
      const records = JSON.parse(await obj.Body.transformToString());
      let count = 0, extCount = 0, extErrors = 0;
      for (const r of records) {
        await db.query(
          `INSERT INTO document_metadata (document_name,matter_id,document_type,confidence,status,s3_key,source_channel)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (document_name) DO UPDATE SET
           document_type=EXCLUDED.document_type,confidence=EXCLUDED.confidence,status=EXCLUDED.status,updated_at=NOW()`,
          [r.document_name,r.matter_id,r.document_type,r.confidence,r.status,r.s3_key,r.source_channel]
        );
        if (r.extraction && r.document_type === 'Paystub') {
          const f = r.extraction;
          try {
            await db.query(
              `INSERT INTO paystub (document_name,employees_full_name,address,ssn,employers_name,employers_address,
                employers_phone_number,employers_ein,pay_period_start_date,pay_period_end_date,pay_date,
                gross_pay,net_pay,ytd_gross_earnings,ytd_net_earnings,date_of_issue)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
               ON CONFLICT (document_name) DO UPDATE SET employees_full_name=EXCLUDED.employees_full_name,
                address=EXCLUDED.address,employers_name=EXCLUDED.employers_name,
                gross_pay=EXCLUDED.gross_pay,net_pay=EXCLUDED.net_pay,
                ytd_gross_earnings=EXCLUDED.ytd_gross_earnings,ytd_net_earnings=EXCLUDED.ytd_net_earnings`,
              [r.document_name, f.employeesFullName||null, f.address||null, f.ssn||null,
               f.employersName||null, f.employersAddress||null, f.employersPhoneNumber||null,
               f.employersEin||null, safeDate(f.payPeriodStartDate), safeDate(f.payPeriodEndDate),
               safeDate(f.payDate), safeNum(f.grossPay), safeNum(f.netPay),
               safeNum(f.ytdGrossEarnings), safeNum(f.ytdNetEarnings), safeDate(f.dateOfIssue)]
            );
            extCount++;
          } catch(e) { extErrors++; console.warn(`Extraction insert failed for ${r.document_name}: ${e.message}`); }
        }
        count++;
      }
      return respond(200, { populated: count, extractions: extCount, extractionErrors: extErrors });
    }

    if (path === '/api/stats') {
      const r = await db.query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE status='COMPLETE') as complete,
          COUNT(*) FILTER (WHERE status='PROCESSING') as processing,
          COUNT(*) FILTER (WHERE status='EXTRACTED') as extracted,
          COUNT(*) FILTER (WHERE status='REJECTED') as rejected,
          COUNT(*) FILTER (WHERE status='HITL_REVIEW') as hitl,
          COUNT(*) FILTER (WHERE status='FRAUD_REVIEW') as fraud,
          ROUND(AVG(confidence)::numeric,4) as avg_confidence
        FROM document_metadata`);
      const row = r.rows[0];
      return respond(200, {
        total:+row.total,complete:+row.complete,processing:+row.processing,
        extracted:+row.extracted,rejected:+row.rejected,
        hitlReview:+row.hitl,fraudReview:+row.fraud,
        avgConfidence:+(row.avg_confidence||0),
      });
    }

    if (path === '/api/documents') {
      const { status, limit='100', offset='0', search } = qs;
      let q = 'SELECT * FROM document_metadata';
      const params=[], conds=[];
      if (status && status!=='all') { params.push(status); conds.push('status=$'+params.length); }
      if (search) { params.push('%'+search+'%'); conds.push('(document_name ILIKE $'+params.length+' OR matter_id ILIKE $'+params.length+')'); }
      if (conds.length) q += ' WHERE ' + conds.join(' AND ');
      const safeLimit = Math.min(Math.max(parseInt(limit,10)||100, 1), 500);
      const safeOffset = Math.max(parseInt(offset,10)||0, 0);
      params.push(safeLimit, safeOffset);
      q += ' ORDER BY confidence DESC, created_at DESC LIMIT $' + (params.length-1) + ' OFFSET $' + params.length;
      return respond(200, (await db.query(q, params)).rows);
    }

    if (path.match(/^\/api\/documents\/[^/]+\/pdf$/)) {
      const id = decodeURIComponent(path.split('/')[3]);
      const meta = await db.query('SELECT s3_key FROM document_metadata WHERE document_name=$1',[id]);
      if (!meta.rows.length) return respond(404,{error:'Not found'});
      let s3Key = meta.rows[0].s3_key;
      if (!s3Key) {
        const possibleKeys = [
          'intake/paystubs-v3/' + id.replace(/^(full-|ft\d+-|retry-|v3-)/, '') + '.pdf',
          'intake/paystubs-v2/' + id.replace(/^(full-|ft\d+-|retry-)/, '') + '.pdf',
          'intake/fraud-test-v1/' + id.replace(/^(full-|ft\d+-|retry-)/, '') + '.pdf',
          'intake/paystubs/' + id + '.pdf'
        ];
        for (const key of possibleKeys) {
          try { await s3.send(new HeadObjectCommand({Bucket:'idp-dev-intake-430695043165',Key:key})); s3Key = key; await db.query('UPDATE document_metadata SET s3_key=$1 WHERE document_name=$2',[key,id]).catch(()=>{}); break; } catch(e) {}
        }
        if (!s3Key) return respond(404, {error: 'PDF not found - s3_key not set'});
      }
      const bucket = s3Key.startsWith('intake/') ? 'idp-dev-intake-430695043165' : 'idp-dev-documents-430695043165';
      const url = await getSignedUrl(s3, new GetObjectCommand({Bucket:bucket,Key:s3Key}), {expiresIn:3600});
      return { statusCode:302, headers:{'Location':url,'Access-Control-Allow-Origin':'*'}, body:'' };
    }

    if (path.match(/^\/api\/documents\/[^/]+$/)) {
      const id = decodeURIComponent(path.split('/')[3]);
      const meta = await db.query('SELECT * FROM document_metadata WHERE document_name=$1',[id]);
      if (!meta.rows.length) return respond(404,{error:'Not found'});
      const doc = meta.rows[0];
      let extraction = null;
      const tt = (doc.document_type||'').toLowerCase().replace(/\s+/g,'');
      if (['paystub','photoid','bankstatement','taxreturn','insuranceproof','vehicleregistration','voidedcheck'].includes(tt)) {
        try { const e = await db.query('SELECT * FROM '+tt+' WHERE document_name=$1',[id]); if(e.rows.length) extraction=e.rows[0]; } catch(e) { console.warn('Type table query failed:', e.message); }
      }
      return respond(200, {...doc, extraction});
    }

    if (path === '/api/fix-uuid-s3keys') {
      const { rows } = await db.query("SELECT document_name, s3_key FROM document_metadata WHERE s3_key LIKE '%paystubs-v2/%' AND document_name ~ '^[0-9a-f]{8}-'");
      let updated = 0;
      for (const row of rows) {
        const newKey = row.s3_key.replace('paystubs-v2/', 'paystubs/');
        await db.query('UPDATE document_metadata SET s3_key = $1 WHERE document_name = $2', [newKey, row.document_name]);
        updated++;
      }
      return respond(200, { updated });
    }

    if (path === '/api/backfill-s3keys') {
      const { rows } = await db.query("SELECT document_name FROM document_metadata WHERE s3_key IS NULL");
      let updated = 0;
      for (const row of rows) {
        let clean = row.document_name;
        ['full-','ft5-','ft4-','ft3-','ft2-','retry-'].forEach(p => { if (clean.startsWith(p)) clean = clean.slice(p.length); });
        const s3Key = 'intake/paystubs-v2/' + clean + '.pdf';
        await db.query('UPDATE document_metadata SET s3_key = $1 WHERE document_name = $2', [s3Key, row.document_name]);
        updated++;
      }
      return respond(200, { updated, total: rows.length });
    }

    return respond(404,{error:'Not found'});
  } catch(e) { return respond(500,{error:e.message}); }
  finally { await db.end(); }
};
