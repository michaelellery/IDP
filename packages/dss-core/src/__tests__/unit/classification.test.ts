import { BASE_EVENT, MOCK_CLAUDE_CLASSIFICATION_RESPONSE, MOCK_CLAUDE_GARBAGE_RESPONSE } from '../fixtures/mock-data';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  GetObjectCommand: jest.fn(),
}));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

import { handler } from '../../lambdas/classification/index';

function makeBody(sizeKB: number = 5) {
  const arr = new Uint8Array(sizeKB * 1024);
  arr[0] = 0x25; arr[1] = 0x50; arr[2] = 0x44; arr[3] = 0x46;
  return { Body: { transformToByteArray: () => Promise.resolve(arr) } };
}

describe('Classification Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue(makeBody());
    mockCreate.mockResolvedValue(MOCK_CLAUDE_CLASSIFICATION_RESPONSE);
  });

  test('happy path — classifies as Paystub', async () => {
    const result = await handler(BASE_EVENT);
    expect(result.documentType).toBe('Paystub');
    expect(result.confidence).toBe(0.95);
    expect(result.correctDocument).toBe(true);
  });

  test('wrong document type when key implies paystubs', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"documentType": "BankStatement", "confidence": 0.88, "rationale": "bank stmt"}' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const event = { ...BASE_EVENT, s3Key: 'uploads/paystubs/doc.pdf' };
    const result = await handler(event);
    expect(result.documentType).toBe('BankStatement');
    expect(result.correctDocument).toBe(false);
  });

  test('LLM returns garbage — falls back to Other/0.5', async () => {
    mockCreate.mockResolvedValue(MOCK_CLAUDE_GARBAGE_RESPONSE);
    const result = await handler(BASE_EVENT);
    expect(result.documentType).toBe('Other');
    expect(result.confidence).toBe(0.5);
  });

  test('LLM returns JSON in markdown code block', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n{"documentType": "W2", "confidence": 0.91, "rationale": "W2 form"}\n```' }],
      usage: { input_tokens: 100, output_tokens: 30 },
    });
    const result = await handler(BASE_EVENT);
    expect(result.documentType).toBe('W2');
    expect(result.confidence).toBe(0.91);
  });

  test('S3 failure propagates', async () => {
    mockSend.mockRejectedValue(new Error('S3 down'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('S3 down');
  });

  test('LLM API failure propagates', async () => {
    mockCreate.mockRejectedValue(new Error('Rate limited'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('Rate limited');
  });
});
