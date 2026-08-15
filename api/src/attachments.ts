/**
 * Attachment validation — the SINGLE source of truth for which file types and
 * sizes every ingestion path accepts (browser upload AND the email inbox), so
 * the rules can never drift between paths. Pure module (no DB, no imports),
 * mirroring entities.ts: any route or worker can import it.
 *
 * History: allowed-type + size checks used to live only in
 * api/src/routes/documents.ts as inline throws, and the friendly HEIC guard
 * lived only in the web upload UI — so an inbound email carrying one bad
 * attachment (e.g. an iPhone photo) failed the WHOLE request mid-loop and the
 * sender was never told. Everything here is user-safe: reason strings are
 * written for a vendor or insurance agent to read, with no internals (no
 * "API", no tech stack, no model names, no file paths).
 */
export const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png"];
export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const HEIC_EXTENSION_RE = /\.(heic|heif)$/i;

/** True when the file is a HEIC/HEIF image (iPhone camera format) — by MIME
 *  type or filename extension, matching the browser-upload UI guard. */
export function isHeicFile(contentType: string | null | undefined, filename: string | null | undefined): boolean {
  if (contentType && HEIC_MIME_TYPES.has(contentType.toLowerCase())) return true;
  return !!filename && HEIC_EXTENSION_RE.test(filename);
}

/** Human-readable size, e.g. "12.4MB" / "512.0KB". */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export type AttachmentValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validates an incoming attachment (allowed type + size cap). HEIC/HEIF gets
 * its own friendly reason first because iPhone photos of a certificate are the
 * single most common rejected case — the sender needs actionable guidance
 * ("resend as PDF or JPG"), not a raw MIME error.
 */
export function validateAttachment(opts: { filename: string; contentType: string; size: number }): AttachmentValidation {
  if (isHeicFile(opts.contentType, opts.filename)) {
    return { ok: false, reason: "HEIC photo detected — please resend as PDF or JPG" };
  }
  if (!ALLOWED_TYPES.includes(opts.contentType.toLowerCase())) {
    return { ok: false, reason: `unsupported file type: ${opts.contentType || "unknown"}` };
  }
  if (opts.size > MAX_UPLOAD_SIZE) {
    return { ok: false, reason: `file too large: ${formatFileSize(opts.size)} exceeds 10MB cap` };
  }
  return { ok: true };
}
