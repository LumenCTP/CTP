/**
 * Entity name normalization and dedup-key generation — the SINGLE source of
 * truth for how vendor/client names become dedup keys, used by every creation
 * path (CSV import, manual add, AI-extraction auto-create, seed, backfill).
 *
 * History: the dedup key used to live only in mapping.ts and required BOTH a
 * name and an address, so CSV-imported / manually-added vendors (which have no
 * address) were written with normalized_key = NULL and the unique index never
 * applied to them. Everything here is pure — no DB, no imports — so db.ts can
 * use it for the startup backfill without circular imports.
 */

/** Lowercase, trimmed, whitespace-collapsed, punctuation-stripped name. */
export function normalize(s: string | null): string | null {
  if (s === null) return null;
  const value = s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,'\"]/g, "").replace(/[^a-z0-9 ]/g, "");
  return value || null;
}

/**
 * Dedup key: normalized NAME is required; normalized address is a TIE-BREAKER,
 * not a requirement. A vendor entered without an address still gets a
 * name-only key, so the unique index (client_id, normalized_key) can dedupe it
 * against other address-less rows and against AI-extracted documents that only
 * carry a name.
 */
export function entityKey(name: string | null, address: string | null): string | null {
  const n = normalize(name);
  if (!n) return null;
  const a = normalize(address);
  return a ? `${n}::${a}` : n;
}

/** Trailing legal-entity words, matched against ALREADY-normalized text
 *  (normalize() removes periods, so "P.C." arrives as "pc"). */
const LEGAL_SUFFIX_RE = /\b(llc|llp|pllc|ltd|limited|inc|incorporated|corp|corporation|co|company|pc|pa)$/;

/**
 * Suffix-tolerant normalized name used ONLY by the possible-duplicate guard
 * ("ABC Roofing" ≈ "ABC Roofing, LLC" ≈ "ABC Roofing, Inc."). The stored
 * normalized_key keeps the exact normalize() output; this looser comparison
 * only decides whether a NEW vendor row may be created when a same-name vendor
 * already exists under the client.
 */
export function normalizedNameForDedup(name: string | null): string | null {
  const n = normalize(name);
  if (!n) return null;
  const stripped = n.replace(LEGAL_SUFFIX_RE, "").replace(/\s+/g, " ").trim();
  return stripped || n;
}
