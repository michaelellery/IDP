import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const eb = new EventBridgeClient({});

export const handler = async (event: any) => {
  const { documentId, matterId, qualityResult, classificationResult } = event;

  let feedbackType: string;
  let message: string;

  if (qualityResult && !qualityResult.passed) {
    feedbackType = 'quality';
    message = qualityResult.issues.join('. ');
  } else if (classificationResult && !classificationResult.correctDocument) {
    feedbackType = 'classification';
    message = `You uploaded a ${classificationResult.documentType}, but we need a ${classificationResult.expectedType}. Please upload the correct document.`;
  } else {
    feedbackType = 'unknown';
    message = 'There was an issue with your document. Please try again.';
  }

  // Publish feedback event for real-time delivery
  await eb.send(new PutEventsCommand({
    Entries: [{
      Source: 'dss.feedback',
      DetailType: feedbackType === 'quality' ? 'dss.quality.feedback' : 'dss.classification.feedback',
      Detail: JSON.stringify({
        documentId,
        matterId,
        feedbackType,
        message,
        timestamp: new Date().toISOString(),
      }),
      EventBusName: process.env.EVENT_BUS_NAME || 'idp-events',
    }],
  }));

  console.log(`Feedback sent for ${documentId}: [${feedbackType}] ${message}`);

  return { documentId, matterId, feedbackType, message };
};
