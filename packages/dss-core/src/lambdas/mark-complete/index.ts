import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { Client } from 'pg';

const eb = new EventBridgeClient({});

export const handler = async (event: any) => {
  const { documentId, matterId, classificationResult, processingResults, hitlResult } = event;

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

    // Update document metadata to COMPLETE
    await dbClient.query(
      `UPDATE document_metadata SET status = 'COMPLETE', updated_at = NOW() WHERE document_name = $1`,
      [documentId]
    );

    // If HITL result exists, update with corrected data
    if (hitlResult) {
      await dbClient.query(
        `UPDATE human_in_the_loop SET status = 'RESOLVED', resolved_at = NOW() WHERE document_name = $1`,
        [documentId]
      );
    }
  } finally {
    await dbClient.end();
  }

  // Publish completion event
  await eb.send(new PutEventsCommand({
    Entries: [{
      Source: 'dss.document',
      DetailType: 'dss.document.complete',
      Detail: JSON.stringify({
        documentId,
        matterId,
        documentType: classificationResult?.documentType,
        status: 'COMPLETE',
        timestamp: new Date().toISOString(),
      }),
      EventBusName: process.env.EVENT_BUS_NAME || 'idp-events',
    }],
  }));

  console.log(`Document ${documentId} marked COMPLETE`);
  return { documentId, status: 'COMPLETE' };
};
