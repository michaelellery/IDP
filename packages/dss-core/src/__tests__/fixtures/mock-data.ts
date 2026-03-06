// ============================================================
// Test Fixtures — mock events, LLM responses, PDF bytes
// ============================================================

/** Minimal valid PDF (1-page blank) */
export function makeMinimalPdf(): Uint8Array {
  // A real minimal PDF that pdf-lib can parse
  const pdfStr = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer<</Size 4/Root 1 0 R>>
startxref
206
%%EOF`;
  return new TextEncoder().encode(pdfStr);
}

/** Not a PDF at all */
export const NOT_A_PDF = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

/** Tiny file < 1KB (but with PDF magic bytes) */
export const TINY_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x30]); // "%PDF-1.0" only

export const BASE_EVENT = {
  documentId: 'doc-001',
  matterId: 'matter-001',
  s3Bucket: 'test-bucket',
  s3Key: 'uploads/matter-001/doc-001.pdf',
  sourceChannel: 'api',
};

export const CLASSIFICATION_RESULT_PAYSTUB = {
  documentType: 'Paystub',
  confidence: 0.95,
  correctDocument: true,
  rationale: 'Clearly a paystub',
  processingTimeMs: 500,
};

export const CLASSIFICATION_RESULT_WRONG = {
  documentType: 'BankStatement',
  confidence: 0.88,
  correctDocument: false,
  expectedType: 'Paystub',
  rationale: 'This is a bank statement not a paystub',
  processingTimeMs: 450,
};

export const EXTRACTION_RESULT_COMPLETE = {
  documentType: 'Paystub',
  confidence: 0.92,
  fields: {
    employeesFullName: 'John Doe',
    address: '123 Main St',
    grossPay: 5000.00,
    netPay: 3800.00,
    payPeriodStartDate: '2025-01-01',
    payPeriodEndDate: '2025-01-15',
    payDate: '2025-01-20',
    confidence: 0.92,
  },
  processingTimeMs: 1200,
};

export const EXTRACTION_RESULT_LOW_CONFIDENCE = {
  documentType: 'Paystub',
  confidence: 0.60,
  fields: {
    employeesFullName: 'J Doe',
    grossPay: 5000,
    netPay: 3800,
    confidence: 0.60,
  },
  processingTimeMs: 1100,
};

export const EXTRACTION_RESULT_BAD_DATES = {
  documentType: 'Paystub',
  confidence: 0.90,
  fields: {
    employeesFullName: 'John Doe',
    grossPay: 5000,
    netPay: 3800,
    payPeriodStartDate: '1/7/XX',
    payPeriodEndDate: '1/21/XX',
    payDate: '2025-01-25',
    confidence: 0.90,
  },
  processingTimeMs: 900,
};

export const EXTRACTION_RESULT_MISSING_REQUIRED = {
  documentType: 'Paystub',
  confidence: 0.91,
  fields: {
    // missing employeesFullName, grossPay, netPay
    address: '456 Oak Ave',
    payDate: '2025-02-01',
    confidence: 0.91,
  },
  processingTimeMs: 800,
};

export const QUALITY_RESULT_PASS = {
  passed: true,
  score: 0.95,
  issues: [],
  fourCornerCheck: true,
  blurScore: 0.95,
  completenessScore: 0.95,
  processingTimeMs: 120,
};

export const QUALITY_RESULT_FAIL = {
  passed: false,
  score: 0.3,
  issues: ['Document appears blank or corrupt'],
  fourCornerCheck: false,
  blurScore: 0.3,
  completenessScore: 0.3,
  processingTimeMs: 80,
};

export const FRAUD_RESULT_CLEAN = {
  fraudResult: {
    flagged: false,
    score: 0.05,
    signals: [],
    serialFraudLinked: false,
    processingTimeMs: 50,
  },
};

export const FRAUD_RESULT_FLAGGED = {
  fraudResult: {
    flagged: true,
    score: 0.85,
    signals: ['Font inconsistency detected in employer name'],
    serialFraudLinked: false,
    processingTimeMs: 60,
  },
};

/** Mock Claude classification response */
export const MOCK_CLAUDE_CLASSIFICATION_RESPONSE = {
  content: [{
    type: 'text' as const,
    text: '{"documentType": "Paystub", "confidence": 0.95, "rationale": "Clearly a paystub"}',
  }],
  usage: { input_tokens: 1000, output_tokens: 50 },
};

/** Mock Claude extraction response (tool_use) */
export const MOCK_CLAUDE_EXTRACTION_RESPONSE = {
  content: [{
    type: 'tool_use' as const,
    id: 'toolu_01',
    name: 'extract_paystub',
    input: {
      employeesFullName: 'John Doe',
      address: '123 Main St',
      grossPay: 5000.00,
      netPay: 3800.00,
      payPeriodStartDate: '2025-01-01',
      payPeriodEndDate: '2025-01-15',
      payDate: '2025-01-20',
      confidence: 0.92,
    },
  }],
  usage: { input_tokens: 2000, output_tokens: 200 },
};

/** Mock Claude garbage response */
export const MOCK_CLAUDE_GARBAGE_RESPONSE = {
  content: [{
    type: 'text' as const,
    text: 'I cannot process this document clearly. The image is blurry.',
  }],
  usage: { input_tokens: 500, output_tokens: 30 },
};
