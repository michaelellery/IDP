import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';

const sm = new SecretsManagerClient({});

let dbConfigPromise: Promise<any> | null = null;
async function fetchDbConfig() {
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: 'idp-dev/db-credentials' }));
  const s = JSON.parse(resp.SecretString!);
  return { host: s.host, port: +s.port || 5432, database: s.dbname || 'idp', user: s.username, password: s.password, ssl: { rejectUnauthorized: false } };
}
function ensureDbConfig() {
  if (!dbConfigPromise) dbConfigPromise = fetchDbConfig();
  return dbConfigPromise;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const dbConfig = await ensureDbConfig();
  const db = new Client(dbConfig);
  await db.connect();

  const failedItems: { itemIdentifier: string }[] = [];
  try {
    for (const record of event.Records) {
      try {
        const body = JSON.parse(record.body);
        const queueType = record.eventSourceARN.includes('fraud-review') ? 'fraud' : 'hitl';
        const slaHours = queueType === 'fraud' ? 1 : 4;

        await db.query(`
          INSERT INTO hitl_queue (document_id, matter_id, document_type, queue_type,
            task_token, confidence, extraction_data, fraud_signals,
            sla_deadline, sqs_message_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
            NOW() + make_interval(hours => $9), $10)
          ON CONFLICT (sqs_message_id) DO NOTHING
        `, [
          body.documentId,
          body.matterId || null,
          body.documentType || 'unknown',
          queueType,
          body.taskToken,
          body.extractionResult?.extractionResult?.confidence || body.extractionResult?.confidence || null,
          JSON.stringify(body.extractionResult || body),
          queueType === 'fraud' ? JSON.stringify(body.fraudSignals || null) : null,
          slaHours,
          record.messageId
        ]);

        const statusVal = queueType === 'fraud' ? 'FRAUD_REVIEW' : 'HITL_REVIEW';
        await db.query(
          `UPDATE document_metadata SET status = $1, hitl_queued_at = NOW(), updated_at = NOW()
           WHERE document_name = $2`,
          [statusVal, body.documentId]
        );
      } catch (itemErr) {
        console.error('Failed to process record:', record.messageId, itemErr);
        failedItems.push({ itemIdentifier: record.messageId });
      }
    }
  } finally {
    await db.end();
  }

  return { batchItemFailures: failedItems };
};
