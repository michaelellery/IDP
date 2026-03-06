// ============================================================
// S3 Client mock helper
// ============================================================
import { makeMinimalPdf, NOT_A_PDF, TINY_PDF } from './mock-data';

type S3Scenario = 'valid-pdf' | 'not-pdf' | 'tiny' | 'empty' | 'huge' | 'error';

const scenarioBytes: Record<string, () => Uint8Array> = {
  'valid-pdf': makeMinimalPdf,
  'not-pdf': () => NOT_A_PDF,
  'tiny': () => TINY_PDF,
  'empty': () => new Uint8Array(0),
  'huge': () => new Uint8Array(51 * 1024 * 1024), // 51 MB
};

export function mockS3Send(scenario: S3Scenario = 'valid-pdf') {
  return jest.fn().mockImplementation((cmd: any) => {
    const cmdName = cmd.constructor?.name || cmd?.constructor?.toString();
    if (cmdName === 'GetObjectCommand' || cmd?.input?.Key) {
      if (scenario === 'error') {
        return Promise.reject(new Error('S3 GetObject failed: Access Denied'));
      }
      const bytes = (scenarioBytes[scenario] || scenarioBytes['valid-pdf'])();
      return Promise.resolve({
        Body: {
          transformToByteArray: () => Promise.resolve(bytes),
        },
      });
    }
    // PutObjectCommand
    return Promise.resolve({});
  });
}
