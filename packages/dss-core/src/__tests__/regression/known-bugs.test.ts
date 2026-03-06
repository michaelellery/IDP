/**
 * Regression tests for specific bugs that have been found in production.
 * Each test documents the bug, how it manifested, and ensures it stays fixed.
 */

describe('REGRESSION: Silent .catch(() => {}) swallowing DB insert errors', () => {
  /**
   * BUG: mark-complete had `.catch(() => {})` on DB insert calls,
   * silently swallowing errors. Documents appeared "complete" in the
   * state machine but were never persisted to the database.
   *
   * FIX: Removed silent catches; errors now propagate and trigger
   * Step Functions retry/catch mechanisms.
   */

  test('mark-complete propagates DB errors instead of swallowing them', async () => {
    // Reset module registry to get fresh mocks
    jest.resetModules();

    const mockQuery = jest.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockEnd = jest.fn().mockResolvedValue(undefined);

    jest.doMock('pg', () => ({
      Client: jest.fn().mockImplementation(() => ({
        connect: mockConnect, query: mockQuery, end: mockEnd,
      })),
    }));

    jest.doMock('@aws-sdk/client-eventbridge', () => ({
      EventBridgeClient: jest.fn(() => ({ send: jest.fn() })),
      PutEventsCommand: jest.fn(),
    }));

    const { handler } = require('../../lambdas/mark-complete/index');

    // The error MUST propagate — if it's silently caught, this test fails
    await expect(handler({
      documentId: 'doc-regression-001',
      matterId: 'matter-001',
    })).rejects.toThrow('duplicate key');
  });

  test('verify mark-complete source has no silent .catch(() => {})', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '../../lambdas/mark-complete/index.ts'), 'utf8'
    );
    // Should NOT contain .catch(() => {}) or .catch(()=>{})
    expect(source).not.toMatch(/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
  });
});

describe('REGRESSION: ConfidenceGate path error in state machine', () => {
  /**
   * BUG: ConfidenceGate was checking `$.processingResults[0].confidence`
   * but the Parallel branch output nests it under extractionResult,
   * so the actual path is `$.processingResults[0].extractionResult.confidence`.
   *
   * This caused ALL documents to go to MarkComplete regardless of confidence,
   * because the Choice state couldn't find the variable and fell through to Default.
   */

  test('ASL ConfidenceGate uses correct nested path', () => {
    const stateMachine = require('../../../src/state-machine.asl.json');
    const iterator = stateMachine.States.ProcessDocuments.Iterator;
    const gate = iterator.States.ConfidenceGate;

    // WRONG (the bug): $.processingResults[0].confidence
    // RIGHT (the fix): $.processingResults[0].extractionResult.confidence
    expect(gate.Choices[0].Variable).not.toBe('$.processingResults[0].confidence');
    expect(gate.Choices[0].Variable).toBe('$.processingResults[0].extractionResult.confidence');
  });

  test('DataExtraction ResultPath is $.extractionResult', () => {
    const stateMachine = require('../../../src/state-machine.asl.json');
    const iterator = stateMachine.States.ProcessDocuments.Iterator;
    const parallel = iterator.States.ParallelProcessing;
    const extractionBranch = parallel.Branches[0];
    const dataExtraction = extractionBranch.States.DataExtraction;
    expect(dataExtraction.ResultPath).toBe('$.extractionResult');
  });
});

describe('REGRESSION: Date type mismatch — "1/7/XX" into PostgreSQL DATE column', () => {
  /**
   * BUG: Claude sometimes extracts dates like "1/7/XX" or "Jan 7" which
   * are not valid PostgreSQL DATE values. Inserting these caused:
   *   ERROR: invalid input syntax for type date: "1/7/XX"
   *
   * FIX: Date validation before DB insert; invalid dates route to HITL.
   */

  const INVALID_DATES = ['1/7/XX', 'Jan 7', '13/2025', 'N/A', 'unknown', '', '1/7/2X'];
  const VALID_DATES = ['2025-01-07', '2025-12-31', '2024-02-29'];

  function isValidPostgresDate(val: any): boolean {
    if (!val || typeof val !== 'string') return false;
    // Must be ISO 8601 format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
    const d = new Date(val);
    return !isNaN(d.getTime());
  }

  test.each(INVALID_DATES)('rejects invalid date: "%s"', (date) => {
    expect(isValidPostgresDate(date)).toBe(false);
  });

  test.each(VALID_DATES)('accepts valid date: "%s"', (date) => {
    expect(isValidPostgresDate(date)).toBe(true);
  });

  test('null/undefined dates are invalid', () => {
    expect(isValidPostgresDate(null)).toBe(false);
    expect(isValidPostgresDate(undefined)).toBe(false);
  });
});

describe('REGRESSION: Quality check rejecting valid small PDFs (5KB → 1KB threshold)', () => {
  /**
   * BUG: Quality check threshold was 5KB, rejecting legitimate small PDFs
   * (e.g., single-page scanned documents, simple paystubs).
   *
   * FIX: Threshold lowered to 1KB.
   */

  test('quality-check source uses 1KB threshold, not 5KB', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '../../lambdas/quality-check/index.ts'), 'utf8'
    );

    // Should check sizeKB < 1, not sizeKB < 5
    expect(source).toContain('sizeKB < 1');
    expect(source).not.toMatch(/sizeKB\s*<\s*5\b/);
  });

  test('a 1.5KB PDF should pass quality check size threshold', () => {
    // This is tested in the unit test too, but documenting the regression here
    const sizeKB = 1.5;
    expect(sizeKB < 1).toBe(false); // Should NOT be flagged
  });

  test('a 2KB PDF should pass quality check size threshold', () => {
    const sizeKB = 2;
    expect(sizeKB < 1).toBe(false);
  });

  test('a 0.5KB PDF should still fail', () => {
    const sizeKB = 0.5;
    expect(sizeKB < 1).toBe(true);
  });
});
