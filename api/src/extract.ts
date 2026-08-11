/**
 * AI Document Extraction Engine
 *
 * Real AI-powered extraction for document files:
 *   - Images (PNG/JPG): the file is read as base64 and sent to a vision-capable
 *     LLM via an OpenAI-compatible chat-completions endpoint using plain
 *     `fetch()`.
 *   - PDFs: the first 1-2 pages are rendered to PNG (see pdf-render.ts) and
 *     each page image is sent through the exact same vision path; results are
 *     merged into one ExtractionResult.
 *
 * The endpoint is configured via env vars (see `AI_CONFIG` below):
 *   AI_EXTRACTION_ENDPOINT  — required for AI mode; base URL or full
 *                             `/chat/completions` URL of an OpenAI-compatible
 *                             vision model.
 *   AI_EXTRACTION_MODEL     — model name (default "gpt-4o-mini")
 *   AI_EXTRACTION_API_KEY   — Bearer token (optional; some local endpoints
 *                             don't need one)
 *
 * HONEST FALLBACK (extraction_method === 'filename'):
 * When AI is not configured, fails, times out, returns unusable data, or a PDF
 * cannot be rendered, we return ONLY what can be safely derived from the
 * filename: the document type (keyword match) and a best-effort vendor name.
 * EVERY other field is null, confidences are 0, and the caller leaves
 * is_reviewed = 0 so the document lands in the Needs Review queue.
 *
 * We NEVER invent carriers, policy numbers, effective/expiration dates,
 * certificate holders, addresses, or confidence scores. A document marked
 * "needs review" is always preferable to fabricated compliance data — the
 * product's core promise is knowing who is actually safe to pay.
 *
 * The function signature and ExtractionResult type are the contract — keep
 * them stable.
 */

import { renderPdfPagesFromBuffer, renderPdfPagesToPngs } from "./pdf-render";

export interface ExtractionResult {
  vendor_name: string | null;
  insurance_carrier: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  certificate_holder: string | null;
  certificate_holder_address: string | null;
  certificate_holder_name_confidence: number;
  insured_address: string | null;
  form_date: string | null;
  document_type: string | null;
  ai_confidence_score: number;
  /**
   * How this extraction was produced:
   *  - "ai"        — real vision-model extraction (image or rendered PDF page)
   *  - "filename"  — honest filename-only fallback (no fabricated fields)
   */
  extraction_method: "ai" | "filename";
}

/** AI call timeout (ms). */
const AI_EXTRACTION_TIMEOUT_MS = 30_000;

/** Max PDF pages rendered and sent to the vision model (cost control). */
const MAX_PDF_PAGES = 2;

/**
 * Canonical document types used across the rest of the system
 * (see shared/types.ts ALL_DOCUMENT_TYPES). The model is asked to use
 * these exact values; aliases are normalized to them on parse.
 */
const CANONICAL_DOCUMENT_TYPES = [
  "COI",
  "W-9",
  "General Liability",
  "Workers Comp",
  "Commercial Auto",
  "Umbrella",
  "Business License",
  "Other",
] as const;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);

/**
 * Extracts compliance-related fields from a document.
 *
 * Strategy:
 *  1. PDFs → render first 1-2 pages to PNG, run real AI vision extraction on
 *     each page, merge the results. If rendering or AI fails → honest fallback.
 *  2. Images (PNG/JPG) → real AI vision extraction when
 *     `AI_EXTRACTION_ENDPOINT` is configured; otherwise honest fallback.
 *  3. Everything else → honest filename fallback.
 * Never throws and never fabricates data.
 */
export async function extractDocumentInfo(
  filePath: string,
  fileName: string,
): Promise<ExtractionResult> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await Bun.file(filePath).arrayBuffer());
  } catch (err) {
    console.warn(`[extract] cannot read ${filePath} — honest fallback (${err})`);
    return honestFallback(fileName);
  }
  return extractDocumentInfoFromBytes(data, fileName);
}

/**
 * Same as extractDocumentInfo but takes the document bytes directly — used
 * when the file lives in object storage (R2) rather than on local disk.
 * Never throws and never fabricates data.
 */
export async function extractDocumentInfoFromBytes(
  fileData: Uint8Array | Buffer,
  fileName: string,
): Promise<ExtractionResult> {
  const data = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
  const ext = getExtension(fileName);
  if (ext === "pdf") {
    const pages = await renderPdfPagesFromBuffer(data, MAX_PDF_PAGES);
    if (pages.length > 0) {
      const results: ExtractionResult[] = [];
      for (const png of pages) {
        const r = await tryVisionOnImage(png, "image/png", fileName);
        if (r) results.push(r);
      }
      const merged = mergeResults(results);
      if (merged) {
        console.log(
          `[extract] AI extraction ok for PDF ${fileName} (${pages.length} page(s), ` +
            `type=${merged.document_type}, confidence=${merged.ai_confidence_score}, vendor=${merged.vendor_name})`,
        );
        return merged;
      }
    }
    console.warn(`[extract] PDF ${fileName} — no usable AI result, using honest filename fallback`);
    return honestFallback(fileName);
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    const aiResult = await tryAIExtractionFromBytes(data, fileName);
    if (aiResult) return aiResult;
  }
  // Non-images, or images where AI was unavailable/failed
  return honestFallback(fileName);
}

