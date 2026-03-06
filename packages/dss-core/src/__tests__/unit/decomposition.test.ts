import { BASE_EVENT } from '../fixtures/mock-data';
import { mockS3Send } from '../fixtures/s3-mock';

// Mock S3 before importing handler
const mockSend = mockS3Send('valid-pdf');
jest.mock('@aws-sdk/client-s3', () => {
  const actual: any = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn(() => ({ send: mockSend })),
  };
});

// pdf-lib mock: simulate page counts
const mockGetPageCount = jest.fn().mockReturnValue(1);
const mockGetPage = jest.fn().mockReturnValue({ getSize: () => ({ width: 612, height: 792 }) });
const mockCopyPages = jest.fn().mockResolvedValue([{}]);
const mockAddPage = jest.fn();
const mockSave = jest.fn().mockResolvedValue(new Uint8Array(100));

jest.mock('pdf-lib', () => ({
  PDFDocument: {
    load: jest.fn().mockResolvedValue({
      getPageCount: mockGetPageCount,
      getPage: mockGetPage,
      copyPages: mockCopyPages,
    }),
    create: jest.fn().mockResolvedValue({
      copyPages: mockCopyPages,
      addPage: mockAddPage,
      save: mockSave,
    }),
  },
}));

import { handler } from '../../lambdas/decomposition/index';

describe('Decomposition Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPageCount.mockReturnValue(1);
  });

  test('happy path — single page passthrough', async () => {
    mockGetPageCount.mockReturnValue(1);
    const result = await handler(BASE_EVENT);
    expect(result.documentCount).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].s3Key).toBe(BASE_EVENT.s3Key);
  });

  test('happy path — 3 pages still passthrough', async () => {
    mockGetPageCount.mockReturnValue(3);
    const result = await handler(BASE_EVENT);
    expect(result.documentCount).toBe(1);
  });

  test('multi-page splits into individual documents', async () => {
    mockGetPageCount.mockReturnValue(5);
    const result = await handler(BASE_EVENT);
    expect(result.documentCount).toBe(5);
    expect(result.documents).toHaveLength(5);
    result.documents.forEach((doc: any) => {
      expect(doc.matterId).toBe(BASE_EVENT.matterId);
      expect(doc.s3Key).toMatch(/^processed\//);
    });
  });

  test('S3 failure propagates error', async () => {
    mockSend.mockRejectedValueOnce(new Error('Access Denied'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('Access Denied');
  });

  test('missing documentId generates UUID', async () => {
    mockGetPageCount.mockReturnValue(1);
    const event = { ...BASE_EVENT, documentId: undefined } as any;
    const result = await handler(event);
    expect(result.documents[0].documentId).toBeDefined();
    expect(result.documents[0].documentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('default sourceChannel is api', async () => {
    mockGetPageCount.mockReturnValue(1);
    const event = { ...BASE_EVENT, sourceChannel: undefined };
    const result = await handler(event);
    expect(result.documents[0].sourceChannel).toBe('api');
  });
});
