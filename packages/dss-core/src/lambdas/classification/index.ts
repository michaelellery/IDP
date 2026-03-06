import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { callLLM, extractTextFromResponse } from '../../lib/llm-client';

const s3 = new S3Client({});

const DOCUMENT_TYPES = [
  'Paystub', 'PhotoIDFront', 'PhotoIDBack', 'InsuranceProof',
  'BankStatement', 'VehicleRegistration', 'VoidedCheck', 'TaxReturn',
  'VehiclePicturesVIN', 'VehiclePicturesOdometer', 'VehiclePicturesFront',
  'VehiclePicturesBack', 'VehiclePicturesDriverSide', 'VehiclePicturesPassengerSide',
  'W2', 'W9', '1099MISC', '1099INT', '1099DIV', '1099NEC', '1099R', '1099SSA',
  'SocialSecurityCard', 'BirthCertificate', 'MarriageCertificate', 'DivorceCertificate',
  'DeathCertificate', 'CourtOrder', 'PowerOfAttorney', 'TrustDocument',
  'DeedOfTrust', 'MortgageStatement', 'PropertyTaxBill', 'HomeownersInsurance',
  'LeaseAgreement', 'RentalAgreement', 'UtilityBill', 'PhoneBill',
  'MedicalBill', 'MedicalRecord', 'PrescriptionRecord', 'DisabilityLetter',
  'EmploymentVerification', 'TerminationLetter', 'OfferLetter', 'BusinessLicense',
  'ArticlesOfIncorporation', 'ProfitLossStatement', 'BalanceSheet', 'InvoiceReceipt',
  'ChildSupportOrder', 'AlimonyOrder', 'StudentLoanStatement', 'Other',
];

const CLASSIFICATION_SYSTEM_PROMPT = `You are a document classification specialist for an Intelligent Document Processing system.

Classify the provided document image into exactly ONE of these ${DOCUMENT_TYPES.length} document types:
${DOCUMENT_TYPES.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "documentType": "<exact type name from list>",
  "confidence": <0.0 to 1.0>,
  "rationale": "<brief 1-2 sentence explanation>"
}

Rules:
- confidence > 0.9: very clear document with obvious identifiers
- confidence 0.7-0.9: likely this type but some ambiguity
- confidence < 0.7: uncertain, may need human review
- Use "Other" only if no type fits at all`;

export const handler = async (event: any) => {
  const { documentId, s3Bucket, s3Key, matterId } = event;
  const startTime = Date.now();

  console.log(`Classifying document: ${documentId}`);

  const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
  const obj = await s3.send(getCmd);
  const body = Buffer.from(await obj.Body!.transformToByteArray());

  // Determine expected type from S3 key path
  const pathParts = s3Key.toLowerCase().split('/');
  const expectedType = pathParts.includes('paystubs') ? 'Paystub'
    : pathParts.includes('photoid') ? 'PhotoIDFront'
    : pathParts.includes('bankstatement') ? 'BankStatement'
    : pathParts.includes('insurance') ? 'InsuranceProof'
    : undefined;

  // Determine media type
  const isPdf = body[0] === 0x25 && body[1] === 0x50;
  let imageBase64: string;
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf';

  if (isPdf) {
    // Render PDF to image for Claude
    try {
      const { pdf } = await import('pdf-to-img');
      const pages = await pdf(body, { scale: 2.0 });
      for await (const page of pages) {
        imageBase64 = Buffer.from(page).toString('base64');
        mediaType = 'image/png';
        break;
      }
    } catch {
      // Send as PDF directly (Claude supports it via base64)
      imageBase64 = body.toString('base64');
      mediaType = 'application/pdf' as any;
    }
  } else {
    imageBase64 = body.toString('base64');
    // Detect image type
    if (body[0] === 0xFF) mediaType = 'image/jpeg';
    else if (body[0] === 0x89) mediaType = 'image/png';
    else mediaType = 'image/jpeg'; // fallback
  }

  const userContent = expectedType
    ? `Classify this document. The expected document type based on the upload path is "${expectedType}" — verify if that matches.`
    : 'Classify this document.';

  const result = await callLLM({
    system: CLASSIFICATION_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType!, data: imageBase64! } },
        { type: 'text', text: userContent },
      ],
    }],
    maxTokens: 512,
  });

  const responseText = extractTextFromResponse(result);
  let parsed: { documentType: string; confidence: number; rationale: string };

  try {
    // Strip possible markdown fences
    const cleaned = responseText.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('Failed to parse classification response:', responseText);
    parsed = { documentType: 'Other', confidence: 0.3, rationale: 'Failed to parse LLM response' };
  }

  // Validate document type
  if (!DOCUMENT_TYPES.includes(parsed.documentType)) {
    console.warn(`Unknown document type "${parsed.documentType}", mapping to Other`);
    parsed.documentType = 'Other';
    parsed.confidence = Math.min(parsed.confidence, 0.5);
  }

  const correctDocument = !expectedType || parsed.documentType === expectedType;
  const processingTimeMs = Date.now() - startTime;

  console.log(`Classification ${documentId}: ${parsed.documentType} (confidence: ${parsed.confidence.toFixed(3)}, correct: ${correctDocument}, ${processingTimeMs}ms)`);

  return {
    ...event,
    classificationResult: {
      documentType: parsed.documentType,
      confidence: parsed.confidence,
      correctDocument,
      expectedType,
      rationale: parsed.rationale,
      processingTimeMs,
      llmUsage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costEstimate: result.costEstimate },
    },
  };
};
