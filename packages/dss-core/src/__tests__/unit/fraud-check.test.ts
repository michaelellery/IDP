import { handler } from '../../lambdas/fraud-check/index';

describe('Fraud Check Lambda', () => {
  test('returns fraudResult with expected shape', async () => {
    const result = await handler({ documentId: 'doc-001' });
    expect(result).toHaveProperty('fraudResult');
    expect(result.fraudResult).toHaveProperty('flagged');
    expect(result.fraudResult).toHaveProperty('score');
    expect(result.fraudResult).toHaveProperty('signals');
    expect(result.fraudResult).toHaveProperty('serialFraudLinked', false);
    expect(typeof result.fraudResult.processingTimeMs).toBe('number');
  });

  test('score is between 0 and 1', async () => {
    // Run multiple times since it's random
    for (let i = 0; i < 20; i++) {
      const result = await handler({ documentId: `doc-${i}` });
      expect(result.fraudResult.score).toBeGreaterThanOrEqual(0);
      expect(result.fraudResult.score).toBeLessThanOrEqual(1);
    }
  });

  test('flagged documents have at least one signal', async () => {
    // Force flagged by mocking Math.random
    jest.spyOn(Math, 'random').mockReturnValue(0.01); // < 0.02 threshold
    const result = await handler({ documentId: 'doc-flagged' });
    expect(result.fraudResult.flagged).toBe(true);
    expect(result.fraudResult.signals.length).toBeGreaterThanOrEqual(1);
    jest.restoreAllMocks();
  });

  test('clean documents have no signals', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // > 0.02 threshold
    const result = await handler({ documentId: 'doc-clean' });
    expect(result.fraudResult.flagged).toBe(false);
    expect(result.fraudResult.signals).toHaveLength(0);
    jest.restoreAllMocks();
  });
});
