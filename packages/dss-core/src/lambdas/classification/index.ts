import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import Anthropic from '@anthropic-ai/sdk';
import type { ClassificationEvent, ClassificationResult } from '../../lib/types';

const s3 = new S3Client({});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DOCUMENT_TYPES = ['Paystub','PhotoIDFront','PhotoIDBack','InsuranceProof','BankStatement','VehicleRegistration','VoidedCheck','TaxReturn','VehiclePicturesVIN','VehiclePicturesOdometer','VehiclePicturesFront','VehiclePicturesBack','VehiclePicturesDriverSide','VehiclePicturesPassengerSide','SSN','UtilityBill','W2','1099','Other'];

export const handler = async (event: ClassificationEvent): Promise<ClassificationResult> => {
  const { documentId, s3Bucket, s3Key } = event;
  const startTime = Date.now();
  console.log(`Classifying: ${documentId}`);

  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);
  const body = await obj.Body!.transformToByteArray();
  const base64 = Buffer.from(body).toString('base64');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 256,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: `Classify this document. Return ONLY valid JSON: {"documentType": "<type>", "confidence": <0-1>, "rationale": "<brief>"}\nValid types: ${DOCUMENT_TYPES.join(', ')}` },
    ]}],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  let parsed;
  try { parsed = JSON.parse(text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()); }
  catch { parsed = { documentType: 'Other', confidence: 0.5, rationale: 'Parse failed' }; }

  const expectedType = s3Key.includes('paystubs') ? 'Paystub' : undefined;
  const correctDocument = !expectedType || parsed.documentType === expectedType;
  const processingTimeMs = Date.now() - startTime;
  console.log(`Classification ${documentId}: ${parsed.documentType} (${parsed.confidence}) ${processingTimeMs}ms`);

  return { documentType: parsed.documentType, confidence: parsed.confidence, correctDocument, expectedType, rationale: parsed.rationale, processingTimeMs };
};
