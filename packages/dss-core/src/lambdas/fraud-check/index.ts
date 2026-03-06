import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { PDFDocument } from 'pdf-lib';

interface FraudCheckEvent {
  documentId: string;
  s3Bucket: string;
  s3Key: string;
  classificationResult?: {
    documentType?: string;
    confidence?: number;
  };
}

interface FraudResult {
  flagged: boolean;
  score: number;
  signals: string[];
  tier: 'rule-based' | 'ai-assisted';
  serialFraudLinked: boolean;
  processingTimeMs: number;
}

interface TierResult {
  score: number;
  signals: string[];
}

const s3 = new S3Client({ region: 'us-east-1' });
const sm = new SecretsManagerClient({ region: 'us-east-1' });

let anthropicApiKey: string | null = null;
async function getAnthropicKey(): Promise<string> {
  if (anthropicApiKey) return anthropicApiKey;
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: 'idp-dev/anthropic-api-key' }));
  anthropicApiKey = resp.SecretString!;
  return anthropicApiKey;
}

const SUSPICIOUS_CREATORS = [
  'photoshop', 'gimp', 'inkscape', 'illustrator', 'paint.net',
  'foxit phantompdf', 'nitro pro', 'sejda', 'smallpdf',
];

function isSuspiciousCreator(value: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return SUSPICIOUS_CREATORS.some(s => lower.includes(s));
}

function isPaystub(docType: string): boolean {
  if (!docType) return false;
  const l = docType.toLowerCase();
  return l.includes('paystub') || l.includes('pay_stub') || l.includes('pay stub');
}

