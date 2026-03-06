import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PDFDocument } from 'pdf-lib';
import { randomUUID } from 'crypto';
import { callLLM, extractTextFromResponse } from '../../lib/llm-client';

const s3 = new S3Client({});

const BOUNDARY_DETECTION_PROMPT = `You are a document analysis specialist. You are given thumbnail images of pages from a multi-page PDF upload.
Determine where document boundaries are — i.e., which pages belong to the same logical document vs. separate documents.

Respond with ONLY a JSON object (no markdown, no fences):
{
  "documents": [
    { "startPage": 1, "endPage": 2, "type": "Paystub" },
    { "startPage": 3, "endPage": 3, "type": "BankStatement" }
  ]
}

Rules:
- Page numbers are 1-indexed
- Every page must be assigned to exactly one document
- Consecutive pages of the same document type are usually the same document
- Look for visual cues: headers, layouts, document titles, blank separator pages`;

export const handler = async (event: any) => {
  const { documentId, matterId, s3Bucket, s3Key, sourceChannel } = event;
  const startTime = Date.now();

  console.log(`Decomposing document: ${documentId} from ${s3Bucket}/${s3Key}`);

  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);
  const body = Buffer.from(await obj.Body!.transformToByteArray());

  // Check if it's a PDF
  const isPdf = body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46;

  if (!isPdf) {
    // Images are single documents — passthrough
    return {
      documents: [{
        documentId: documentId || randomUUID(),
        matterId, s3Bucket, s3Key,
        sourceChannel: sourceChannel || 'api',
      }],
      originalDocument: s3Key,
      documentCount: 1,
    };
  }

  const pdfDoc = await PDFDocument.load(body);
  const pageCount = pdfDoc.getPageCount();

  console.log(`Document ${documentId} has ${pageCount} pages`);

  // Single page or small docs: passthrough
  if (pageCount <= 3) {
    return {
      documents: [{
        documentId: documentId || randomUUID(),
        matterId, s3Bucket, s3Key,
        sourceChannel: sourceChannel || 'api',
        pageRange: { start: 1, end: pageCount },
      }],
      originalDocument: s3Key,
      documentCount: 1,
    };
  }

  // Multi-page: use Claude to detect document boundaries
  // Render each page to thumbnail
  let pageThumbnails: { base64: string; mediaType: string }[] = [];
  try {
    const { pdf } = await import('pdf-to-img');
    const pages = await pdf(body, { scale: 1.0 }); // lower scale for thumbnails
    let pageNum = 0;
    for await (const page of pages) {
      pageThumbnails.push({ base64: Buffer.from(page).toString('base64'), mediaType: 'image/png' });
      pageNum++;
      if (pageNum >= 20) break; // cap at 20 pages for cost
    }
  } catch (err) {
    console.warn('Could not render pages for boundary detection, treating as single doc:', err);
    return {
      documents: [{
        documentId: documentId || randomUUID(),
        matterId, s3Bucket, s3Key,
        sourceChannel: sourceChannel || 'api',
        pageRange: { start: 1, end: pageCount },
      }],
      originalDocument: s3Key,
      documentCount: 1,
    };
  }

  // Send all thumbnails to Claude for boundary detection
  const imageContent: any[] = pageThumbnails.map((thumb, i) => ([
    { type: 'text' as const, text: `Page ${i + 1}:` },
    { type: 'image' as const, source: { type: 'base64' as const, media_type: thumb.mediaType as any, data: thumb.base64 } },
  ])).flat();

  imageContent.push({ type: 'text' as const, text: `This PDF has ${pageCount} pages. Identify the document boundaries.` });

  const result = await callLLM({
    system: BOUNDARY_DETECTION_PROMPT,
    messages: [{ role: 'user', content: imageContent }],
    maxTokens: 1024,
  });

  const responseText = extractTextFromResponse(result);
  let boundaries: { documents: { startPage: number; endPage: number; type: string }[] };
  try {
    const cleaned = responseText.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    boundaries = JSON.parse(cleaned);
  } catch {
    console.error('Failed to parse boundary detection response, treating as single doc');
    return {
      documents: [{
        documentId: documentId || randomUUID(),
        matterId, s3Bucket, s3Key,
        sourceChannel: sourceChannel || 'api',
        pageRange: { start: 1, end: pageCount },
      }],
      originalDocument: s3Key,
      documentCount: 1,
    };
  }

  // Split PDF and upload individual documents to S3
  const decomposedDocs = [];
  const basePath = s3Key.replace(/\.pdf$/i, '');

  for (const doc of boundaries.documents) {
    const subDoc = await PDFDocument.create();
    for (let p = doc.startPage - 1; p < doc.endPage && p < pageCount; p++) {
      const [copiedPage] = await subDoc.copyPages(pdfDoc, [p]);
      subDoc.addPage(copiedPage);
    }

    const subDocBytes = await subDoc.save();
    const subDocId = randomUUID();
    const subDocKey = `${basePath}_split_p${doc.startPage}-${doc.endPage}_${subDocId}.pdf`;

    await s3.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: subDocKey,
      Body: subDocBytes,
      ContentType: 'application/pdf',
    }));

    decomposedDocs.push({
      documentId: subDocId,
      matterId, s3Bucket, s3Key: subDocKey,
      sourceChannel: sourceChannel || 'api',
      pageRange: { start: doc.startPage, end: doc.endPage },
      suggestedType: doc.type,
    });
  }

  const processingTimeMs = Date.now() - startTime;
  console.log(`Decomposition ${documentId}: split into ${decomposedDocs.length} documents (${processingTimeMs}ms)`);

  return {
    documents: decomposedDocs,
    originalDocument: s3Key,
    documentCount: decomposedDocs.length,
    processingTimeMs,
    llmUsage: boundaries.documents.length > 1
      ? { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costEstimate: result.costEstimate }
      : undefined,
  };
};
