import { Client } from 'pg';
import type {
  MarkCompleteEvent,
  MarkCompleteResult,
  ClassificationResult,
  ExtractionResult,
  FraudResult,
} from '../../lib/types';

/** Safely parse a date string, returning ISO date or null for invalid/placeholder values */
function safeDate(val: unknown): string | null {
  if (!val) return null;
  const s = String(val);
  if (s.includes('XX') || s.includes('xx') || s.length < 6) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

/** Safely coerce to number, returning null for non-numeric values */
function safeNum(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

/** Required fields per document type — missing required fields trigger HITL review */
const REQUIRED_FIELDS: Record<string, string[]> = {
  Paystub: ['employeesFullName', 'grossPay', 'netPay'],
};

/** Date fields to validate — invalid dates trigger HITL review */
const DATE_FIELDS = ['payPeriodStartDate', 'payPeriodEndDate', 'payDate', 'dateOfIssue'];

export const handler = async (event: MarkCompleteEvent): Promise<MarkCompleteResult> => {
  const { documentId, matterId, s3Key, sourceChannel } = event;
  console.log(`MarkComplete: ${documentId}`);

  // Extract results from the parallel processing output
  const processingResults = event.processingResults || [];
  const extractionBranch = processingResults[0] || {};
  const fraudBranch = processingResults[1] || {};

  const extractionResult: Partial<ExtractionResult> = extractionBranch.extractionResult || {};
  const fraudResult: Partial<FraudResult> = (fraudBranch.fraudResult || {} as any).fraudResult || {};
  const classificationResult: Partial<ClassificationResult> =
    extractionBranch.classificationResult || event.classificationResult || {};

  const fields: Record<string, unknown> = extractionResult.fields || {};
  const docType = extractionResult.documentType || classificationResult.documentType || 'Unknown';
  const confidence = extractionResult.confidence || 0;

  // Validate required fields based on document type
  const required = REQUIRED_FIELDS[docType] || [];
  const missingRequired = required.filter((f) => !fields[f] && fields[f] !== 0);

  // If missing required fields → HITL review
  let status: 'COMPLETE' | 'HITL_REVIEW' = 'COMPLETE';
  let effectiveConfidence = confidence;
  if (missingRequired.length > 0) {
    status = 'HITL_REVIEW';
    effectiveConfidence = Math.min(confidence, 0.7);
    console.log(`Missing required fields: ${missingRequired.join(', ')} → HITL_REVIEW`);
  }

  // Validate date fields — invalid dates trigger HITL review
  const invalidDates = DATE_FIELDS.filter((f) => {
    const v = fields[f];
    if (!v) return false; // missing is OK (not all dates required)
    const s = String(v);
    if (s.includes('XX') || s.includes('xx') || s.length < 6) return true;
    const d = new Date(s);
    return isNaN(d.getTime());
  });

  if (invalidDates.length > 0) {
    status = 'HITL_REVIEW';
    effectiveConfidence = Math.min(confidence, 0.75);
    console.log(`Invalid dates: ${invalidDates.join(', ')} -> HITL_REVIEW`);
  }

  // Write to RDS
  const db = new Client({
    host: process.env.DB_HOST,
    port: +(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'idp',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await db.connect();

    // Upsert document_metadata
    await db.query(
      `INSERT INTO document_metadata (document_name, matter_id, document_type, confidence, status, s3_key, source_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (document_name) DO UPDATE SET
       document_type=EXCLUDED.document_type, confidence=EXCLUDED.confidence, status=EXCLUDED.status, updated_at=NOW()`,
      [documentId, matterId, docType, effectiveConfidence, status, s3Key, sourceChannel || 'unknown'],
    );

    // Write extraction data to type-specific table
    if (docType === 'Paystub' && Object.keys(fields).length > 0) {
      await db.query(
        `INSERT INTO paystub (document_name, employees_full_name, address, ssn, employers_name, employers_address,
          employers_phone_number, employers_ein, pay_period_start_date, pay_period_end_date, pay_date,
          gross_pay, net_pay, ytd_gross_earnings, ytd_net_earnings, date_of_issue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (document_name) DO UPDATE SET
          employees_full_name=EXCLUDED.employees_full_name, address=EXCLUDED.address,
          employers_name=EXCLUDED.employers_name, gross_pay=EXCLUDED.gross_pay, net_pay=EXCLUDED.net_pay,
          ytd_gross_earnings=EXCLUDED.ytd_gross_earnings, ytd_net_earnings=EXCLUDED.ytd_net_earnings`,
        [
          documentId, fields.employeesFullName, fields.address, fields.ssn,
          fields.employersName, fields.employersAddress, fields.employersPhoneNumber,
          fields.employersEin, safeDate(fields.payPeriodStartDate), safeDate(fields.payPeriodEndDate),
          safeDate(fields.payDate), safeNum(fields.grossPay), safeNum(fields.netPay),
          safeNum(fields.ytdGrossEarnings), safeNum(fields.ytdNetEarnings), safeDate(fields.dateOfIssue),
        ],
      );
      console.log(`Wrote paystub extraction for ${documentId}`);
    }

    // Write categorization
    if (classificationResult.documentType) {
      await db.query(
        `INSERT INTO categorization (document_name, category_name, confidence)
         VALUES ($1,$2,$3) ON CONFLICT (document_name) DO UPDATE SET
         category_name=EXCLUDED.category_name, confidence=EXCLUDED.confidence`,
        [documentId, classificationResult.documentType, classificationResult.confidence || 0],
      ).catch((e: Error) => console.warn(`Non-critical DB write failed: ${e.message}`));
    }

    // Write fraud/tampering
    await db.query(
      `INSERT INTO document_tampering (document_name, flagged, tampering_message)
       VALUES ($1,$2,$3) ON CONFLICT (document_name) DO UPDATE SET
       flagged=EXCLUDED.flagged, tampering_message=EXCLUDED.tampering_message`,
      [
        documentId,
        fraudResult.flagged || false,
        fraudResult.signals?.join('; ') || (fraudResult.flagged ? 'Fraud detected' : null),
      ],
    ).catch((e: Error) => console.warn(`Non-critical DB write failed: ${e.message}`));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`RDS write error for ${documentId}:`, msg);
  } finally {
    await db.end();
  }

  return {
    documentId,
    status,
    confidence: effectiveConfidence,
    extractedFields: Object.keys(fields).length,
    missingRequired,
  };
};
