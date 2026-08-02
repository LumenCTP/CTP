/**
 * AI Document Extraction Engine
 *
 * Placeholder implementation that returns plausible mock data
 * based on filename heuristics. Designed with a clean interface
 * so we can swap in a real LLM-based extractor later.
 *
 * The function signature and ExtractionResult type are the contract —
 * keep them stable when replacing the implementation.
 */

export interface ExtractionResult {
  vendor_name: string | null;
  insurance_carrier: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  certificate_holder: string | null;
  document_type: string | null;
  ai_confidence_score: number;
}

/**
 * Extracts compliance-related fields from a document.
 *
 * Current implementation: mock extraction based on filename heuristics.
 * Future: replace body with an LLM API call (GPT-4V, Claude, etc.)
 * while keeping the same function signature.
 */
export async function extractDocumentInfo(
  filePath: string,
  fileName: string
): Promise<ExtractionResult> {
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
    document_type: documentType,
    ai_confidence_score: aiConfidenceScore,
  };
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
