// ============================================================
// Shared types for IDP Lambda pipeline
// ============================================================

// --- Step Functions Event Types ---

export interface PipelineEventBase {
  documentId: string;
  matterId: string;
  s3Bucket: string;
  s3Key: string;
  sourceChannel?: string;
}

export type DecompositionEvent = PipelineEventBase;

export interface QualityCheckEvent {
  documentId: string;
  s3Bucket: string;
  s3Key: string;
}

export interface ClassificationEvent {
  documentId: string;
  s3Bucket: string;
  s3Key: string;
}

export interface DataExtractionEvent {
  documentId: string;
  s3Bucket: string;
  s3Key: string;
  classificationResult?: Partial<ClassificationResult>;
}

/** Fraud check only uses documentId; other fields may be present from pipeline passthrough */
export interface FraudCheckEvent {
  documentId: string;
  s3Bucket?: string;
  s3Key?: string;
}

export interface MarkCompleteEvent {
  documentId: string;
  matterId: string;
  s3Key: string;
  sourceChannel?: string;
  processingResults?: [ExtractionBranch?, FraudBranch?];
  classificationResult?: Partial<ClassificationResult>;
}

interface ExtractionBranch {
  extractionResult?: Partial<ExtractionResult>;
  classificationResult?: Partial<ClassificationResult>;
}

interface FraudBranch {
  fraudResult?: { fraudResult: Partial<FraudResult> };
}

export interface MarkRejectedEvent {
  documentId: string;
  matterId: string;
  feedbackType?: string;
  message?: string;
}

export interface SendFeedbackEvent {
  documentId: string;
  matterId: string;
  qualityResult?: Partial<QualityResult>;
  classificationResult?: Partial<ClassificationResult>;
}

// --- Result Types ---

export interface DecomposedDocument {
  documentId: string;
  matterId: string;
  s3Bucket: string;
  s3Key: string;
  sourceChannel: string;
}

export interface DecompositionResult {
  documents: DecomposedDocument[];
  originalDocument: string;
  documentCount: number;
}

export interface QualityResult {
  passed: boolean;
  score: number;
  issues: string[];
  fourCornerCheck: boolean;
  blurScore: number;
  completenessScore: number;
  processingTimeMs: number;
}

export interface ClassificationResult {
  documentType: string;
  confidence: number;
  correctDocument: boolean;
  expectedType?: string;
  rationale?: string;
  processingTimeMs: number;
}

export interface ExtractionResult {
  documentType: string;
  confidence: number;
  fields: PaystubFields & Record<string, unknown>;
  processingTimeMs: number;
}

export interface PaystubFields {
  employeesFullName?: string;
  address?: string;
  ssn?: string;
  employersName?: string;
  employersAddress?: string;
  employersPhoneNumber?: string;
  employersEin?: string;
  payPeriodStartDate?: string;
  payPeriodEndDate?: string;
  payDate?: string;
  grossPay?: number;
  netPay?: number;
  ytdGrossEarnings?: number;
  ytdNetEarnings?: number;
  dateOfIssue?: string;
  confidence?: number;
}

export interface FraudResult {
  flagged: boolean;
  score: number;
  signals: string[];
  serialFraudLinked: boolean;
  processingTimeMs: number;
}

export interface MarkCompleteResult {
  documentId: string;
  status: 'COMPLETE' | 'HITL_REVIEW';
  confidence: number;
  extractedFields: number;
  missingRequired: string[];
}

export interface MarkRejectedResult {
  documentId: string;
  status: 'REJECTED';
  reason: string | undefined;
  message: string | undefined;
}

export interface FeedbackResult {
  documentId: string;
  matterId: string;
  feedbackType: string;
  message: string;
}

// --- DB Record Types ---

export interface DocumentMetadataRecord {
  document_name: string;
  matter_id: string;
  document_type: string;
  confidence: number;
  status: string;
  s3_key: string;
  source_channel: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface PaystubRecord {
  document_name: string;
  employees_full_name: string | null;
  address: string | null;
  ssn: string | null;
  employers_name: string | null;
  employers_address: string | null;
  employers_phone_number: string | null;
  employers_ein: string | null;
  pay_period_start_date: string | null;
  pay_period_end_date: string | null;
  pay_date: string | null;
  gross_pay: number | null;
  net_pay: number | null;
  ytd_gross_earnings: number | null;
  ytd_net_earnings: number | null;
  date_of_issue: string | null;
}

export interface CategorizationRecord {
  document_name: string;
  category_name: string;
  confidence: number;
}

export interface DocumentTamperingRecord {
  document_name: string;
  flagged: boolean;
  tampering_message: string | null;
}