// ─────────────────────────────────────────────────────────────────────────
// AI extraction (vision)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Attempts real AI extraction on an image file. Returns null (never throws)
 * when AI is not configured, the file can't be read, the endpoint call fails,
 * times out, returns non-200, or the response can't be parsed.
 */
async function tryAIExtraction(
  filePath: string,
  fileName: string,
): Promise<ExtractionResult | null> {
  if (!process.env.AI_EXTRACTION_ENDPOINT) return null; // AI not configured

  let buffer: ArrayBuffer;
  try {
    buffer = await Bun.file(filePath).arrayBuffer();
  } catch (err) {
    console.warn(`[extract] AI: cannot read ${filePath} — honest fallback (${err})`);
    return null;
  }
  return tryAIExtractionFromBytes(new Uint8Array(buffer), fileName);
}

/**
 * Attempts real AI extraction on image bytes (used when the file lives in
 * object storage rather than on local disk). Returns null (never throws)
 * under the same conditions as tryAIExtraction.
 */
async function tryAIExtractionFromBytes(
  data: Uint8Array | Buffer,
  fileName: string,
): Promise<ExtractionResult | null> {
  if (!process.env.AI_EXTRACTION_ENDPOINT) return null; // AI not configured
  const base64 = Buffer.from(data).toString("base64");
  const mime = getExtension(fileName) === "png" ? "image/png" : "image/jpeg";
  return callVisionAI(base64, mime, fileName);
}

/**
 * Attempts real AI extraction on an in-memory image (e.g. a rendered PDF page).
 * Returns null (never throws) under the same conditions as tryAIExtraction.
 */
async function tryVisionOnImage(
  imageBytes: Uint8Array | Buffer,
  mime: string,
  fileName: string,
): Promise<ExtractionResult | null> {
  if (!process.env.AI_EXTRACTION_ENDPOINT) return null; // AI not configured
  const base64 = Buffer.from(imageBytes).toString("base64");
  return callVisionAI(base64, mime, fileName);
}

