# Fraud Check Lambda — Deep PDF Forensics

**Deployed:** 2026-03-06 | **Lambda:** `idp-fraud-check` | **Memory:** 512MB | **Timeout:** 60s

## Architecture

Two-tier fraud detection with deep PDF structural analysis:

### Tier 1: Structural + Rule-Based (always runs)

Original checks (preserved):
- Classification confidence threshold
- File size anomalies (per document type)
- Page count validation
- Metadata date discrepancies (creation vs modification)
- Creator/Producer tool detection (Photoshop, GIMP, etc.)

**New forensic checks:**

| Check | What it detects | Score impact |
|-------|----------------|-------------|
| **Font fingerprinting** | Font count, family diversity, embedding ratio, suspicious fonts (Comic Sans on paystub) | 0.1–0.25 |
| **Image analysis** | Mixed compression formats (JPEG+Flate), BitsPerComponent variation, excessive images | 0.1–0.15 |
| **Content stream layers** | Multiple `/Contents` arrays per page (overlaid/edited content) | 0.15 |
| **Annotation/form detection** | Hidden annotations, AcroForm on paystubs, widget counts | 0.15–0.2 |
| **Incremental save detection** | Multiple `%%EOF` markers indicating post-creation edits | 0.15× saves |
| **JavaScript detection** | `/JS` or `/JavaScript` entries (unusual for business docs) | 0.2 |
| **Redaction artifacts** | `/Subtype /Redact` annotations, excessive filled rectangles | 0.1–0.15 |

### Tier 2: Enhanced Claude Vision (runs when Tier 1 score 0.25–0.75)

Upgraded from generic prompt to 8-dimension forensic analysis:
- Text alignment, font consistency, background consistency
- Number formatting, logo/letterhead authenticity
- Edge artifacts (cut/paste halos), whitespace patterns
- Standard elements for document type

Each dimension scored 0.0–1.0. Dimensions ≥0.7 flagged individually.

### Scoring

- **Tier 1 only:** score = structural score (capped at 1.0)
- **Blended:** 40% structural + 60% visual
- **Flagged threshold:** > 0.6

## Output Format

```json
{
  "fraudResult": {
    "flagged": true,
    "score": 0.72,
    "signals": ["..."],
    "tier": "ai-assisted",
    "forensics": {
      "structuralScore": 0.4,
      "visualScore": 0.65,
      "metadataScore": 0.3,
      "fontScore": 0.5,
      "details": {
        "fonts": { "totalFonts": 12, "uniqueFamilies": 6, "embeddingRatio": 0.25, ... },
        "images": { "imageCount": 3, "mixedFormats": true, ... },
        "contentStreams": { "contentsArrayCount": 2, ... },
        "annotations": { "hiddenAnnotations": 1, ... },
        "rawStructure": { "incrementalSaves": 2, "hasJavaScript": false },
        "redaction": { "filledRectangles": 3, ... },
        "visualDimensions": { "text_alignment": 0.1, "font_consistency": 0.8, ... }
      }
    },
    "serialFraudLinked": false,
    "processingTimeMs": 4200
  }
}
```

## Files

- **Deployed JS:** `/tmp/idp-lambdas/fraud-check/index.js`
- **TS source:** `/tmp/IDP/packages/dss-core/src/lambdas/fraud-check/index.ts`
- **Build dir:** `/tmp/qc-build/`
- **Dependencies:** `pdf-lib` (structural), Anthropic API via Secrets Manager (visual)
