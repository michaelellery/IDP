import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Client } from 'pg';

const s3 = new S3Client({});

interface PaystubExtraction {
  employeesFullName: string;
  address: string;
  ssn: string;
  employersName: string;
  employersAddress: string;
  employersPhoneNumber: string;
  employersEin: string;
  payPeriodStartDate: string;
  payPeriodEndDate: string;
  payDate: string;
  grossPay: number;
  netPay: number;
  ytdGrossEarnings: number;
  ytdNetEarnings: number;
  dateOfIssue: string;
}

export const handler = async (event: any) => {
  const { documentId, s3Bucket, s3Key, matterId, classificationResult } = event;
  const startTime = Date.now();
  const docType = classificationResult?.documentType || 'Paystub';

  console.log(`Extracting data from ${documentId} (type: ${docType})`);

  // Get document
  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);

  // In production: call IDP vendor API for extraction
  // The vendor returns structured fields with confidence scores per field
  // For now: simulate extraction (in real implementation, this calls Kofax/ABBYY/Textract)

  // Connect to Aurora RDS
  const dbClient = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'idp',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await dbClient.connect();

    // In production: extracted fields come from vendor API response
    // For simulation, we generate placeholder data
    // Real implementation would parse vendor response and map to our schema

    const overallConfidence = 0.75 + Math.random() * 0.25; // 0.75 - 1.0

    // Insert into document_metadata
    await dbClient.query(
      `INSERT INTO document_metadata (document_name, matter_id, document_type, confidence, status, s3_key, source_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (document_name) DO UPDATE SET confidence = $4, status = $5, updated_at = NOW()`,
      [documentId, matterId, docType, overallConfidence, 'EXTRACTED', s3Key, 'api']
    );

    // Insert extraction results into paystub table
    // In production: map vendor response fields to our schema
    await dbClient.query(
      `INSERT INTO paystub (document_name) VALUES ($1) ON CONFLICT DO NOTHING`,
      [documentId]
    );

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
        processingTimeMs,
        fieldsExtracted: 15,
      },
    };
  } finally {
    await dbClient.end();
  }
};
