import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import Anthropic from '@anthropic-ai/sdk';
import type { DataExtractionEvent, ExtractionResult } from '../../lib/types';

const s3 = new S3Client({});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PAYSTUB_TOOL: Anthropic.Tool = {
  name: 'extract_paystub',
  description: 'Extract structured data from a paystub document',
  input_schema: {
    type: 'object' as const,
    properties: {
      employeesFullName: { type: 'string' }, address: { type: 'string' },
      ssn: { type: 'string' }, employersName: { type: 'string' },
      employersAddress: { type: 'string' }, employersPhoneNumber: { type: 'string' },
      employersEin: { type: 'string' }, payPeriodStartDate: { type: 'string' },
      payPeriodEndDate: { type: 'string' }, payDate: { type: 'string' },
      grossPay: { type: 'number' }, netPay: { type: 'number' },
      ytdGrossEarnings: { type: 'number' }, ytdNetEarnings: { type: 'number' },
      dateOfIssue: { type: 'string' }, confidence: { type: 'number' },
    },
    required: ['employeesFullName', 'confidence'],
  },
};

export const handler = async (event: DataExtractionEvent): Promise<ExtractionResult> => {
  const { documentId, s3Bucket, s3Key, classificationResult } = event;
  const startTime = Date.now();
  const docType = classificationResult?.documentType || 'Paystub';
  console.log(`Extracting: ${documentId} (${docType})`);

  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);
  const base64 = Buffer.from(await obj.Body!.transformToByteArray()).toString('base64');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    tools: [PAYSTUB_TOOL],
    tool_choice: { type: 'tool', name: 'extract_paystub' },
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: 'Extract all paystub fields. Set confidence 0-1 for overall accuracy.' },
    ]}],
  });

  let extracted: Record<string, unknown> = {};
  for (const block of response.content) {
    if (block.type === 'tool_use') extracted = block.input as Record<string, unknown>;
  }

  const processingTimeMs = Date.now() - startTime;
  console.log(`Extraction ${documentId}: confidence ${extracted.confidence}, ${processingTimeMs}ms`);

  return { documentType: docType, confidence: (extracted.confidence as number) || 0.85, fields: extracted as any, processingTimeMs };
};
