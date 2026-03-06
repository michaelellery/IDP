const mockEbSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn(() => ({ send: mockEbSend })),
  PutEventsCommand: jest.fn((params: any) => params),
}));

import { handler } from '../../lambdas/send-feedback/index';
import { QUALITY_RESULT_FAIL, CLASSIFICATION_RESULT_WRONG } from '../fixtures/mock-data';

describe('Send Feedback Lambda', () => {
  beforeEach(() => jest.clearAllMocks());

  test('quality failure feedback', async () => {
    const event = { documentId: 'doc-001', matterId: 'matter-001', qualityResult: QUALITY_RESULT_FAIL };
    const result = await handler(event);
    expect(result.feedbackType).toBe('quality');
    expect(result.message).toContain('blank or corrupt');
    expect(mockEbSend).toHaveBeenCalledTimes(1);
  });

  test('classification mismatch feedback', async () => {
    const event = {
      documentId: 'doc-001', matterId: 'matter-001',
      qualityResult: { passed: true },
      classificationResult: CLASSIFICATION_RESULT_WRONG,
    };
    const result = await handler(event);
    expect(result.feedbackType).toBe('classification');
    expect(result.message).toContain('BankStatement');
    expect(result.message).toContain('Paystub');
  });

  test('unknown feedback when no clear issue', async () => {
    const result = await handler({ documentId: 'doc-001', matterId: 'matter-001' });
    expect(result.feedbackType).toBe('unknown');
  });

  test('EventBridge error propagates', async () => {
    mockEbSend.mockRejectedValueOnce(new Error('EB err'));
    await expect(handler({ documentId: 'd', matterId: 'm' })).rejects.toThrow('EB err');
  });
});
