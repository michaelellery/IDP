import { BASE_EVENT } from '../fixtures/mock-data';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const actual: any = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn(() => ({ send: mockSend })) };
});

const mockGetPageCount = jest.fn().mockReturnValue(1);
const mockGetSize = jest.fn().mockReturnValue({ width: 612, height: 792 });
jest.mock('pdf-lib', () => ({
  PDFDocument: {
    load: jest.fn().mockResolvedValue({
      getPageCount: mockGetPageCount,
      getPage: jest.fn().mockReturnValue({ getSize: mockGetSize }),
    }),
  },
}));

import { handler } from '../../lambdas/quality-check/index';

function makeBody(bytes: Uint8Array) {
  return { Body: { transformToByteArray: () => Promise.resolve(bytes) } };
}

// Valid PDF bytes: starts with %PDF and is > 1KB
function validPdfBytes(sizeKB: number = 5): Uint8Array {
  const arr = new Uint8Array(sizeKB * 1024);
  arr[0] = 0x25; arr[1] = 0x50; arr[2] = 0x44; arr[3] = 0x46; // %PDF
  return arr;
}

describe('Quality Check Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue(makeBody(validPdfBytes(5)));
    mockGetPageCount.mockReturnValue(1);
    mockGetSize.mockReturnValue({ width: 612, height: 792 });
  });

  test('happy path — valid PDF passes', async () => {
    const result = await handler(BASE_EVENT);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.score).toBe(0.95);
  });

  test('rejects non-PDF format', async () => {
    mockSend.mockResolvedValue(makeBody(new Uint8Array([0x00, 0x01, 0x02, 0x03, ...new Array(2000).fill(0)])));
    const result = await handler(BASE_EVENT);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('Invalid PDF format');
  });

  test('rejects empty file (< 1KB)', async () => {
    const tiny = new Uint8Array(500); // 0.5 KB
    tiny[0] = 0x25; tiny[1] = 0x50; tiny[2] = 0x44; tiny[3] = 0x46;
    mockSend.mockResolvedValue(makeBody(tiny));
    const result = await handler(BASE_EVENT);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('Document appears blank or corrupt');
  });

  test('rejects oversized file (> 50MB)', async () => {
    mockSend.mockResolvedValue(makeBody(validPdfBytes(51000)));
    const result = await handler(BASE_EVENT);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('Document exceeds maximum file size');
  });

  test('rejects PDF with 0 pages', async () => {
    mockGetPageCount.mockReturnValue(0);
    const result = await handler(BASE_EVENT);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('PDF contains no pages');
  });

  test('rejects PDF with tiny page dimensions', async () => {
    mockGetSize.mockReturnValue({ width: 50, height: 50 });
    const result = await handler(BASE_EVENT);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('Page dimensions too small');
  });

  test('S3 error propagates', async () => {
    mockSend.mockRejectedValue(new Error('NoSuchKey'));
    await expect(handler(BASE_EVENT)).rejects.toThrow('NoSuchKey');
  });

  test('valid small PDF (1.5KB) passes — regression for 5KB threshold bug', async () => {
    mockSend.mockResolvedValue(makeBody(validPdfBytes(1.5)));
    const result = await handler(BASE_EVENT);
    expect(result.passed).toBe(true);
  });

  test('returns processingTimeMs', async () => {
    const result = await handler(BASE_EVENT);
    expect(typeof result.processingTimeMs).toBe('number');
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});
