const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockEnd = jest.fn().mockResolvedValue(undefined);

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
  })),
}));

const mockEbSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn(() => ({ send: mockEbSend })),
  PutEventsCommand: jest.fn((params: any) => params),
}));

import { handler } from '../../lambdas/mark-complete/index';
import { BASE_EVENT, CLASSIFICATION_RESULT_PAYSTUB } from '../fixtures/mock-data';

describe('Mark Complete Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('happy path — updates DB and publishes event', async () => {
    const event = { ...BASE_EVENT, classificationResult: CLASSIFICATION_RESULT_PAYSTUB };
    const result = await handler(event);

    expect(result.status).toBe('COMPLETE');
    expect(result.documentId).toBe('doc-001');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE document_metadata'),
      ['doc-001']
    );
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEbSend).toHaveBeenCalledTimes(1);
  });

  test('with HITL result — resolves HITL record', async () => {
    const event = {
      ...BASE_EVENT,
      classificationResult: CLASSIFICATION_RESULT_PAYSTUB,
      hitlResult: { correctedFields: {} },
    };
    const result = await handler(event);
    expect(result.status).toBe('COMPLETE');
    // Should have 2 queries: update document_metadata + update human_in_the_loop
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE human_in_the_loop'),
      ['doc-001']
    );
  });

  test('DB connection failure propagates', async () => {
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('ECONNREFUSED');
  });

  test('DB query failure propagates', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('relation does not exist');
  });

  test('EventBridge failure propagates (after DB succeeds)', async () => {
    mockEbSend.mockRejectedValueOnce(new Error('EB throttled'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('EB throttled');
    // DB end should still be called (finally block)
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test('always calls dbClient.end() even on error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('some DB error'));
    try { await handler(BASE_EVENT); } catch {}
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });
});
