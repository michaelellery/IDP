export interface DocumentRecord {
  document_name: string;
  matter_id: string;
  document_type: string;
  confidence: number;
  status: 'PROCESSING' | 'EXTRACTED' | 'COMPLETE' | 'REJECTED' | 'HITL_REVIEW' | 'FRAUD_REVIEW';
  s3_key: string;
  source_channel: string;
  created_at: string;
  updated_at: string;
  processing_time?: number;
  quality_score?: number;
  fraud_flagged?: boolean;
  extraction_data?: Record<string, any>;
}

export interface PipelineStats {
  total: number;
  processing: number;
  complete: number;
  rejected: number;
  hitlReview: number;
  fraudReview: number;
  avgConfidence: number;
  avgProcessingTime: number;
  throughputPerHour: number;
  straightThroughRate: number;
}

export interface TimeSeriesPoint {
  timestamp: string;
  count: number;
  avgConfidence: number;
}
