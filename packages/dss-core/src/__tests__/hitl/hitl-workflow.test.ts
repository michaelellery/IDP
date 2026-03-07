/**
 * HITL Workflow Tests — Live API
 * Tests full end-to-end flows against the deployed API
 */

const API_BASE = 'https://rzeejg3ra4.execute-api.us-east-1.amazonaws.com';

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> || {}),
    },
  });
}

async function getFirstPendingDocId(): Promise<string | null> {
  const res = await api('/api/hitl/queue?status=pending');
  const body: any = await res.json();
  if (body.items && body.items.length > 0) {
    return body.items[0].documentId || body.items[0].document_id;
  }
  return null;
}

describe('HITL Workflow Tests — Live API', () => {
  jest.setTimeout(60000);

  describe('Full flow: queue → claim → review → approve', () => {
    let docId: string | null = null;

    test('queue lists pending documents', async () => {
      const res = await api('/api/hitl/queue?status=pending');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toHaveProperty('items');
      if (body.items.length > 0) {
        docId = body.items[0].documentId || body.items[0].document_id;
      }
    });

    test('claim locks the document', async () => {
      if (!docId) return console.log('SKIP: no pending docs');
      const res = await api(`/api/hitl/claim/${encodeURIComponent(docId)}`, { method: 'POST' });
      expect([200, 409]).toContain(res.status);
      if (res.status === 409) {
        docId = null; // Can't continue flow
      }
    });

    test('review GET returns document details', async () => {
      if (!docId) return console.log('SKIP: no claimed doc');
      const res = await api(`/api/hitl/review/${encodeURIComponent(docId)}`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toHaveProperty('documentType');
    });

    // Clean up: release instead of approve (don't want to consume task tokens in tests)
    afterAll(async () => {
      if (docId) {
        await api(`/api/hitl/release/${encodeURIComponent(docId)}`, { method: 'POST' });
      }
    });
  });

  describe('Full flow: queue → claim → release → re-claimable', () => {
    test('released document can be re-claimed', async () => {
      const docId = await getFirstPendingDocId();
      if (!docId) return console.log('SKIP: no pending docs');

      // Claim
      const claim1 = await api(`/api/hitl/claim/${encodeURIComponent(docId)}`, { method: 'POST' });
      if (claim1.status !== 200) return;

      // Release
      const release = await api(`/api/hitl/release/${encodeURIComponent(docId)}`, { method: 'POST' });
      expect(release.status).toBe(200);

      // Re-claim
      const claim2 = await api(`/api/hitl/claim/${encodeURIComponent(docId)}`, { method: 'POST' });
      expect(claim2.status).toBe(200);

      // Final cleanup
      await api(`/api/hitl/release/${encodeURIComponent(docId)}`, { method: 'POST' });
    });
  });

  describe('Concurrent claims: two claims on same doc → only one succeeds', () => {
    test('second claim returns 409', async () => {
      const docId = await getFirstPendingDocId();
      if (!docId) return console.log('SKIP: no pending docs');

      const claim1 = await api(`/api/hitl/claim/${encodeURIComponent(docId)}`, { method: 'POST' });
      if (claim1.status !== 200) return;

      // Second claim should fail
      const claim2 = await api(`/api/hitl/claim/${encodeURIComponent(docId)}`, { method: 'POST' });
      expect(claim2.status).toBe(409);

      // Cleanup
      await api(`/api/hitl/release/${encodeURIComponent(docId)}`, { method: 'POST' });
    });
  });

  describe('Notes workflow', () => {
    test('add note and verify it appears in review details', async () => {
      const queueRes = await api('/api/hitl/queue?status=all');
      const queue: any = await queueRes.json();
      if (!queue.items?.length) return console.log('SKIP: no docs');

      const docId = queue.items[0].documentId || queue.items[0].document_id;

      // Add note
      const noteText = `Test note ${Date.now()}`;
      const addRes = await api(`/api/hitl/review/${encodeURIComponent(docId)}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text: noteText }),
      });
      expect(addRes.status).toBeLessThan(300);

      // Verify note appears in review
      const reviewRes = await api(`/api/hitl/review/${encodeURIComponent(docId)}`);
      if (reviewRes.status === 200) {
        const review: any = await reviewRes.json();
        if (review.notes) {
          const found = review.notes.some((n: any) => n.text === noteText);
          expect(found).toBe(true);
        }
      }
    });
  });

  describe('Escalation flow', () => {
    test('escalate changes status to escalated', async () => {
      const docId = await getFirstPendingDocId();
      if (!docId) return console.log('SKIP: no pending docs');

      // Claim first
      const claim = await api(`/api/hitl/claim/${encodeURIComponent(docId)}`, { method: 'POST' });
      if (claim.status !== 200) return;

      // Escalate
      const escRes = await api(`/api/hitl/review/${encodeURIComponent(docId)}/escalate`, {
        method: 'POST',
        body: JSON.stringify({ escalationReason: 'Integration test escalation' }),
      });
      expect(escRes.status).toBe(200);

      // Verify the document shows as escalated in queue
      const queueRes = await api(`/api/hitl/queue?status=escalated`);
      if (queueRes.status === 200) {
        const queue: any = await queueRes.json();
        const found = queue.items?.some((i: any) =>
          (i.documentId || i.document_id) === docId
        );
        // Document should be in escalated status
        if (queue.items?.length > 0) {
          expect(found).toBe(true);
        }
      }
    });
  });
});