/** Shared vision-model call for any base64 image payload. */
async function callVisionAI(
  base64: string,
  mime: string,
  fileName: string,
): Promise<ExtractionResult | null> {
  const endpoint = process.env.AI_EXTRACTION_ENDPOINT;
  if (!endpoint) return null;

  // Accept either a full URL ending in /chat/completions or a base URL.
  const url = /\/chat\/completions\/?$/.test(endpoint)
    ? endpoint
    : `${endpoint.replace(/\/+$/, "")}/chat/completions`;

  const dataUrl = `data:${mime};base64,${base64}`;

  const body = {
    model: process.env.AI_EXTRACTION_MODEL || "gpt-4o-mini",
    temperature: 0,
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a document extraction engine for a construction compliance platform. " +
          "You analyze compliance documents: Certificates of Insurance (COI), W-9 tax forms, " +
          "and insurance certificates (general liability, workers compensation, commercial auto, umbrella). " +
          "Extract the requested fields from the document image. " +
          "If a field is not visible or illegible, return null for it — never guess or invent values. " +
          'Return ONLY valid JSON with no commentary and no markdown, matching this schema exactly: ' +
          JSON.stringify({
            document_type:
              '"COI" | "W-9" | "General Liability" | "Workers Comp" | "Commercial Auto" | "Umbrella" | "Business License" | "Other"',
            vendor_name: "string or null — the business/insured named on the document",
            insurance_carrier: "string or null",
            policy_number: "string or null",
            effective_date: '"YYYY-MM-DD" or null',
            expiration_date: '"YYYY-MM-DD" or null',
            certificate_holder: "string or null",
            certificate_holder_address: "string or null",
            insured_address: "string or null",
            form_date: '"YYYY-MM-DD" or null (only for W-9 forms)',
            ai_confidence_score: "number 0.0 to 1.0 — overall confidence in this extraction",
            certificate_holder_name_confidence:
              "number 0.0 to 1.0 — 0 when certificate_holder is null",
          }),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Extract compliance data from this document (original filename: " +
              fileName +
              "). Return the JSON object described by the system prompt. " +
              "Convert all dates to YYYY-MM-DD. Use null for anything absent or illegible.",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.AI_EXTRACTION_API_KEY;
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_EXTRACTION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      console.warn(
        `[extract] AI: endpoint returned ${res.status} — honest fallback (${errText})`
      );
      return null;
    }
    const data = (await res.json()) as any;
    const content = extractContentFromResponse(data);
    const parsed = parseModelJson(content);
    const result = parsed ? normalizeExtraction(parsed, fileName) : null;
    if (!result) {
      console.warn("[extract] AI: response JSON was not usable — honest fallback");
      return null;
    }
    console.log(
      `[extract] AI extraction ok for ${fileName} (type=${result.document_type}, ` +
        `confidence=${result.ai_confidence_score}, vendor=${result.vendor_name})`
    );
    return result;
  } catch (err) {
    console.warn(
      `[extract] AI: call failed (${err instanceof Error ? err.message : err}) — honest fallback`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merges per-page extraction results into a single document result.
 * Fields from earlier pages win; null fields are filled from later pages.
 * Confidence is the maximum across pages (best evidence for the document).
 */
function mergeResults(results: ExtractionResult[]): ExtractionResult | null {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];
  const merged: ExtractionResult = { ...results[0] };
  for (const r of results.slice(1)) {
    for (const key of Object.keys(merged) as (keyof ExtractionResult)[]) {
      if (key === "extraction_method") continue;
      const val = merged[key] as unknown;
      if (val === null || val === undefined) {
        const other = r[key] as unknown;
        if (other !== null && other !== undefined) {
          (merged as any)[key] = other;
        }
      }
    }
    // Overall confidence: strongest page wins.
    merged.ai_confidence_score = Math.max(merged.ai_confidence_score, r.ai_confidence_score);
    // Holder confidence follows whichever page actually supplied the holder.
    if (!merged.certificate_holder && r.certificate_holder) {
      merged.certificate_holder_name_confidence = r.certificate_holder_name_confidence;
    }
  }
  return merged;
}

/** Pulls the assistant text out of an OpenAI-compatible response. */
function extractContentFromResponse(data: any): string | null {
  try {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      // Some providers return content as parts
      return content
        .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
        .join("");
    }
    return null;
  } catch {
    return null;
  }
}

/** Robustly parses model output (may include markdown fences or prose). */
function parseModelJson(content: string | null): any | null {
  if (!content) return null;
  let c = content.trim();
  // Strip markdown code fences
  c = c.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(c);
  } catch {
    /* fall through to substring extraction */
  }
  const start = c.indexOf("{");
  const end = c.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** Maps/validates the model's document_type onto canonical values. */
function normalizeDocumentType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "coi" || key === "certificateofinsurance" || key === "certificateofinsurancecoi") return "COI";
  if (key === "w9" || key === "w9form" || key === "w-9") return "W-9";
  if (key === "generalliability" || key === "gl" || key === "generalliabilityinsurance") return "General Liability";
  if (key === "workerscomp" || key === "workerscompensation" || key === "wc" || key === "workcomp") return "Workers Comp";
  if (key === "commercialauto" || key === "autoliability" || key === "commercialautoliability" || key === "auto" || key === "businessauto") return "Commercial Auto";
  if (key === "umbrella" || key === "excessumbrella" || key === "umbrellaliability") return "Umbrella";
  if (key === "businesslicense" || key === "businesslic" || key === "license") return "Business License";
  if (key === "other" || key === "unknown") return "Other";
  // Model returned a canonical value with odd casing/spacing
  const match = CANONICAL_DOCUMENT_TYPES.find(
    (t) => t.toLowerCase().replace(/[^a-z0-9]/g, "") === key
  );
  return match ?? "Other";
}

