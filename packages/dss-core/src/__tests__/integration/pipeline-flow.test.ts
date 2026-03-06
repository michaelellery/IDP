/**
 * Integration tests — validate data flow between pipeline steps.
 * These don't call real Lambdas; they validate the contract/shape
 * each step produces matches what the next step expects, and that
 * the state machine routing logic is correct.
 */
import {
  BASE_EVENT,
  QUALITY_RESULT_PASS, QUALITY_RESULT_FAIL,
  CLASSIFICATION_RESULT_PAYSTUB, CLASSIFICATION_RESULT_WRONG,
  EXTRACTION_RESULT_COMPLETE, EXTRACTION_RESULT_LOW_CONFIDENCE,
  EXTRACTION_RESULT_BAD_DATES, EXTRACTION_RESULT_MISSING_REQUIRED,
  FRAUD_RESULT_CLEAN, FRAUD_RESULT_FLAGGED,
} from '../fixtures/mock-data';

// State machine routing helpers (mirror the Choice states in ASL)
function qualityGate(qualityResult: any): 'classification' | 'rejected' {
  return qualityResult.passed ? 'classification' : 'rejected';
}

function classificationGate(classResult: any): 'parallel' | 'rejected' {
  return classResult.correctDocument ? 'parallel' : 'rejected';
}

function confidenceGate(processingResults: any[]): 'complete' | 'hitl' | 'fraud-review' {
  const extractionConfidence = processingResults[0]?.extractionResult?.confidence;
  const fraudFlagged = processingResults[1]?.fraudResult?.flagged;

  if (extractionConfidence < 0.85) return 'hitl';
  if (fraudFlagged) return 'fraud-review';
  return 'complete';
}

// Date validation helper (should exist in mark-complete or extraction)
function hasInvalidDates(fields: Record<string, any>): boolean {
  const dateFields = ['payPeriodStartDate', 'payPeriodEndDate', 'payDate', 'dateOfIssue'];
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
  for (const f of dateFields) {
    if (fields[f] && !isoDateRegex.test(fields[f])) return true;
  }
  return false;
}

// Required field validation
function hasMissingRequired(fields: Record<string, any>): boolean {
  const required = ['employeesFullName', 'grossPay', 'netPay'];
  return required.some(f => fields[f] === undefined || fields[f] === null || fields[f] === '');
}

describe('Pipeline Integration — QualityCheck → Classification → Extraction → Complete', () => {
  test('full happy path', () => {
    // Step 1: Quality passes
    expect(qualityGate(QUALITY_RESULT_PASS)).toBe('classification');
    // Step 2: Classification correct
    expect(classificationGate(CLASSIFICATION_RESULT_PAYSTUB)).toBe('parallel');
    // Step 3: High confidence extraction + clean fraud
    const processingResults = [
      { extractionResult: EXTRACTION_RESULT_COMPLETE },
      FRAUD_RESULT_CLEAN,
    ];
    expect(confidenceGate(processingResults)).toBe('complete');
  });
});

describe('Pipeline Integration — Quality Fail → Rejected', () => {
  test('quality failure routes to rejection', () => {
    expect(qualityGate(QUALITY_RESULT_FAIL)).toBe('rejected');
  });
});

describe('Pipeline Integration — Wrong Document → Rejected', () => {
  test('wrong classification routes to rejection', () => {
    expect(qualityGate(QUALITY_RESULT_PASS)).toBe('classification');
    expect(classificationGate(CLASSIFICATION_RESULT_WRONG)).toBe('rejected');
  });
});

describe('Pipeline Integration — Low Confidence → HITL', () => {
  test('low extraction confidence routes to HITL', () => {
    const processingResults = [
      { extractionResult: EXTRACTION_RESULT_LOW_CONFIDENCE },
      FRAUD_RESULT_CLEAN,
    ];
    expect(confidenceGate(processingResults)).toBe('hitl');
  });
});

describe('Pipeline Integration — Fraud Flagged → Fraud Review', () => {
  test('fraud flag routes to fraud review', () => {
    const processingResults = [
      { extractionResult: EXTRACTION_RESULT_COMPLETE },
      FRAUD_RESULT_FLAGGED,
    ];
    expect(confidenceGate(processingResults)).toBe('fraud-review');
  });

  test('low confidence takes priority over fraud flag', () => {
    const processingResults = [
      { extractionResult: EXTRACTION_RESULT_LOW_CONFIDENCE },
      FRAUD_RESULT_FLAGGED,
    ];
    // In the state machine, confidence check comes first
    expect(confidenceGate(processingResults)).toBe('hitl');
  });
});

describe('Pipeline Integration — Invalid Dates → HITL', () => {
  test('dates like "1/7/XX" are detected as invalid', () => {
    expect(hasInvalidDates(EXTRACTION_RESULT_BAD_DATES.fields)).toBe(true);
  });

  test('valid ISO dates pass', () => {
    expect(hasInvalidDates(EXTRACTION_RESULT_COMPLETE.fields)).toBe(false);
  });

  test('missing date fields are not flagged', () => {
    expect(hasInvalidDates({ employeesFullName: 'John' })).toBe(false);
  });
});

describe('Pipeline Integration — Missing Required Fields → HITL', () => {
  test('missing employeesFullName/grossPay/netPay triggers HITL', () => {
    expect(hasMissingRequired(EXTRACTION_RESULT_MISSING_REQUIRED.fields)).toBe(true);
  });

  test('complete fields pass validation', () => {
    expect(hasMissingRequired(EXTRACTION_RESULT_COMPLETE.fields)).toBe(false);
  });
});

describe('State Machine ASL — ConfidenceGate path correctness', () => {
  // This validates the ACTUAL path used in the ASL file
  const stateMachine = require('../../../src/state-machine.asl.json');
  const iterator = stateMachine.States.ProcessDocuments.Iterator;
  const confidenceGateState = iterator.States.ConfidenceGate;

  test('ConfidenceGate checks extractionResult.confidence (not top-level confidence)', () => {
    const confidenceChoice = confidenceGateState.Choices[0];
    // The correct path after Parallel with ResultPath $.processingResults
    expect(confidenceChoice.Variable).toBe('$.processingResults[0].extractionResult.confidence');
  });

  test('ConfidenceGate checks fraudResult.flagged', () => {
    const fraudChoice = confidenceGateState.Choices[1];
    expect(fraudChoice.Variable).toBe('$.processingResults[1].fraudResult.flagged');
  });

  test('ConfidenceGate default routes to MarkComplete', () => {
    expect(confidenceGateState.Default).toBe('MarkComplete');
  });
});
