const mockEbSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn(() => ({ send: mockEbSend })),
  PutEventsCommand: jest.fn((params: any) => params),
}));

import { handler } from '../../lambdas/mark-rejected/index';

describe('Mark Rejected Lambda', () => {
  beforeEach(() => jest.clearAllMocks());

  test('happy path — returns rejected status', async () => {
    const event = { documentId: 'doc-001', matterId: 'matter-001', feedbackType: 'quality', message: 'Blurry' };
    const result = await handler(event);
    expect(result.status).toBe('REJECTED');
    expect(result.documentId).toBe('doc-001');
    expect(result.reason).toBe('quality');
    expect(mockEbSend).toHaveBeenCalledTimes(1);
  });

  test('EventBridge failure propagates', async () => {
    mockEbSend.mockRejectedValueOnce(new Error('EB down'));
    await expect(handler({ documentId: 'd', matterId: 'm' })).rejects.toThrow('EB down');
  });
});
