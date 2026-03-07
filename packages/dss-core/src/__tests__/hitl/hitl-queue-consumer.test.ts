/**
 * HITL Queue Consumer — Unit Tests
 * Tests the SQS consumer Lambda that ingests documents into hitl_queue
 */

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

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({
        host: 'localhost', port: 5432, username: 'test', password: 'test', dbname: 'test',
      }),
    }),
  })),
  GetSecretValueCommand: jest.fn(),
}));

import { handler } from '../../lambdas/hitl-queue-consumer/index';

function makeSqsRecord(overrides: any = {}): any {
  const bodyObj = {
    documentId: 'doc-test-001',
    matterId: 'MATTER-100',
    documentType: 'Paystub',
    extractionResult: {
      extractionResult: {
        confidence: 0.62,
        fields: { gross_pay: { value: '4250.00', confidence: 0.85 } },
      },
    },
    taskToken: 'AQC_very_long_task_token_string_here',
    ...(overrides.bodyOverrides || {}),
  };
  return {
    messageId: overrides.messageId || 'msg-001',
    eventSourceARN: overrides.eventSourceARN || 'arn:aws:sqs:us-east-1:430695043165:idp-dev-hitl-queue',
    body: overrides.rawBody !== undefined ? overrides.rawBody : JSON.stringify(bodyObj),
  };
}

describe('HITL Queue Consumer Lambda', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockConnect.mockClear();
    mockEnd.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  test('parses SQS message with task token correctly', async () => {
    const result = await handler({ Records: [makeSqsRecord()] } as any);

    const insertCall = mockQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_queue')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual(expect.arrayContaining(['AQC_very_long_task_token_string_here']));
    expect(result.batchItemFailures).toEqual([]);
  });

  test('inserts with correct document fields', async () => {
    await handler({ Records: [makeSqsRecord()] } as any);

    const insertCall = mockQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_queue')
    );
    const params = insertCall![1];
    expect(params[0]).toBe('doc-test-001');
    expect(params[1]).toBe('MATTER-100');
    expect(params[2]).toBe('Paystub');
    expect(params[3]).toBe('hitl');
  });

  test('uses ON CONFLICT for dedup', async () => {
    await handler({ Records: [makeSqsRecord(), makeSqsRecord()] } as any);

    const insertCalls = mockQuery.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_queue')
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(2);
    expect(insertCalls[0][0]).toContain('ON CONFLICT');
    expect(insertCalls[0][0]).toContain('DO NOTHING');
  });

  test('handles malformed SQS messages gracefully', async () => {
    const result = await handler({
      Records: [{
        messageId: 'msg-bad',
        eventSourceARN: 'arn:aws:sqs:us-east-1:430695043165:idp-dev-hitl-queue',
        body: 'not valid json {{{',
      }],
    } as any);
    expect(result.batchItemFailures).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemIdentifier: 'msg-bad' })])
    );
  });

  test('SLA = 4h for HITL queue', async () => {
    await handler({ Records: [makeSqsRecord()] } as any);

    const insertCall = mockQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_queue')
    );
    expect(insertCall![1]).toContain(4);
  });

  test('SLA = 1h for fraud queue', async () => {
    await handler({
      Records: [makeSqsRecord({
        eventSourceARN: 'arn:aws:sqs:us-east-1:430695043165:idp-dev-fraud-review-queue',
      })],
    } as any);

    const insertCall = mockQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_queue')
    );
    expect(insertCall![1][3]).toBe('fraud');
    expect(insertCall![1]).toContain(1);
  });

  test('stores fraud signals for fraud queue', async () => {
    await handler({
      Records: [makeSqsRecord({
        eventSourceARN: 'arn:aws:sqs:us-east-1:430695043165:idp-dev-fraud-review-queue',
        bodyOverrides: {
          fraudSignals: { riskScore: 78, signals: [{ type: 'font_mismatch' }] },
        },
      })],
    } as any);

    const insertCall = mockQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_queue')
    );
    const fraudParam = insertCall![1].find((p: any) =>
      typeof p === 'string' && p.includes('riskScore')
    );
    expect(fraudParam).toBeDefined();
    expect(JSON.parse(fraudParam)).toMatchObject({ riskScore: 78 });
  });

  test('updates document_metadata status', async () => {
    await handler({ Records: [makeSqsRecord()] } as any);

    const updateCall = mockQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('UPDATE document_metadata')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain('doc-test-001');
  });

  test('reports partial batch failures', async () => {
    let insertCount = 0;
    mockQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO hitl_queue')) {
        insertCount++;
        if (insertCount === 2) throw new Error('DB error');
      }
      return { rows: [] };
    });

    const result = await handler({
      Records: [
        makeSqsRecord({ messageId: 'msg-ok' }),
        makeSqsRecord({ messageId: 'msg-fail' }),
      ],
    } as any);
    expect(result.batchItemFailures).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemIdentifier: 'msg-fail' })])
    );
  });
});
