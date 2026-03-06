import { Client } from 'pg';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});

function getDbClient() {
  return new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'idp',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
}

export const handler = async (event: any) => {
  const { path, httpMethod, queryStringParameters: qs, pathParameters } = event;
  const db = getDbClient();

  try {
    await db.connect();

    // GET /api/stats
    if (path === '/api/stats') {
      const result = await db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'PROCESSING') as processing,
          COUNT(*) FILTER (WHERE status = 'COMPLETE') as complete,
          COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected,
          COUNT(*) FILTER (WHERE status = 'HITL_REVIEW') as hitl_review,
          COUNT(*) FILTER (WHERE status = 'FRAUD_REVIEW') as fraud_review,
          AVG(confidence) as avg_confidence,
          AVG(r.total_time) as avg_processing_time
        FROM document_metadata m
        LEFT JOIN response_time r ON m.document_name = r.document_name
      `);

      const row = result.rows[0];
      const total = parseInt(row.total);
      const complete = parseInt(row.complete);

      // Throughput: docs completed in last hour
      const throughputResult = await db.query(`
        SELECT COUNT(*) as count FROM document_metadata
        WHERE status = 'COMPLETE' AND updated_at > NOW() - INTERVAL '1 hour'
      `);

      return respond(200, {
        total,
        processing: parseInt(row.processing),
        complete,
        rejected: parseInt(row.rejected),
        hitlReview: parseInt(row.hitl_review),
        fraudReview: parseInt(row.fraud_review),
        avgConfidence: parseFloat(row.avg_confidence) || 0,
        avgProcessingTime: parseFloat(row.avg_processing_time) || 0,
        throughputPerHour: parseInt(throughputResult.rows[0].count),
        straightThroughRate: total > 0 ? (complete / total) * 100 : 0,
      });
    }

    // GET /api/documents
    if (path === '/api/documents') {
      const status = qs?.status || 'all';
      const limit = parseInt(qs?.limit || '50');
      const offset = parseInt(qs?.offset || '0');

      let query = `
        SELECT m.*, r.total_time as processing_time,
               dt.tampering_message IS NOT NULL as fraud_flagged
        FROM document_metadata m
        LEFT JOIN response_time r ON m.document_name = r.document_name
        LEFT JOIN document_tampering dt ON m.document_name = dt.document_name AND dt.flagged = true
      `;

      const params: any[] = [];
      if (status !== 'all') {
        params.push(status);
        query += ` WHERE m.status = $${params.length}`;
      }
      query += ` ORDER BY m.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

      const result = await db.query(query, params);

      // For each doc, fetch extraction data from type-specific table
      const docs = await Promise.all(result.rows.map(async (row: any) => {
        let extraction_data = null;
        const docType = row.document_type?.toLowerCase();
        if (docType && ['paystub', 'photoid', 'bankstatement', 'taxreturn', 'insuranceproof', 'vehicleregistration', 'voidedcheck'].includes(docType)) {
          try {
            const extResult = await db.query(`SELECT * FROM ${docType} WHERE document_name = $1`, [row.document_name]);
            if (extResult.rows.length > 0) {
              extraction_data = extResult.rows[0];
            }
          } catch {}
        }
        return { ...row, extraction_data };
      }));

      return respond(200, docs);
    }

    // GET /api/documents/{id}/pdf — returns presigned S3 URL
    if (path.match(/\/api\/documents\/[^/]+\/pdf/)) {
      const docId = path.split('/')[3];
      const result = await db.query('SELECT s3_key FROM document_metadata WHERE document_name = $1', [docId]);
      if (result.rows.length === 0) return respond(404, { error: 'Document not found' });

      const s3Key = result.rows[0].s3_key;
      const bucket = process.env.S3_BUCKET || 'idp-dev-documents';
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: s3Key }), { expiresIn: 3600 });

      return respond(302, null, { Location: url });
    }

    // GET /api/timeseries
    if (path === '/api/timeseries') {
      const hours = parseInt(qs?.hours || '24');
      const result = await db.query(`
        SELECT
          date_trunc('hour', created_at) as timestamp,
          COUNT(*) as count,
          AVG(confidence) as avg_confidence
        FROM document_metadata
        WHERE created_at > NOW() - INTERVAL '${hours} hours'
        GROUP BY date_trunc('hour', created_at)
        ORDER BY timestamp
      `);
      return respond(200, result.rows);
    }

    return respond(404, { error: 'Not found' });
  } finally {
    await db.end();
  }
};

function respond(statusCode: number, body: any, headers: Record<string, string> = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    },
    body: body ? JSON.stringify(body) : '',
  };
}
