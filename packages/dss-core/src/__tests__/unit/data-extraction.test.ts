import { BASE_EVENT, MOCK_CLAUDE_EXTRACTION_RESPONSE } from '../fixtures/mock-data';

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

import { handler } from '../../lambdas/data-extraction/index';

function makeBody() {
  const arr = new Uint8Array(5 * 1024);
  return { Body: { transformToByteArray: () => Promise.resolve(arr) } };
}

describe('Data Extraction Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue(makeBody());
    mockCreate.mockResolvedValue(MOCK_CLAUDE_EXTRACTION_RESPONSE);
  });

  test('happy path — extracts paystub fields via tool_use', async () => {
    const event = { ...BASE_EVENT, classificationResult: { documentType: 'Paystub' } };
    const result = await handler(event);
    expect(result.documentType).toBe('Paystub');
    expect(result.confidence).toBe(0.92);
    expect(result.fields.employeesFullName).toBe('John Doe');
    expect(result.fields.grossPay).toBe(5000);
    expect(result.fields.netPay).toBe(3800);
  });

  test('defaults to Paystub when classificationResult is missing', async () => {
    const result = await handler(BASE_EVENT);
    expect(result.documentType).toBe('Paystub');
  });

  test('LLM returns no tool_use block — empty fields, default confidence', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'I could not extract data from this document.' }],
      usage: { input_tokens: 500, output_tokens: 20 },
    });
    const event = { ...BASE_EVENT, classificationResult: { documentType: 'Paystub' } };
    const result = await handler(event);
    expect(result.fields).toEqual({});
    expect(result.confidence).toBe(0.85); // fallback
  });

  test('S3 error propagates', async () => {
    mockSend.mockRejectedValue(new Error('Bucket not found'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('Bucket not found');
  });

  test('LLM error propagates', async () => {
    mockCreate.mockRejectedValue(new Error('Overloaded'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('Overloaded');
  });

  test('extraction with low confidence value', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use', id: 'toolu_02', name: 'extract_paystub',
        input: { employeesFullName: 'J?', confidence: 0.3 },
      }],
      usage: { input_tokens: 500, output_tokens: 50 },
    });
    const event = { ...BASE_EVENT, classificationResult: { documentType: 'Paystub' } };
    const result = await handler(event);
    expect(result.confidence).toBe(0.3);
  });
});
