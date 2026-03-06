/**
 * Content Validation Lambda (Phase 2 Fraud Detection)
 * 
 * Runs AFTER parallel processing completes, so it has access to both:
 * - Phase 1 fraud results (structural/metadata/visual)
 * - Data extraction results (field values to validate)
 * 
 * Scoring: finalScore = (phase1Score * 0.3) + (contentScore * 0.5) + (visualScore * 0.2)
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

const { Pool } = pg;

interface PaystubFields {
  gross_pay?: number; net_pay?: number; total_deductions?: number;
  federal_tax?: number; state_tax?: number; fica_tax?: number;
  ytd_gross_pay?: number; ytd_net_pay?: number; ytd_total_deductions?: number;
  pay_period_start?: string; pay_period_end?: string; pay_date?: string;
  employer_name?: string; employee_name?: string; ssn?: string;
}

interface ValidationSignal {
  check: string; passed: boolean; severity: 'critical' | 'high' | 'medium' | 'low'; detail: string;
}

interface ContentValidationResult {
  documentId: string; matterId: string; contentScore: number; phase1Score: number;
  visualScore: number; finalScore: number; flagged: boolean;
  signals: ValidationSignal[]; documentType: string;
}

function parseNum(v: any): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
  return isNaN(n) ? undefined : n;
}

function approxEqual(a: number, b: number, tolerancePct: number): boolean {
  if (b === 0) return a === 0;
  return Math.abs(a - b) / Math.abs(b) <= tolerancePct;
}

function validateSSN(ssn: string | undefined): ValidationSignal | null {
  if (!ssn) return null;
  if (/^[Xx]{3}-[Xx]{2}-\d{4}$/.test(ssn.trim()))
    return { check: 'ssn_format', passed: true, severity: 'low', detail: 'SSN properly masked' };
  const cleaned = ssn.replace(/[^0-9]/g, '');
  if (cleaned.length !== 9)
    return { check: 'ssn_format', passed: false, severity: 'high', detail: `SSN not 9 digits: ${ssn}` };
  const area = parseInt(cleaned.substring(0, 3), 10);
  const group = parseInt(cleaned.substring(3, 5), 10);
  const serial = parseInt(cleaned.substring(5, 9), 10);
  if (area === 0 || area === 666 || area >= 900)
    return { check: 'ssn_range', passed: false, severity: 'critical', detail: `SSN area number invalid: ${area}` };
  if (group === 0)
    return { check: 'ssn_range', passed: false, severity: 'critical', detail: 'SSN group number is 000' };
  if (serial === 0)
    return { check: 'ssn_range', passed: false, severity: 'critical', detail: 'SSN serial number is 0000' };
  return { check: 'ssn_format', passed: true, severity: 'low', detail: 'SSN format valid' };
}

function validatePaystub(fields: PaystubFields): ValidationSignal[] {
  const signals: ValidationSignal[] = [];
  const gross = parseNum(fields.gross_pay);
  const net = parseNum(fields.net_pay);
  const deductions = parseNum(fields.total_deductions);
  const fedTax = parseNum(fields.federal_tax);
  const stateTax = parseNum(fields.state_tax);
  const fica = parseNum(fields.fica_tax);

  // gross - deductions ≈ net (5%)
  if (gross !== undefined && deductions !== undefined && net !== undefined) {
    const expected = gross - deductions;
    const passed = approxEqual(expected, net, 0.05);
    signals.push({ check: 'pay_math', passed, severity: 'critical',
      detail: passed ? `Pay math OK: ${gross}-${deductions}=${expected} ≈ ${net}`
        : `Pay math FAILED: ${gross}-${deductions}=${expected}, net=${net} (${((Math.abs(expected-net)/Math.abs(net))*100).toFixed(1)}% off)` });
  }

  // YTD >= current period
  const ytdGross = parseNum(fields.ytd_gross_pay);
  const ytdNet = parseNum(fields.ytd_net_pay);
  if (gross !== undefined && ytdGross !== undefined) {
    const passed = ytdGross >= gross;
    signals.push({ check: 'ytd_gross', passed, severity: 'high',
      detail: passed ? `YTD gross (${ytdGross}) >= current (${gross})` : `YTD gross (${ytdGross}) < current (${gross})` });
  }
  if (net !== undefined && ytdNet !== undefined) {
    const passed = ytdNet >= net;
    signals.push({ check: 'ytd_net', passed, severity: 'high',
      detail: passed ? `YTD net (${ytdNet}) >= current (${net})` : `YTD net (${ytdNet}) < current (${net})` });
  }

  // Tax rates
  if (gross !== undefined && gross > 0) {
    if (fedTax !== undefined) {
      const pct = fedTax / gross;
      const passed = pct >= 0.10 && pct <= 0.37;
      signals.push({ check: 'federal_tax_rate', passed, severity: passed ? 'low' : 'medium',
        detail: `Federal tax rate: ${(pct*100).toFixed(1)}% (expected 10-37%)` });
    }
    if (stateTax !== undefined) {
      const pct = stateTax / gross;
      const passed = pct >= 0 && pct <= 0.13;
      signals.push({ check: 'state_tax_rate', passed, severity: passed ? 'low' : 'medium',
        detail: `State tax rate: ${(pct*100).toFixed(1)}% (expected 0-13%)` });
    }
    if (fica !== undefined) {
      const pct = fica / gross;
      const passed = approxEqual(pct, 0.0765, 0.15);
      signals.push({ check: 'fica_rate', passed, severity: passed ? 'low' : 'high',
        detail: `FICA rate: ${(pct*100).toFixed(2)}% (expected ~7.65%)` });
    }
  }

  // Date ordering
  const ppStart = fields.pay_period_start ? new Date(fields.pay_period_start) : null;
  const ppEnd = fields.pay_period_end ? new Date(fields.pay_period_end) : null;
  const payDate = fields.pay_date ? new Date(fields.pay_date) : null;
  if (ppStart && ppEnd && payDate && !isNaN(ppStart.getTime()) && !isNaN(ppEnd.getTime()) && !isNaN(payDate.getTime())) {
    const passed = ppStart < ppEnd && ppEnd <= payDate;
    signals.push({ check: 'date_ordering', passed, severity: 'high',
      detail: passed ? `Dates OK: ${fields.pay_period_start} < ${fields.pay_period_end} <= ${fields.pay_date}`
        : `Date ordering invalid: start=${fields.pay_period_start}, end=${fields.pay_period_end}, pay=${fields.pay_date}` });
  }

  // Employer name
  const employer = (fields.employer_name || (fields as any).employerName || (fields as any).company || (fields as any).employersName || '').trim().toLowerCase();
  const generic = ['company','employer','test','acme','sample','n/a','na','none','abc','xyz'];
  if (!employer) signals.push({ check: 'employer_name', passed: false, severity: 'high', detail: 'Employer name empty' });
  else if (generic.includes(employer)) signals.push({ check: 'employer_name', passed: false, severity: 'medium', detail: `Generic employer: "${fields.employer_name}"` });

  // SSN
  const ssnSig = validateSSN(fields.ssn);
  if (ssnSig) signals.push(ssnSig);

  return signals;
}

function validateGeneric(fields: Record<string, any>): ValidationSignal[] {
  const signals: ValidationSignal[] = [];
  if (fields.ssn) { const s = validateSSN(fields.ssn); if (s) signals.push(s); }
  const nameFields = ['employee_name','borrower_name','applicant_name','name'];
  const names = nameFields.map(f => fields[f]).filter(Boolean).map((n: string) => n.trim().toLowerCase());
  if (names.length > 1) {
    const allSame = names.every(n => n === names[0]);
    signals.push({ check: 'name_consistency', passed: allSame, severity: allSame ? 'low' : 'high',
      detail: allSame ? 'Name fields consistent' : `Inconsistent names: ${names.join(', ')}` });
  }
  return signals;
}

function computeContentScore(signals: ValidationSignal[]): number {
  if (signals.length === 0) return 1.0;
  const weights: Record<string, number> = { critical: 0.4, high: 0.25, medium: 0.2, low: 0.15 };
  let totalW = 0, passedW = 0;
  for (const s of signals) { const w = weights[s.severity] || 0.15; totalW += w; if (s.passed) passedW += w; }
  return totalW > 0 ? passedW / totalW : 1.0;
}

let pool: pg.Pool | null = null;
const smClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;
  const secret = await smClient.send(new GetSecretValueCommand({ SecretId: 'idp-dev/db-credentials' }));
  const creds = JSON.parse(secret.SecretString!);
  pool = new Pool({ host: creds.host, port: creds.port || 5432, database: creds.dbname || creds.database,
    user: creds.username, password: creds.password, ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 60000 });
  return pool;
}

async function storeFraudResult(db: pg.Pool, result: ContentValidationResult): Promise<void> {
  await db.query(
    `INSERT INTO document_fraud_scores (document_id, matter_id, phase1_score, content_score, visual_score, final_score, flagged, signals, document_type, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (document_id) DO UPDATE SET phase1_score=EXCLUDED.phase1_score, content_score=EXCLUDED.content_score,
       visual_score=EXCLUDED.visual_score, final_score=EXCLUDED.final_score, flagged=EXCLUDED.flagged, signals=EXCLUDED.signals, updated_at=NOW()`,
    [result.documentId, result.matterId, result.phase1Score, result.contentScore, result.visualScore, result.finalScore, result.flagged, JSON.stringify(result.signals), result.documentType]
  );
}

export const handler = async (event: any): Promise<any> => {
  console.log('ContentValidation input:', JSON.stringify(event).substring(0, 2000));
  const extractionBranch = event.processingResults?.[0] || {};
  const fraudBranch = event.processingResults?.[1] || {};
  const extractionResult = extractionBranch.extractionResult || {};
  const fraudResult = fraudBranch.fraudResult || {};
  const documentId = event.documentId;
  const matterId = event.matterId;
  const documentType = (event.classificationResult?.documentType || 'unknown').toLowerCase();
  const extractedFields = extractionResult.extractedData || extractionResult.fields || extractionResult.data || {};

  const phase1Score = fraudResult.fraudResult?.score ?? fraudResult.score ?? 1.0;
  const visualScore = fraudResult.fraudResult?.visualScore ?? fraudResult.visualScore ?? 0;

  let signals: ValidationSignal[] = [];
  if (documentType.includes('paystub') || documentType.includes('pay_stub') || documentType.includes('pay stub'))
    signals = validatePaystub(extractedFields as PaystubFields);
  signals = signals.concat(validateGeneric(extractedFields));

  const contentScore = computeContentScore(signals);
  const finalScore = (phase1Score * 0.3) + (contentScore * 0.5) + (visualScore * 0.2);
  const hasCritical = signals.some(s => !s.passed && (s.severity === 'critical' || s.severity === 'high'));
  const flagged = (finalScore > 0.6 && hasCritical) || signals.filter(s => !s.passed && s.severity === 'critical').length >= 2;

  const result: ContentValidationResult = { documentId, matterId, contentScore, phase1Score, visualScore, finalScore, flagged, signals, documentType };

  try { const db = await getPool(); await storeFraudResult(db, result); } catch (err) { console.error('DB store failed:', err); }

  console.log('ContentValidation result:', JSON.stringify({ finalScore, flagged, signalCount: signals.length }));
  return { ...event, contentValidationResult: result };
};
