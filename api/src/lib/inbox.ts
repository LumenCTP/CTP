// ── Per-client inbound mailbox identity ──────────────────
// Each tenant gets a per-company submission address on the platform's mail
// domain using the +subaddress format the ingestion pipeline supports,
// e.g. "ABC Company" →
// cleartopay-compliance-0d8d884b+ABCCompany@ctomail.io.
//
// The slug is the company name with every non-alphanumeric character removed
// (case preserved). The base address is overridable via the INBOX_BASE_ADDRESS
// env var so it can be flipped without a redeploy.
//
// NOTE: this intentionally does NOT use the product domain
// (cleartopayconstruction.com): its MX points at Microsoft 365, where no
// per-company mailboxes exist, so mail to ABCCompany@cleartopayconstruction.com
// would bounce. The +subaddress format routes to the team inbox the platform
// monitors.

const INBOX_BASE_ADDRESS = process.env.INBOX_BASE_ADDRESS || "cleartopay-compliance-0d8d884b@ctomail.io";

/**
 * "ABC Company" → "ABCCompany"; "Acme Builders LLC" → "AcmeBuildersLLC".
 * Trims, removes all non-alphanumeric characters (case preserved), and caps at
 * 60 chars to stay within the RFC 5321 local-part limit (64). Falls back to
 * "company" when nothing remains.
 */
export function companyNameToSlug(name: string): string {
  const slug = (name ?? "").trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 60);
  return slug || "company";
}

/** Renders the tenant's submission inbox address, e.g. "cleartopay-compliance-0d8d884b+ABCCompany@ctomail.io". */
export function buildInboxAddress(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const at = INBOX_BASE_ADDRESS.indexOf("@");
  if (at <= 0) return `${slug}@${INBOX_BASE_ADDRESS}`;
  return `${INBOX_BASE_ADDRESS.slice(0, at)}+${slug}@${INBOX_BASE_ADDRESS.slice(at + 1)}`;
}

/**
 * Extracts the tenant slug from an inbound to_address.
 * Supports the current "cleartopay-compliance-0d8d884b+<slug>@ctomail.io"
 * +subaddress format, and keeps parsing a bare "<Slug>@<domain>" so nothing
 * that used the old format stops routing.
 */
export function slugFromToAddress(toAddress: string): string {
  const local = (toAddress || "").split("@")[0] || "";
  if (local.includes("+")) return local.slice(local.lastIndexOf("+") + 1);
  return local;
}
