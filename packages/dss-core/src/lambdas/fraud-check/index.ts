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

interface ForensicsResult {
  structuralScore: number;
  visualScore: number;
  metadataScore: number;
  fontScore: number;
  details: Record<string, any>;
}

interface FraudResult {
  flagged: boolean;
  score: number;
  signals: string[];
  tier: 'rule-based' | 'ai-assisted';
  forensics: ForensicsResult;
  serialFraudLinked: boolean;
  processingTimeMs: number;
}

interface TierResult {
  score: number;
  signals: string[];
  details?: Record<string, any>;
}

interface Tier2Result extends TierResult {
  dimensionScores: Record<string, number>;
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

const SUSPICIOUS_FONTS = [
  'comicsans', 'comic sans', 'papyrus', 'curlz', 'jokerman',
  'chiller', 'kristen', 'mistral',
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

function isBusinessDoc(docType: string): boolean {
  if (!docType) return false;
  const l = docType.toLowerCase();
  return l.includes('paystub') || l.includes('pay_stub') || l.includes('w-2') || l.includes('w2') ||
    l.includes('1099') || l.includes('tax') || l.includes('bank') || l.includes('invoice') ||
    l.includes('statement') || l.includes('letter');
}

// ─── PDF Structure Forensics ───

function analyzeRawPdfStructure(pdfBytes: Uint8Array) {
  const pdfStr = Buffer.from(pdfBytes).toString('latin1');
  const eofMatches = pdfStr.match(/%%EOF/g) || [];
  const xrefMatches = pdfStr.match(/\bxref\b/g) || [];
  const hasJavaScript = /\/JS\s/.test(pdfStr) || /\/JavaScript\s/.test(pdfStr);
  return {
    incrementalSaves: Math.max(0, eofMatches.length - 1),
    hasJavaScript,
    xrefSections: xrefMatches.length,
  };
}

function analyzeFonts(pdfBytes: Uint8Array) {
  const pdfStr = Buffer.from(pdfBytes).toString('latin1', 0, Math.min(pdfBytes.length, 1000000));
  const fontMatches = pdfStr.match(/\/BaseFont\s*\/([^\s/\]>]+)/g) || [];
  const fontNames = fontMatches.map(m => m.replace('/BaseFont', '').trim().replace(/^\//, ''));
  const uniqueFonts = [...new Set(fontNames)];
  const embeddedCount = (pdfStr.match(/\/FontFile[23]?\s/g) || []).length;
  const subsetFonts = uniqueFonts.filter(f => /^[A-Z]{6}\+/.test(f));
  const suspiciousFontsFound = uniqueFonts.filter(f => {
    const lower = f.toLowerCase().replace(/[^a-z]/g, '');
    return SUSPICIOUS_FONTS.some(s => lower.includes(s.replace(/\s/g, '')));
  });
  const fontFamilies = new Set(uniqueFonts.map(f =>
    f.replace(/^[A-Z]{6}\+/, '').replace(/[-,]?(Bold|Italic|Regular|Light|Medium|Semibold|Thin|Black|Condensed|Oblique).*$/i, '')
  ));
  return {
    totalFonts: uniqueFonts.length,
    uniqueFamilies: fontFamilies.size,
    embeddedCount,
    subsetCount: subsetFonts.length,
    suspiciousFonts: suspiciousFontsFound,
    fontNames: uniqueFonts,
    embeddingRatio: uniqueFonts.length > 0 ? embeddedCount / uniqueFonts.length : 1,
  };
}

function analyzeImages(pdfBytes: Uint8Array) {
  const pdfStr = Buffer.from(pdfBytes).toString('latin1', 0, Math.min(pdfBytes.length, 2000000));
  const imageCount = (pdfStr.match(/\/Subtype\s*\/Image/g) || []).length;
  const jpegCount = (pdfStr.match(/\/DCTDecode/g) || []).length;
  const flateCount = (pdfStr.match(/\/FlateDecode/g) || []).length;
  const mixedFormats = jpegCount > 0 && flateCount > 0 && imageCount > 1;
  const bpcMatches = pdfStr.match(/\/BitsPerComponent\s+(\d+)/g) || [];
  const bpcValues = new Set(bpcMatches.map(m => parseInt(m.replace(/\/BitsPerComponent\s+/, ''))));
  return { imageCount, jpegCount, flateCount, mixedFormats, bitsPerComponentVariation: bpcValues.size > 1 };
}

function analyzeAnnotationsAndForms(pdfBytes: Uint8Array) {
  const pdfStr = Buffer.from(pdfBytes).toString('latin1', 0, Math.min(pdfBytes.length, 1000000));
  const annotCount = (pdfStr.match(/\/Type\s*\/Annot/g) || []).length;
  const widgetCount = (pdfStr.match(/\/Subtype\s*\/Widget/g) || []).length;
  const hasAcroForm = /\/AcroForm/.test(pdfStr);
  const hiddenAnnots = (pdfStr.match(/\/F\s+(\d+)/g) || []).filter(m => {
    const flags = parseInt(m.replace(/\/F\s+/, ''));
    return (flags & 2) !== 0;
  }).length;
  return { annotationCount: annotCount, widgetCount, hasAcroForm, hiddenAnnotations: hiddenAnnots };
}

function analyzeContentStreams(pdfBytes: Uint8Array) {
  const pdfStr = Buffer.from(pdfBytes).toString('latin1', 0, Math.min(pdfBytes.length, 1000000));
  const contentsArrays = (pdfStr.match(/\/Contents\s*\[/g) || []).length;
  return { contentsArrayCount: contentsArrays, hasMultipleContentStreams: contentsArrays > 0 };
}

function detectRedactionArtifacts(pdfBytes: Uint8Array) {
  const pdfStr = Buffer.from(pdfBytes).toString('latin1', 0, Math.min(pdfBytes.length, 1000000));
  const redactAnnots = (pdfStr.match(/\/Subtype\s*\/Redact/g) || []).length;
  const filledRects = (pdfStr.match(/[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+re\s+[fF]\b/g) || []).length;
  return { redactionAnnotations: redactAnnots, filledRectangles: filledRects, suspicious: redactAnnots > 0 || filledRects > 10 };
}

// ─── Tier 1: Structural + Rule-Based ───

async function tier1Check(
  pdfBytes: Uint8Array, fileSize: number, classificationResult?: FraudCheckEvent['classificationResult'],
): Promise<TierResult> {
  const signals: string[] = [];
  let score = 0;
  const docType = classificationResult?.documentType || '';
  const confidence = classificationResult?.confidence ?? 1.0;
  const details: Record<string, any> = {};

  if (confidence < 0.7) { signals.push(`Low classification confidence: ${confidence.toFixed(2)}`); score += 0.25; }

  if (isPaystub(docType)) {
    if (fileSize < 1024) { signals.push(`Suspiciously small file for paystub: ${fileSize} bytes`); score += 0.3; }
    else if (fileSize > 10 * 1024 * 1024) { signals.push(`Suspiciously large file for paystub: ${(fileSize / 1024 / 1024).toFixed(1)}MB`); score += 0.2; }
  }

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (e: any) {
    signals.push(`Failed to parse PDF: ${e.message}`);
    return { score: Math.min(score + 0.4, 1.0), signals, details };
  }

  const pageCount = pdfDoc.getPageCount();
  if (isPaystub(docType) && pageCount > 3) { signals.push(`Unusual page count for paystub: ${pageCount} pages`); score += 0.15; }
  if (pageCount === 0) { signals.push('PDF has zero pages'); score += 0.3; }

  const creationDate = pdfDoc.getCreationDate();
  const modDate = pdfDoc.getModificationDate();
  if (creationDate && modDate) {
    const diffMs = modDate.getTime() - creationDate.getTime();
    if (diffMs > 3600000) { signals.push(`PDF modified ${Math.round(diffMs / 3600000)}h after creation`); score += 0.15; }
  }

  const creator = pdfDoc.getCreator() || '';
  const producer = pdfDoc.getProducer() || '';
  if (isSuspiciousCreator(creator)) { signals.push(`Suspicious PDF creator: ${creator}`); score += 0.3; }
  if (isSuspiciousCreator(producer)) { signals.push(`Suspicious PDF producer: ${producer}`); score += 0.3; }

  // Forensic checks
  const fontAnalysis = analyzeFonts(pdfBytes);
  details.fonts = fontAnalysis;
  if (fontAnalysis.totalFonts > 8) { signals.push(`Unusual number of fonts: ${fontAnalysis.totalFonts}`); score += 0.15; }
  if (fontAnalysis.uniqueFamilies > 5) { signals.push(`High font family diversity: ${fontAnalysis.uniqueFamilies} families (possible cut-paste)`); score += 0.15; }
  if (isBusinessDoc(docType) && fontAnalysis.suspiciousFonts.length > 0) { signals.push(`Suspicious fonts for ${docType}: ${fontAnalysis.suspiciousFonts.join(', ')}`); score += 0.25; }
  if (fontAnalysis.totalFonts > 0 && fontAnalysis.embeddingRatio < 0.3) { signals.push(`Low font embedding ratio: ${(fontAnalysis.embeddingRatio * 100).toFixed(0)}% (may indicate manual editing)`); score += 0.1; }

  const imageAnalysis = analyzeImages(pdfBytes);
  details.images = imageAnalysis;
  if (isPaystub(docType) && imageAnalysis.imageCount > 5) { signals.push(`Unusually high image count for paystub: ${imageAnalysis.imageCount}`); score += 0.15; }
  if (imageAnalysis.mixedFormats) { signals.push('Mixed image compression formats (JPEG + Flate) — possible paste from different sources'); score += 0.1; }
  if (imageAnalysis.bitsPerComponentVariation) { signals.push('Varying BitsPerComponent across images — different source quality levels'); score += 0.1; }

  const contentAnalysis = analyzeContentStreams(pdfBytes);
  details.contentStreams = contentAnalysis;
  if (contentAnalysis.hasMultipleContentStreams) { signals.push(`Multiple content stream arrays detected (${contentAnalysis.contentsArrayCount}) — possible overlaid content`); score += 0.15; }

  const annotAnalysis = analyzeAnnotationsAndForms(pdfBytes);
  details.annotations = annotAnalysis;
  if (annotAnalysis.hiddenAnnotations > 0) { signals.push(`Hidden annotations detected: ${annotAnalysis.hiddenAnnotations}`); score += 0.2; }
  if (annotAnalysis.hasAcroForm && isPaystub(docType)) { signals.push('Interactive form fields in paystub (unusual — may indicate template-based forgery)'); score += 0.15; }

  const rawAnalysis = analyzeRawPdfStructure(pdfBytes);
  details.rawStructure = rawAnalysis;
  if (rawAnalysis.incrementalSaves > 0) { signals.push(`PDF has ${rawAnalysis.incrementalSaves} incremental save(s) — document was edited after creation`); score += 0.15 * Math.min(rawAnalysis.incrementalSaves, 3); }
  if (rawAnalysis.hasJavaScript) { signals.push('PDF contains JavaScript — unusual for business documents'); score += 0.2; }

  const redactionAnalysis = detectRedactionArtifacts(pdfBytes);
  details.redaction = redactionAnalysis;
  if (redactionAnalysis.redactionAnnotations > 0) { signals.push(`Redaction annotations found: ${redactionAnalysis.redactionAnnotations}`); score += 0.15; }
  if (redactionAnalysis.filledRectangles > 10) { signals.push(`Excessive filled rectangles (${redactionAnalysis.filledRectangles}) — possible content masking`); score += 0.1; }

  // Sub-scores
  details.metadataScore = Math.min(1, (isSuspiciousCreator(creator) ? 0.3 : 0) + (isSuspiciousCreator(producer) ? 0.3 : 0) + (creationDate && modDate && (modDate.getTime() - creationDate.getTime() > 3600000) ? 0.2 : 0) + (rawAnalysis.incrementalSaves > 0 ? 0.2 : 0));
  details.fontScore = Math.min(1, (fontAnalysis.totalFonts > 8 ? 0.2 : 0) + (fontAnalysis.uniqueFamilies > 5 ? 0.3 : 0) + (fontAnalysis.suspiciousFonts.length > 0 ? 0.3 : 0) + (fontAnalysis.embeddingRatio < 0.3 ? 0.2 : 0));
  details.structuralScore = Math.min(1, (contentAnalysis.hasMultipleContentStreams ? 0.2 : 0) + (annotAnalysis.hiddenAnnotations > 0 ? 0.3 : 0) + (rawAnalysis.hasJavaScript ? 0.2 : 0) + (redactionAnalysis.suspicious ? 0.2 : 0) + (imageAnalysis.mixedFormats ? 0.1 : 0));

  return { score: Math.min(score, 1.0), signals, details };
}

// ─── Tier 2: Enhanced Claude Vision ───

async function tier2Check(
  pdfBytes: Uint8Array, classificationResult?: FraudCheckEvent['classificationResult'],
): Promise<Tier2Result> {
  const signals: string[] = [];
  let score = 0;
  let dimensionScores: Record<string, number> = {};
  const docType = classificationResult?.documentType || 'document';

  try {
    const apiKey = await getAnthropicKey();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: `You are an expert forensic document examiner. Analyze this ${docType} for signs of forgery or manipulation.

Evaluate each dimension on a 0.0-1.0 scale (0=clean, 1=suspicious):

1. text_alignment: Are all text blocks properly aligned, or do some appear shifted/overlaid?
2. font_consistency: Does the font appear uniform, or are there visible changes in weight/style/size in places that should be consistent?
3. background_consistency: Is the background uniform, or are there rectangular areas with slightly different shade/texture (suggesting pasted content)?
4. number_formatting: Are numbers formatted consistently (decimal places, commas, dollar signs)?
5. logo_letterhead: Does the company logo/letterhead appear authentic, or is it low-resolution/distorted/misaligned?
6. edge_artifacts: Are there visible cut/paste edges, halos, or compression artifacts around text blocks?
7. whitespace_patterns: Are margins and spacing consistent throughout the document?
8. standard_elements: For a ${docType}, are all expected sections/fields present and properly formatted?

Respond ONLY in JSON:
{"fraud_probability":0.0-1.0,"dimensions":{"text_alignment":0.0,"font_consistency":0.0,"background_consistency":0.0,"number_formatting":0.0,"logo_letterhead":0.0,"edge_artifacts":0.0,"whitespace_patterns":0.0,"standard_elements":0.0},"top_concerns":["list of specific findings"],"assessment":"one sentence overall assessment"}` },
          ],
        }],
      }),
    });

    if (!response.ok) {
      console.error(`Claude API error: ${response.status}`);
      return { score: 0, signals: ['Tier 2 API call failed'], dimensionScores: {} };
    }

    const result = await response.json() as any;
    const text: string = result.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      score = parsed.fraud_probability || 0;
      dimensionScores = parsed.dimensions || {};
      if (parsed.top_concerns?.length > 0) signals.push(...parsed.top_concerns);
      if (parsed.assessment) signals.push(`AI assessment: ${parsed.assessment}`);
      for (const [dim, val] of Object.entries(dimensionScores)) {
        if ((val as number) >= 0.7) signals.push(`Visual: ${dim.replace(/_/g, ' ')} scored ${(val as number).toFixed(2)} (suspicious)`);
      }
    }
  } catch (e: any) {
    console.error(`Tier 2 error: ${e.message}`);
    signals.push(`Tier 2 analysis error: ${e.message}`);
  }

  return { score, signals, dimensionScores };
}

