import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const s3 = new S3Client({});

export const handler = async (event: any) => {
  const { documentId, matterId, s3Bucket, s3Key, sourceChannel } = event;

  console.log(`Decomposing document: ${documentId} from ${s3Bucket}/${s3Key}`);

  // Get the document from S3
  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);
  const body = await obj.Body!.transformToByteArray();

  // For paystubs, most uploads are single documents
  // In production, use pdf-lib or similar to detect multi-page/multi-doc PDFs
  // For now: treat each upload as a single document (decomposition = passthrough)
  const decomposedDocs = [{
    documentId: documentId || randomUUID(),
    matterId,
    s3Bucket,
    s3Key,
    sourceChannel: sourceChannel || 'api',
  }];

  // TODO: Multi-document detection logic
  // - Check page count
  // - Detect document boundaries (blank pages, different layouts)
  // - Split and re-upload individual docs to S3

  return {
    documents: decomposedDocs,
    originalDocument: s3Key,
    documentCount: decomposedDocs.length,
  };
};
