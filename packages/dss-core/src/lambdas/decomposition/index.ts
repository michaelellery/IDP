import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PDFDocument } from 'pdf-lib';
import { randomUUID } from 'crypto';
import type { DecompositionEvent, DecompositionResult } from '../../lib/types';

const s3 = new S3Client({});

export const handler = async (event: DecompositionEvent): Promise<DecompositionResult> => {
  const { documentId, matterId, s3Bucket, s3Key, sourceChannel } = event;
  console.log(`Decomposing document: ${documentId}`);

  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);
  const body = await obj.Body!.transformToByteArray();

  const pdfDoc = await PDFDocument.load(body);
  const pageCount = pdfDoc.getPageCount();
  console.log(`Document has ${pageCount} pages`);

  // Single page or small doc = passthrough
  if (pageCount <= 3) {
    return {
      documents: [{
        documentId: documentId || randomUUID(),
        matterId,
        s3Bucket,
        s3Key,
        sourceChannel: sourceChannel || 'api',
      }],
      originalDocument: s3Key,
      documentCount: 1,
    };
  }

  // Multi-page: split each page into its own doc
  const documents = [];
  for (let i = 0; i < pageCount; i++) {
    const newDoc = await PDFDocument.create();
    const [page] = await newDoc.copyPages(pdfDoc, [i]);
    newDoc.addPage(page);
    const newBytes = await newDoc.save();
    const newId = randomUUID();
    const newKey = `processed/${matterId}/${newId}.pdf`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || s3Bucket,
      Key: newKey,
      Body: Buffer.from(newBytes),
      ContentType: 'application/pdf',
    }));

    documents.push({
      documentId: newId,
      matterId,
      s3Bucket: process.env.S3_BUCKET || s3Bucket,
      s3Key: newKey,
      sourceChannel: sourceChannel || 'api',
    });
  }

  return { documents, originalDocument: s3Key, documentCount: documents.length };
};
