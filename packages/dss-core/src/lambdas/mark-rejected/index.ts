import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { MarkRejectedEvent, MarkRejectedResult } from '../../lib/types';

const eb = new EventBridgeClient({});

export const handler = async (event: MarkRejectedEvent): Promise<MarkRejectedResult> => {
  const { documentId, matterId, feedbackType, message } = event;

  await eb.send(new PutEventsCommand({
    Entries: [{
      Source: 'dss.document',
      DetailType: 'dss.document.rejected',
      Detail: JSON.stringify({
        documentId,
        matterId,
        reason: feedbackType,
        message,
        timestamp: new Date().toISOString(),
      }),
      EventBusName: process.env.EVENT_BUS_NAME || 'idp-events',
    }],
  }));

  console.log(`Document ${documentId} REJECTED: ${message}`);
  return { documentId, status: 'REJECTED', reason: feedbackType, message };
};