/** Normalizes common date formats to YYYY-MM-DD. Returns null if unparseable. */
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const s = value.trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return null;
  }
  // YYYY/MM/DD
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("/").map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return null;
  }
  // MM/DD/YYYY or MM-DD-YYYY (US convention used on insurance docs)
  const us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (us) {
    const [, m, d, y] = us.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return null;
  }
  // Month DD, YYYY
  const long = s.match(/^([A-Za-z]+)[\s,]+(\d{1,2})[,]?\s+(\d{4})$/);
  if (long) {
    const months: Record<string, number> = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    };
    const monthNum = months[long[1].toLowerCase()];
    if (monthNum) {
      const d = Number(long[2]);
      if (d >= 1 && d <= 31) return `${long[3]}-${String(monthNum).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }
  // Last resort: Date.parse
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const dt = new Date(t);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s.length ? s : null;
}

function clampConfidence(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Maps parsed model JSON onto the ExtractionResult contract. */
function normalizeExtraction(raw: any, fileName: string): ExtractionResult | null {
  if (!raw || typeof raw !== "object") return null;

  const documentType = normalizeDocumentType(raw.document_type);
  const confidence = clampConfidence(raw.ai_confidence_score, 0.5);
  const holder = cleanString(raw.certificate_holder);

  // If the model returned nothing at all, treat as failed extraction
  const anyValue =
    documentType !== "Other" ||
    !!holder ||
    !!cleanString(raw.vendor_name) ||
    !!cleanString(raw.policy_number) ||
    !!normalizeDate(raw.expiration_date);
  if (!anyValue) return null;

  const result: ExtractionResult = {
    vendor_name: cleanString(raw.vendor_name) ?? guessVendorName(fileName.replace(/\.[^.]+$/, "")),
    insurance_carrier: cleanString(raw.insurance_carrier),
    policy_number: cleanString(raw.policy_number),
    effective_date: normalizeDate(raw.effective_date),
    expiration_date: normalizeDate(raw.expiration_date),
    certificate_holder: holder,
    certificate_holder_address: cleanString(raw.certificate_holder_address),
    certificate_holder_name_confidence: holder
      ? Math.min(clampConfidence(raw.certificate_holder_name_confidence, confidence), 0.98)
      : 0,
    insured_address: cleanString(raw.insured_address),
    form_date: normalizeDate(raw.form_date),
    document_type: documentType,
    ai_confidence_score: confidence,
    extraction_method: "ai",
  };
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Honest fallback: filename-only heuristics (NO fabricated data)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns ONLY what can be safely derived from the filename:
 *   - document_type, guessed from filename keywords (never a blind default)
 *   - vendor_name, guessed from the filename
 * Everything else is null and both confidences are 0. The caller leaves
 * is_reviewed = 0, so the document shows up in the Needs Review queue and
 * never drives compliance statuses with invented values.
 */
function honestFallback(fileName: string): ExtractionResult {
  const nameLower = fileName.toLowerCase();

  // ── Determine document type from filename keywords only ──
  let documentType: string | null = null;
  if (/coi|certificate\s*of\s*insurance/i.test(nameLower)) {
    documentType = "COI";
  } else if (/w-?9|w9/i.test(nameLower)) {
    documentType = "W-9";
  } else if (/workers?\s*comp|wc/i.test(nameLower)) {
    documentType = "Workers Comp";
  } else if (/commercial\s*auto|auto\s*liability/i.test(nameLower)) {
    documentType = "Commercial Auto";
  } else if (/general\s*liability|gl/i.test(nameLower)) {
    documentType = "General Liability";
  } else if (/umbrella/i.test(nameLower)) {
    documentType = "Umbrella";
  } else if (/business\s*lic|bl/i.test(nameLower)) {
    documentType = "Business License";
  } else {
    // Unknown — do NOT guess "COI" for PDFs. An honest "Other" (→ needs review)
    // is better than mislabeling a W-9 or a license as a certificate of insurance.
    documentType = "Other";
  }

  // ── Extract vendor name from filename ──
  const vendorName = guessVendorName(fileName.replace(/\.[^.]+$/, ""));

  return {
    vendor_name: vendorName,
    insurance_carrier: null,
    policy_number: null,
    effective_date: null,
    expiration_date: null,
    certificate_holder: null,
    certificate_holder_address: null,
    certificate_holder_name_confidence: 0,
    insured_address: null,
    form_date: null,
    document_type: documentType,
    ai_confidence_score: 0,
    extraction_method: "filename",
  };
}

function getExtension(fileName: string): string {
  const m = fileName.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Guess a vendor name from the filename by splitting on
 * separators and returning the most plausible chunk.
 */
function guessVendorName(baseName: string): string | null {
  // Common filename separators
  const parts = baseName.split(/[_\-.\s]+/).filter(Boolean);

  if (parts.length === 0) return null;

  // Look for the longest word-like chunk (likely a name)
  const wordParts = parts.filter((p) => /^[A-Za-z]{3,}/.test(p));
  if (wordParts.length === 0) return null;

  // Combine parts that look like a company name
  const vendorWords: string[] = [];
  for (const p of parts) {
    if (/^(coi|w9|wc|insurance|certificate|policy|\d{4}|\d{2})$/i.test(p)) {
      break; // stop at known non-name tokens
    }
    if (/^[A-Za-z]+$/.test(p)) {
      vendorWords.push(p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
    }
  }

  if (vendorWords.length === 0) return null;

  // Add common suffixes if plausible
  const last = vendorWords[vendorWords.length - 1].toLowerCase();
  const businessSuffixes = ["inc", "co", "llc", "corp", "ltd", "services", "solutions", "group"];
  if (!businessSuffixes.includes(last) && vendorWords.length === 1) {
    vendorWords.push("Services");
  }

  return vendorWords.join(" ");
}
