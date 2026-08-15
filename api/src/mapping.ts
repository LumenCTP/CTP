import type { Database } from "bun:sqlite";
import { applyDefaultRequiredDocs } from "./db";
import { normalize, entityKey, normalizedNameForDedup } from "./entities";

// Re-export for backward compatibility with any importer of the old API.
export { normalize, entityKey };

export interface VendorMatchResult {
  /** Resolved vendor id (existing, matched-by-name, or newly created), or null when no key could be built. */
  vendorId: number | null;
  /** True when this call INSERTED a new vendor row. */
  created: boolean;
  /**
   * True when the vendor name normalized-name-matches an existing vendor under
   * the same client but the addresses differ/are absent. The caller MUST NOT
   * treat this as a clean creation — attach the document to the existing
   * vendor (vendorId) and leave it in the needs-review surface (is_reviewed=0)
   * so a human confirms before it drives compliance.
   */
  possibleDuplicate: boolean;
}

/**
 * Find an existing vendor under the same client whose normalized name
 * (suffix-tolerant: "ABC Roofing" ≈ "ABC Roofing, LLC") matches the candidate.
 * Address is deliberately ignored — this is the guard against creating ghost
 * duplicate vendors from AI-extracted documents. Linear scan is fine at this
 * scale (tens-hundreds of vendors per client, once per extracted document).
 */
export function findPossibleDuplicateVendor(db: Database, clientId: number, vendorName: string | null): { id: number; name: string } | null {
  const dedupName = normalizedNameForDedup(vendorName);
  if (!dedupName) return null;
  const rows = db.query("SELECT id, name FROM vendors WHERE client_id = $cid").all({ $cid: clientId }) as Array<{ id: number; name: string }>;
  for (const r of rows) {
    if (normalizedNameForDedup(r.name) === dedupName) return r;
  }
  return null;
}

export function matchOrCreateClient(db: Database, tenantId: number, holderName: string | null, holderAddress: string | null): number | null {
  const key = entityKey(holderName, holderAddress);
  if (!key) return null;
  const found = db.query("SELECT id FROM clients WHERE tenant_id=$tid AND normalized_key=$key").get({ $tid: tenantId, $key: key }) as { id: number } | null;
  if (found) return found.id;
  const result = db.query("INSERT INTO clients (name,address,normalized_key,tenant_id) VALUES ($name,$address,$key,$tid)").run({ $name: holderName, $address: holderAddress, $key: key, $tid: tenantId });
  const clientId = Number(result.lastInsertRowid);
  // Auto-discovered clients start with the standard default requirement set.
  applyDefaultRequiredDocs(db, clientId);
  return clientId;
}

export function matchOrCreateVendor(db: Database, clientId: number, vendorName: string | null, vendorAddress: string | null): VendorMatchResult {
  const key = entityKey(vendorName, vendorAddress);
  if (!key) return { vendorId: null, created: false, possibleDuplicate: false };
  const found = db.query("SELECT id FROM vendors WHERE client_id=$cid AND normalized_key=$key").get({ $cid: clientId, $key: key }) as { id: number } | null;
  if (found) return { vendorId: found.id, created: false, possibleDuplicate: false };
  // Possible-duplicate guard: the client already has a vendor whose normalized
  // name matches but whose address differs or is absent. NEVER silently create
  // a second row — return the existing vendor so the caller can attach the
  // document to it in the needs-review surface for a human to confirm.
  const dup = findPossibleDuplicateVendor(db, clientId, vendorName);
  if (dup) {
    console.warn(`[mapping] POSSIBLE DUPLICATE VENDOR: "${vendorName}" normalized-name-matches existing vendor #${dup.id} "${dup.name}" (client ${clientId}); not creating a new vendor`);
    return { vendorId: dup.id, created: false, possibleDuplicate: true };
  }
  const client = db.query("SELECT tenant_id FROM clients WHERE id=$id").get({ $id: clientId }) as { tenant_id: number } | null;
  if (!client) return { vendorId: null, created: false, possibleDuplicate: false };
  const result = db.query("INSERT INTO vendors (name,address,normalized_key,client_id,tenant_id) VALUES ($name,$address,$key,$cid,$tid)").run({ $name: vendorName, $address: vendorAddress, $key: key, $cid: clientId, $tid: client.tenant_id });
  return { vendorId: Number(result.lastInsertRowid), created: true, possibleDuplicate: false };
}

export interface MappingResult {
  clientId: number;
  vendorId: number;
  vendorCreated: boolean;
  vendorPossibleDuplicate: boolean;
}

export function mapCOIToEntities(db: Database, tenantId: number, extraction: { certificate_holder: string | null; certificate_holder_address: string | null; vendor_name: string | null; insured_address: string | null }, _documentId: number): MappingResult | null {
  const clientId = matchOrCreateClient(db, tenantId, extraction.certificate_holder, extraction.certificate_holder_address);
  if (!clientId) return null;
  const vendor = matchOrCreateVendor(db, clientId, extraction.vendor_name, extraction.insured_address);
  if (!vendor.vendorId) return null;
  return {
    clientId,
    vendorId: vendor.vendorId,
    vendorCreated: vendor.created,
    vendorPossibleDuplicate: vendor.possibleDuplicate,
  };
}

export function parseW9FormDate(s: string | null): Date | null {
  if (!s || !/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return null;
  const [m, d, y] = s.split("/").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

export function hasPriorYearW9(db: Database, vendorId: number, priorYear: number): boolean {
  const rows = db.query(`SELECT de.w9_form_date FROM document_extractions de JOIN documents d ON d.id=de.document_id WHERE d.vendor_id=$vid AND d.document_type='W-9' AND de.w9_form_date IS NOT NULL`).all({ $vid: vendorId }) as Array<{ w9_form_date: string }>;
  return rows.some(r => parseW9FormDate(r.w9_form_date)?.getFullYear() === priorYear);
}
