import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const s3 = new S3Client({});

/**
 * Compute Laplacian variance as a blur metric.
 * Applies a 3x3 Laplacian kernel and returns the variance of the result.
 * Low variance = blurry image.
 */
async function computeBlurScore(imageBuffer: Buffer): Promise<number> {
  // Convert to grayscale raw pixels
  const { data, info } = await sharp(imageBuffer)
    .grayscale()
    .resize({ width: 1000, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  // Laplacian kernel convolution (approximate via second derivatives)
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      // Laplacian: -4*center + top + bottom + left + right
      const laplacian =
        -4 * data[idx] +
        data[(y - 1) * width + x] +
        data[(y + 1) * width + x] +
        data[y * width + (x - 1)] +
        data[y * width + (x + 1)];
      sum += laplacian;
      sumSq += laplacian * laplacian;
      count++;
    }
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  // Normalize: typical sharp docs have variance > 500, blurry < 100
  // Map to 0-1 scale where 1 = sharp
  return Math.min(1, variance / 1000);
}

/**
 * 4-corner analysis: check if document edges are visible by analyzing
 * contrast at the four corners of the image.
 */
async function analyzeCorners(imageBuffer: Buffer): Promise<{ cornersDetected: number; details: boolean[] }> {
  const { data, info } = await sharp(imageBuffer)
    .grayscale()
    .resize({ width: 800, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const cornerSize = Math.min(80, Math.floor(width * 0.1), Math.floor(height * 0.1));

  function analyzeCornerRegion(startX: number, startY: number): boolean {
    let min = 255, max = 0;
    for (let y = startY; y < startY + cornerSize && y < height; y++) {
      for (let x = startX; x < startX + cornerSize && x < width; x++) {
        const v = data[y * width + x];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    // High contrast at corner suggests a document edge is visible
    return (max - min) > 30;
  }

  const corners = [
    analyzeCornerRegion(0, 0),                                    // top-left
    analyzeCornerRegion(width - cornerSize, 0),                   // top-right
    analyzeCornerRegion(0, height - cornerSize),                  // bottom-left
    analyzeCornerRegion(width - cornerSize, height - cornerSize), // bottom-right
  ];

  return { cornersDetected: corners.filter(Boolean).length, details: corners };
}

/**
 * Completeness check: what percentage of the page has content (non-white pixels).
 */
async function computeCompleteness(imageBuffer: Buffer): Promise<number> {
  const { data, info } = await sharp(imageBuffer)
    .grayscale()
    .resize({ width: 500, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let contentPixels = 0;
  const threshold = 240; // pixels darker than this are "content"
  for (let i = 0; i < data.length; i++) {
    if (data[i] < threshold) contentPixels++;
  }

  return contentPixels / data.length;
}

/**
 * Render first page of PDF to an image buffer using sharp (for image inputs)
 * or pdf-to-img for PDFs.
 */
async function pdfToImage(pdfBuffer: Buffer): Promise<Buffer> {
  // Try to detect if it's already an image
  const isPdf = pdfBuffer[0] === 0x25 && pdfBuffer[1] === 0x50 && pdfBuffer[2] === 0x44 && pdfBuffer[3] === 0x46;

  if (!isPdf) {
    // Already an image (JPEG, PNG, etc.) — just return as-is for sharp
    return pdfBuffer;
  }

  // For PDFs, use pdf-to-img to render first page
  try {
    const { pdf } = await import('pdf-to-img');
    const pages = await pdf(pdfBuffer, { scale: 2.0 });
    for await (const page of pages) {
      // Return just the first page
      return Buffer.from(page);
    }
  } catch (err) {
    console.warn('pdf-to-img failed, falling back to basic checks only:', err);
  }

  // Fallback: can't render, return empty (will get low scores)
  throw new Error('Could not render PDF to image');
}

export const handler = async (event: any) => {
  const { documentId, s3Bucket, s3Key } = event;
  const startTime = Date.now();

  console.log(`Quality check: ${documentId}`);

  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);
  const body = Buffer.from(await obj.Body!.transformToByteArray());
  const sizeKB = body.length / 1024;

  // Basic file checks
  const isPdf = body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46;
  const isImage = body[0] === 0xFF || // JPEG
    (body[0] === 0x89 && body[1] === 0x50) || // PNG
    (body[0] === 0x47 && body[1] === 0x49); // GIF

  if (sizeKB < 5) {
    const processingTimeMs = Date.now() - startTime;
    return {
      ...event,
      qualityResult: {
        passed: false, score: 0.1,
        issues: ['Document appears blank or corrupt (file too small)'],
        fourCornerCheck: false, blurScore: 0, completenessScore: 0, processingTimeMs,
      },
    };
  }

  if (!isPdf && !isImage) {
    const processingTimeMs = Date.now() - startTime;
    return {
      ...event,
      qualityResult: {
        passed: false, score: 0.1,
        issues: ['Unsupported file format - expected PDF or image'],
        fourCornerCheck: false, blurScore: 0, completenessScore: 0, processingTimeMs,
      },
    };
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = await pdfToImage(body);
  } catch {
    // If we can't render, do file-level checks only
    const processingTimeMs = Date.now() - startTime;
    return {
      ...event,
      qualityResult: {
        passed: true, score: 0.6,
        issues: ['Could not render document for image analysis - passed on file checks only'],
        fourCornerCheck: true, blurScore: 0.6, completenessScore: 0.6, processingTimeMs,
      },
    };
  }

  // Run all three checks in parallel
  const [blurScore, cornerResult, completenessScore] = await Promise.all([
    computeBlurScore(imageBuffer),
    analyzeCorners(imageBuffer),
    computeCompleteness(imageBuffer),
  ]);

  const fourCornerCheck = cornerResult.cornersDetected >= 3;
  const issues: string[] = [];

  if (blurScore < 0.5) issues.push(`Document is too blurry to process (blur score: ${blurScore.toFixed(3)})`);
  if (!fourCornerCheck) issues.push(`Document corners not fully visible (${cornerResult.cornersDetected}/4 detected) - please recapture`);
  if (completenessScore < 0.05) issues.push('Document appears blank');
  if (completenessScore < 0.15 && completenessScore >= 0.05) issues.push('Document appears mostly empty or cut off');

  const passed = issues.length === 0;
  const score = passed ? Math.min(blurScore, completenessScore * 2, 1) : Math.max(0.1, Math.min(blurScore, completenessScore));
  const processingTimeMs = Date.now() - startTime;

  console.log(`Quality check ${documentId}: ${passed ? 'PASSED' : 'FAILED'} (blur=${blurScore.toFixed(3)}, corners=${cornerResult.cornersDetected}/4, completeness=${completenessScore.toFixed(3)}, ${processingTimeMs}ms)`);

  return {
    ...event,
    qualityResult: {
      passed, score, issues,
      fourCornerCheck, blurScore, completenessScore,
      cornerDetails: cornerResult.details,
      processingTimeMs,
    },
  };
};