// ─── Handler ───

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

    const tier1 = await tier1Check(pdfBytes, fileSize, classificationResult);
    console.log(`Tier 1 score: ${tier1.score.toFixed(3)}, signals: ${tier1.signals.length}`);

    let finalScore = tier1.score;
    let allSignals = [...tier1.signals];
    let tier: 'rule-based' | 'ai-assisted' = 'rule-based';
    let visualScore = 0;
    let visualDimensions: Record<string, number> = {};

    if (tier1.score >= 0.25 && tier1.score <= 0.75) {
      console.log('Invoking Tier 2 enhanced Claude vision analysis');
      const tier2 = await tier2Check(pdfBytes, classificationResult);
      visualScore = tier2.score;
      visualDimensions = tier2.dimensionScores || {};
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
        forensics: {
          structuralScore: tier1.details?.structuralScore || 0,
          visualScore,
          metadataScore: tier1.details?.metadataScore || 0,
          fontScore: tier1.details?.fontScore || 0,
          details: {
            fonts: tier1.details?.fonts || {},
            images: tier1.details?.images || {},
            contentStreams: tier1.details?.contentStreams || {},
            annotations: tier1.details?.annotations || {},
            rawStructure: tier1.details?.rawStructure || {},
            redaction: tier1.details?.redaction || {},
            visualDimensions,
          },
        },
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
        forensics: { structuralScore: 0, visualScore: 0, metadataScore: 0, fontScore: 0, details: {} },
        serialFraudLinked: false,
        processingTimeMs,
      },
    };
  }
};
