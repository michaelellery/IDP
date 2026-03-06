export interface DocumentMetadata {
  documentId: string;
  matterId: string;
  s3Bucket: string;
  s3Key: string;
  sourceChannel: string;
  uploadedAt: string;
}

export interface DecompositionResult {
  documents: DecomposedDocument[];
  originalDocument: string;
}

export interface DecomposedDocument {
  documentId: string;
  matterId: string;
  s3Bucket: string;
  s3Key: string;
  sourceChannel: string;
  pageRange?: { start: number; end: number };
}

export interface QualityResult {
  passed: boolean;
  score: number;
  issues: string[];
  fourCornerCheck: boolean;
  blurScore: number;
  completenessScore: number;
}

export interface ClassificationResult {
  documentType: string;
  confidence: number;
  correctDocument: boolean;
  expectedType?: string;
  rationale?: string;
}

export interface ExtractionResult {
  documentType: string;
  confidence: number;
  fields: Record<string, { value: any; confidence: number }>;
  processingTimeMs: number;
}

export interface FraudResult {
  flagged: boolean;
  score: number;
  signals: string[];
  serialFraudLinked: boolean;
}

export interface FeedbackMessage {
  documentId: string;
  matterId: string;
  type: 'quality' | 'classification' | 'reupload';
  message: string;
  timestamp: string;
}
