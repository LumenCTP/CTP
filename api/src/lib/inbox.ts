// ── Per-client inbound mailbox identity ──────────────────
// Each tenant gets a clean per-company submission address on the product
// domain, e.g. "ABC Company" → ABCCompany@cleartopayconstruction.com.
//
// The slug is the company name with every non-alphanumeric character removed
// (case preserved). The domain is overridable via the INBOX_DOMAIN env var so
// it can be flipped without a redeploy.

const INBOX_DOMAIN = process.env.INBOX_DOMAIN || "cleartopayconstruction.com";

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

/** Renders the tenant's submission inbox address, e.g. "ABCCompany@cleartopayconstruction.com". */
export function buildInboxAddress(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return `${slug}@${INBOX_DOMAIN}`;
}

/**
 * Extracts the tenant slug from an inbound to_address.
 * Supports the current "<Slug>@<domain>" format AND the legacy
 * "cleartopay-compliance-0d8d884b+<slug>@ctomail.io" +subaddress format, so
 * old inboxes keep routing until the domain cutover.
 */
export function slugFromToAddress(toAddress: string): string {
  const local = (toAddress || "").split("@")[0] || "";
  if (local.includes("+")) return local.slice(local.lastIndexOf("+") + 1);
  return local;
}
