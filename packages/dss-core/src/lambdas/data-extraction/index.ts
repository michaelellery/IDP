import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import { callLLM, extractToolUseFromResponse } from '../../lib/llm-client';
import { PAYSTUB_EXTRACTION_PROMPT, PAYSTUB_TOOL_SCHEMA, PAYSTUB_RDS_INSERT, paystubToRdsParams } from '@idp/extraction-schemas';

const s3 = new S3Client({});

async function renderDocumentToImage(body: Buffer): Promise<{ base64: string; mediaType: string }> {
  const isPdf = body[0] === 0x25 && body[1] === 0x50;
  if (isPdf) {
    try {
      const { pdf } = await import('pdf-to-img');
      const pages = await pdf(body, { scale: 2.0 });
      for await (const page of pages) {
        return { base64: Buffer.from(page).toString('base64'), mediaType: 'image/png' };
      }
    } catch {
      return { base64: body.toString('base64'), mediaType: 'application/pdf' };
    }
  }
  const mediaType = body[0] === 0xFF ? 'image/jpeg' : body[0] === 0x89 ? 'image/png' : 'image/jpeg';
  return { base64: body.toString('base64'), mediaType };
}

export const handler = async (event: any) => {
  const { documentId, s3Bucket, s3Key, matterId, classificationResult } = event;
  const startTime = Date.now();
  const docType = classificationResult?.documentType || 'Paystub';

  console.log(`Extracting data from ${documentId} (type: ${docType})`);

  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);
  const body = Buffer.from(await obj.Body!.transformToByteArray());

  const { base64, mediaType } = await renderDocumentToImage(body);

  // Build extraction prompt and tool based on document type
  // Currently supports Paystub — extend by adding new schemas
  let extractionPrompt: string;
  let toolSchema: any;
  let rdsInsertQuery: string;
  let buildRdsParams: (docName: string, fields: any) => any[];

  if (docType === 'Paystub') {
    extractionPrompt = PAYSTUB_EXTRACTION_PROMPT;
    toolSchema = PAYSTUB_TOOL_SCHEMA;
    rdsInsertQuery = PAYSTUB_RDS_INSERT;
    buildRdsParams = paystubToRdsParams;
  } else {
    // Generic extraction for unsupported types — just classify and store metadata
    console.log(`No extraction schema for ${docType}, storing metadata only`);
    const dbClient = new Client({
      host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'idp', user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false },
    });
    try {
      await dbClient.connect();
      await dbClient.query(
        `INSERT INTO document_metadata (document_name, matter_id, document_type, confidence, status, s3_key, source_channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (document_name) DO UPDATE SET confidence = $4, status = $5, updated_at = NOW()`,
        [documentId, matterId, docType, classificationResult?.confidence ?? 0.5, 'EXTRACTED', s3Key, 'api']
      );
      return { extractionResult: { documentType: docType, confidence: 0.5, processingTimeMs: Date.now() - startTime, fieldsExtracted: 0 } };
    } finally {
      await dbClient.end();
    }
  }

  // Call Claude with tool_use for structured extraction
  const result = await callLLM({
    system: extractionPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType as any, data: base64 } },
        { type: 'text', text: 'Extract all fields from this document.' },
      ],
    }],
    tools: [toolSchema],
    toolChoice: { type: 'tool', name: toolSchema.name },
    maxTokens: 4096,
  });

  const extracted = extractToolUseFromResponse(result);
  if (!extracted) {
    console.error('No tool_use response from LLM');
    throw new Error('Extraction failed: no structured output from LLM');
  }

  // Compute overall confidence as average of field confidences
  const confidences = Object.values(extracted).map((f: any) => f?.confidence ?? 0);
  const overallConfidence = confidences.length > 0 ? confidences.reduce((a: number, b: number) => a + b, 0) / confidences.length : 0;

  // Write to RDS
  const dbClient = new Client({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'idp', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false },
  });

  try {
    await dbClient.connect();

    // Insert document metadata
    await dbClient.query(
      `INSERT INTO document_metadata (document_name, matter_id, document_type, confidence, status, s3_key, source_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (document_name) DO UPDATE SET confidence = $4, status = $5, updated_at = NOW()`,
      [documentId, matterId, docType, overallConfidence, 'EXTRACTED', s3Key, 'api']
    );

    // Insert extraction results
    await dbClient.query(rdsInsertQuery, buildRdsParams(documentId, extracted));

    // Insert categorization
    await dbClient.query(
      `INSERT INTO categorization (document_name, category_name, confidence)
       VALUES ($1, $2, $3) ON CONFLICT (document_name) DO UPDATE SET category_name = $2, confidence = $3`,
      [documentId, docType, overallConfidence]
    );

    const processingTimeMs = Date.now() - startTime;

    // Record response time
    await dbClient.query(
      `INSERT INTO response_time (document_name, total_time) VALUES ($1, $2)
       ON CONFLICT (document_name) DO UPDATE SET total_time = $2`,
      [documentId, processingTimeMs / 1000]
    );

    console.log(`Extraction ${documentId}: confidence ${overallConfidence.toFixed(3)}, ${processingTimeMs}ms`);

    return {
      extractionResult: {
        documentType: docType,
        confidence: overallConfidence,
        fields: extracted,
        processingTimeMs,
        fieldsExtracted: Object.keys(extracted).length,
        llmUsage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costEstimate: result.costEstimate },
      },
    };
  } finally {
    await dbClient.end();
  }
};