async function tier1Check(
  pdfBytes: Uint8Array,
  fileSize: number,
  classificationResult?: FraudCheckEvent['classificationResult'],
): Promise<TierResult> {
  const signals: string[] = [];
  let score = 0;
  const docType = classificationResult?.documentType || '';
  const confidence = classificationResult?.confidence ?? 1.0;

  // 1. Classification confidence
  if (confidence < 0.7) {
    signals.push(`Low classification confidence: ${confidence.toFixed(2)}`);
    score += 0.25;
  }

  // 2. File size anomalies for paystubs
  if (isPaystub(docType)) {
    if (fileSize < 1024) {
      signals.push(`Suspiciously small file for paystub: ${fileSize} bytes`);
      score += 0.3;
    } else if (fileSize > 10 * 1024 * 1024) {
      signals.push(`Suspiciously large file for paystub: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);
      score += 0.2;
    }
  }

  // Parse PDF
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (e: any) {
    signals.push(`Failed to parse PDF: ${e.message}`);
    return { score: Math.min(score + 0.4, 1.0), signals };
  }

  // 3. Page count
  const pageCount = pdfDoc.getPageCount();
  if (isPaystub(docType) && pageCount > 3) {
    signals.push(`Unusual page count for paystub: ${pageCount} pages`);
    score += 0.15;
  }
  if (pageCount === 0) {
    signals.push('PDF has zero pages');
    score += 0.3;
  }

  // 4. Metadata: creation vs modification date
  const creationDate = pdfDoc.getCreationDate();
  const modDate = pdfDoc.getModificationDate();
  if (creationDate && modDate) {
    const diffMs = modDate.getTime() - creationDate.getTime();
    if (diffMs > 3600000) {
      signals.push(`PDF modified ${Math.round(diffMs / 3600000)}h after creation`);
      score += 0.15;
    }
  }

  // 5. Creator/Producer metadata
  const creator = pdfDoc.getCreator() || '';
  const producer = pdfDoc.getProducer() || '';
  if (isSuspiciousCreator(creator)) {
    signals.push(`Suspicious PDF creator: ${creator}`);
    score += 0.3;
  }
  if (isSuspiciousCreator(producer)) {
    signals.push(`Suspicious PDF producer: ${producer}`);
    score += 0.3;
  }

  // 6. Font count heuristic
  try {
    const pdfStr = Buffer.from(pdfBytes).toString('latin1', 0, Math.min(pdfBytes.length, 500000));
    const fontMatches = pdfStr.match(/\/BaseFont\s*\/([^\s/\]>]+)/g) || [];
    const uniqueFonts = new Set(fontMatches.map(m => m.replace('/BaseFont', '').trim().replace(/^\//, '')));
    if (uniqueFonts.size > 8) {
      signals.push(`Unusual number of fonts: ${uniqueFonts.size}`);
      score += 0.15;
    }
  } catch (_) { /* non-fatal */ }

  return { score: Math.min(score, 1.0), signals };
}

async function tier2Check(
  pdfBytes: Uint8Array,
  classificationResult?: FraudCheckEvent['classificationResult'],
): Promise<TierResult> {
  const signals: string[] = [];
  let score = 0;
  const docType = classificationResult?.documentType || 'document';

  try {
    const apiKey = await getAnthropicKey();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            {
              type: 'text',
              text: `You are a fraud detection analyst. Analyze this ${docType} for signs of tampering or fraud. Check for:\n1. Inconsistent text alignment or spacing\n2. Signs of digital manipulation (mismatched fonts, color inconsistencies)\n3. Unusual formatting for this document type\n4. Missing standard elements (e.g., paystub without employer info, W-2 without EIN)\n\nRespond in JSON only: {"suspicious": true/false, "confidence": 0.0-1.0, "signals": ["list of findings"]}\nIf the document looks legitimate, set suspicious to false with empty signals.`,
            },
          ],
        }],
      }),
    });

    if (!response.ok) {
      console.error(`Claude API error: ${response.status}`);
      return { score: 0, signals: ['Tier 2 API call failed'] };
    }

    const result = await response.json() as any;
    const text: string = result.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.suspicious) {
        score = parsed.confidence || 0.5;
        signals.push(...(parsed.signals || ['AI detected suspicious elements']));
      }
    }
  } catch (e: any) {
    console.error(`Tier 2 error: ${e.message}`);
    signals.push(`Tier 2 analysis error: ${e.message}`);
  }

  return { score, signals };
}

export const handler = async (event: FraudCheckEvent): Promise<{ fraudResult: FraudResult }> => {
  const startTime = Date.now();
  const { documentId, s3Bucket, s3Key, classificationResult } = event;
  console.log(`Fraud check: ${documentId} (${s3Bucket}/${s3Key})`);

  try {
    const [headResp, getResp] = await Promise.all([
      s3.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: s3Key })),
      s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key })),
    ]);

    const fileSize = headResp.ContentLength || 0;
    const pdfBytes = await getResp.Body!.transformToByteArray();

    // Tier 1: Rule-based
    const tier1 = await tier1Check(pdfBytes, fileSize, classificationResult);
    console.log(`Tier 1 score: ${tier1.score.toFixed(3)}, signals: ${tier1.signals.length}`);

    let finalScore = tier1.score;
    let allSignals = [...tier1.signals];
    let tier: 'rule-based' | 'ai-assisted' = 'rule-based';

    // Tier 2: only if Tier 1 ambiguous (0.3-0.7)
    if (tier1.score >= 0.3 && tier1.score <= 0.7) {
      console.log('Tier 1 ambiguous, invoking Tier 2 Claude analysis');
      const tier2 = await tier2Check(pdfBytes, classificationResult);
      finalScore = (tier1.score * 0.4) + (tier2.score * 0.6);
      allSignals.push(...tier2.signals);
      tier = 'ai-assisted';
      console.log(`Tier 2 score: ${tier2.score.toFixed(3)}, blended: ${finalScore.toFixed(3)}`);
    }

    finalScore = Math.min(Math.max(finalScore, 0), 1.0);
    const flagged = finalScore > 0.6;
    const processingTimeMs = Date.now() - startTime;

    console.log(`Fraud check ${documentId}: ${flagged ? 'FLAGGED' : 'CLEAN'} (score: ${finalScore.toFixed(3)}, tier: ${tier}, ${processingTimeMs}ms)`);

    return {
      fraudResult: {
        flagged,
        score: finalScore,
        signals: allSignals,
        tier,
        serialFraudLinked: false,
        processingTimeMs,
      },
    };
  } catch (e: any) {
    console.error(`Fraud check error for ${documentId}: ${e.message}`);
    const processingTimeMs = Date.now() - startTime;
    return {
      fraudResult: {
        flagged: false,
        score: 0,
        signals: [`Error during fraud check: ${e.message}`],
        tier: 'rule-based',
        serialFraudLinked: false,
        processingTimeMs,
      },
    };
  }
};
