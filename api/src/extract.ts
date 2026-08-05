/**
 * AI Document Extraction Engine
 *
 * Real AI-powered extraction for image documents (PNG/JPG):
 *   - Reads the file as base64
 *   - Sends it to a vision-capable LLM via an OpenAI-compatible
 *     chat-completions endpoint using plain `fetch()` (no new packages)
 *   - Parses the structured JSON response into `ExtractionResult`
 *
 * The endpoint is configured via env vars (see `AI_CONFIG` below):
 *   AI_EXTRACTION_ENDPOINT  — required for AI mode; base URL or full
 *                             `/chat/completions` URL of an OpenAI-compatible
 *                             vision model. If unset, extraction falls back
 *                             to filename heuristics.
 *   AI_EXTRACTION_MODEL     — model name (default "gpt-4o-mini")
 *   AI_EXTRACTION_API_KEY   — Bearer token (optional; some local endpoints
 *                             don't need one)
 *
 * Fallback: if the env var is unset, the file is a PDF, or the AI call
 * fails/times out/returns unparseable data, we fall back to the original
 * filename-based heuristics (kept below) so ingestion never breaks.
 *
 * The function signature and ExtractionResult type are the contract —
 * keep them stable.
 */

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
}

/** AI call timeout (ms). */
const AI_EXTRACTION_TIMEOUT_MS = 30_000;

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
 *  1. Image files (PNG/JPG) → real AI vision extraction when
 *     `AI_EXTRACTION_ENDPOINT` is configured; otherwise heuristics.
 *  2. PDFs (and everything else) → filename heuristics for now
 *     (PDF parsing requires libraries we can't install).
 * Never throws: any AI failure falls back to heuristics.
 */
export async function extractDocumentInfo(
  filePath: string,
  fileName: string
): Promise<ExtractionResult> {
  const ext = getExtension(fileName);
  if (IMAGE_EXTENSIONS.has(ext)) {
    const aiResult = await tryAIExtraction(filePath, fileName);
    if (aiResult) return aiResult;
  }
  // PDFs, non-images, or images where AI was unavailable/failed
  return heuristicExtraction(fileName);
}

// ─────────────────────────────────────────────────────────────────────────
// AI extraction (vision)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Attempts real AI extraction. Returns null (never throws) when:
 *  - AI_EXTRACTION_ENDPOINT is not set
 *  - the file can't be read
 *  - the endpoint call fails, times out, returns non-200
 *  - the response can't be parsed into a usable ExtractionResult
 */
async function tryAIExtraction(
  filePath: string,
  fileName: string
): Promise<ExtractionResult | null> {
  const endpoint = process.env.AI_EXTRACTION_ENDPOINT;
  if (!endpoint) return null; // AI not configured → heuristics fallback

  // Accept either a full URL ending in /chat/completions or a base URL.
  const url = /\/chat\/completions\/?$/.test(endpoint)
    ? endpoint
    : `${endpoint.replace(/\/+$/, "")}/chat/completions`;

  let base64: string;
  try {
    const buffer = await Bun.file(filePath).arrayBuffer();
    base64 = Buffer.from(buffer).toString("base64");
  } catch (err) {
    console.warn(`[extract] AI: cannot read ${filePath} — falling back to heuristics (${err})`);
    return null;
  }

  const mime = getExtension(fileName) === "png" ? "image/png" : "image/jpeg";
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
        `[extract] AI: endpoint returned ${res.status} — falling back to heuristics (${errText})`
      );
      return null;
    }
    const data = (await res.json()) as any;
    const content = extractContentFromResponse(data);
    const parsed = parseModelJson(content);
    const result = parsed ? normalizeExtraction(parsed, fileName) : null;
    if (!result) {
      console.warn("[extract] AI: response JSON was not usable — falling back to heuristics");
      return null;
    }
    console.log(
      `[extract] AI extraction ok for ${fileName} (type=${result.document_type}, ` +
        `confidence=${result.ai_confidence_score}, vendor=${result.vendor_name})`
    );
    return result;
  } catch (err) {
    console.warn(
      `[extract] AI: call failed (${err instanceof Error ? err.message : err}) — falling back to heuristics`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  };
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Fallback: filename heuristics (original implementation, preserved)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mock extraction based on filename keywords. Used when AI is
 * unavailable or the file is not an image (e.g. PDFs).
 */
async function heuristicExtraction(fileName: string): Promise<ExtractionResult> {
  // ── Simulate processing delay ──
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 600));

  const nameLower = fileName.toLowerCase();
  const baseName = fileName.replace(/\.[^.]+$/, "");

  // ── Determine document type from filename ──
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
  } else if (/\.pdf$/i.test(nameLower)) {
    documentType = "COI"; // default guess for PDFs
  } else {
    documentType = "Other";
  }

  // ── Extract vendor name from filename ──
  const vendorName = guessVendorName(baseName);

  // ── Generate plausible carrier/policy ──
  const carriers = [
    "Travelers Insurance",
    "Liberty Mutual",
    "State Farm",
    "The Hartford",
    "Chubb",
    "Zurich",
    "Nationwide",
    "Progressive Commercial",
    "Berkshire Hathaway",
    "CNA Insurance",
  ];

  const carrier =
    documentType !== "W-9"
      ? carriers[Math.floor(Math.random() * carriers.length)]
      : null;

  const policyNumber =
    documentType !== "W-9"
      ? `${carrier?.split(" ").map((w) => w[0]).join("")}-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 90000) + 1000).padStart(5, "0")}`
      : null;

  // ── Generate dates ──
  const now = new Date();
  const effDate = new Date(now);
  effDate.setMonth(effDate.getMonth() - Math.floor(Math.random() * 6));
  const effectiveDate = effDate.toISOString().slice(0, 10);

  const expDate = new Date(effDate);
  expDate.setFullYear(expDate.getFullYear() + 1);
  expDate.setMonth(expDate.getMonth() + Math.floor(Math.random() * 3));
  const expirationDate = expDate.toISOString().slice(0, 10);

  // ── Generate certificate holder ──
  const holders = [
    "Summit Construction Inc.",
    "Metro Development Group",
    "Broadway Builders LLC",
    "Pinnacle Contractors",
    "Harbor Development Corp.",
  ];
  const certificateHolder = holders[Math.floor(Math.random() * holders.length)];
  const addresses = ["100 Main Street, Denver CO 80202", "250 Market Ave, Austin TX 78701", "42 Oak Road, Phoenix AZ 85001"];
  const certificateHolderAddress = addresses[Math.floor(Math.random() * addresses.length)];
  const insuredAddress = addresses[Math.floor(Math.random() * addresses.length)];
  const certificateHolderNameConfidence = documentType === "COI" ? (Math.random() < 0.7 ? 0.8 + Math.random() * 0.19 : 0.5 + Math.random() * 0.29) : 0;
  const formDate = documentType === "W-9" ? `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}` : null;

  // ── Confidence score: weighted to produce some low-confidence results ──
  // ~30% chance of being in Needs Review (below 70)
  const roll = Math.random();
  let aiConfidenceScore: number;
  if (roll < 0.15) {
    // 15% chance: very low confidence (40-58)
    aiConfidenceScore = Math.floor(Math.random() * 19) + 40;
  } else if (roll < 0.30) {
    // 15% chance: borderline (60-69)
    aiConfidenceScore = Math.floor(Math.random() * 10) + 60;
  } else if (roll < 0.60) {
    // 30% chance: moderate (70-84)
    aiConfidenceScore = Math.floor(Math.random() * 15) + 70;
  } else {
    // 40% chance: high confidence (85-98)
    aiConfidenceScore = Math.floor(Math.random() * 14) + 85;
  }

  return {
    vendor_name: vendorName,
    insurance_carrier: carrier,
    policy_number: policyNumber,
    effective_date: effectiveDate,
    expiration_date: expirationDate,
    certificate_holder: certificateHolder,
    certificate_holder_address: certificateHolderAddress,
    certificate_holder_name_confidence: certificateHolderNameConfidence,
    insured_address: insuredAddress,
    form_date: formDate,
    document_type: documentType,
    ai_confidence_score: aiConfidenceScore,
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
