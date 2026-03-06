import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

const DOCUMENT_TYPES = [
  'Paystub', 'PhotoIDFront', 'PhotoIDBack', 'InsuranceProof',
  'BankStatement', 'VehicleRegistration', 'VoidedCheck', 'TaxReturn',
  'VehiclePicturesVIN', 'VehiclePicturesOdometer', 'VehiclePicturesFront',
  'VehiclePicturesBack', 'VehiclePicturesDriverSide', 'VehiclePicturesPassengerSide',
];

export const handler = async (event: any) => {
  const { documentId, s3Bucket, s3Key, matterId } = event;
  const startTime = Date.now();

  console.log(`Classifying document: ${documentId}`);

  // Get document
  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);

  // In production: call IDP vendor API (Kofax TotalAgility) or custom ML model
  // For now: since we know these are paystubs from the intake bucket path,
  // simulate classification with high confidence

  // Determine expected type from S3 key path
  const pathParts = s3Key.split('/');
  const expectedType = pathParts.includes('paystubs') ? 'Paystub' : undefined;

  // Simulate classification
  const classifiedType = 'Paystub'; // In production: ML model output
  const confidence = 0.88 + Math.random() * 0.12; // 0.88 - 1.0

  const correctDocument = !expectedType || classifiedType === expectedType;

  const processingTimeMs = Date.now() - startTime;

  console.log(`Classification ${documentId}: ${classifiedType} (confidence: ${confidence.toFixed(3)}, correct: ${correctDocument}, ${processingTimeMs}ms)`);

  return {
    ...event,
    classificationResult: {
      documentType: classifiedType,
      confidence,
      correctDocument,
      expectedType,
      processingTimeMs,
    },
  };
};
