export const handler = async (event: any) => {
  const { documentId } = event;
  const startTime = Date.now();

  console.log(`Fraud check: ${documentId}`);

  // In production: call Resistant.ai API
  // - Document tampering detection
  // - Metadata manipulation check
  // - Serial fraud identification (cross-document linking)

  // Simulate: 2% fraud detection rate
  const flagged = Math.random() < 0.02;
  const score = flagged ? 0.7 + Math.random() * 0.3 : Math.random() * 0.2;
  const signals: string[] = [];

  if (flagged) {
    const possibleSignals = [
      'Font inconsistency detected in employer name',
      'Metadata indicates recent modification',
      'Pay amounts appear digitally altered',
      'Document creation date inconsistent with pay period',
    ];
    signals.push(possibleSignals[Math.floor(Math.random() * possibleSignals.length)]);
  }

  const processingTimeMs = Date.now() - startTime;

  console.log(`Fraud check ${documentId}: ${flagged ? 'FLAGGED' : 'CLEAN'} (score: ${score.toFixed(3)}, ${processingTimeMs}ms)`);

  return {
    fraudResult: {
      flagged,
      score,
      signals,
      serialFraudLinked: false,
      processingTimeMs,
    },
  };
};
