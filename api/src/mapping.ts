import type { Database } from "bun:sqlite";
import { applyDefaultRequiredDocs } from "./db";

export function normalize(s: string | null): string | null {
  if (s === null) return null;
  const value = s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,'\"]/g, "").replace(/[^a-z0-9 ]/g, "");
  return value || null;
}

function entityKey(name: string | null, address: string | null): string | null {
  const n = normalize(name), a = normalize(address);
  return n && a ? `${n}::${a}` : null;
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

export function matchOrCreateVendor(db: Database, clientId: number, vendorName: string | null, vendorAddress: string | null): number | null {
  const key = entityKey(vendorName, vendorAddress);
  if (!key) return null;
  const found = db.query("SELECT id FROM vendors WHERE client_id=$cid AND normalized_key=$key").get({ $cid: clientId, $key: key }) as { id: number } | null;
  if (found) return found.id;
  const client = db.query("SELECT tenant_id FROM clients WHERE id=$id").get({ $id: clientId }) as { tenant_id: number } | null;
  if (!client) return null;
  const result = db.query("INSERT INTO vendors (name,address,normalized_key,client_id,tenant_id) VALUES ($name,$address,$key,$cid,$tid)").run({ $name: vendorName, $address: vendorAddress, $key: key, $cid: clientId, $tid: client.tenant_id });
  return Number(result.lastInsertRowid);
}

export function mapCOIToEntities(db: Database, tenantId: number, extraction: { certificate_holder: string | null; certificate_holder_address: string | null; vendor_name: string | null; insured_address: string | null }, _documentId: number): { clientId: number; vendorId: number } | null {
  const clientId = matchOrCreateClient(db, tenantId, extraction.certificate_holder, extraction.certificate_holder_address);
  if (!clientId) return null;
  const vendorId = matchOrCreateVendor(db, clientId, extraction.vendor_name, extraction.insured_address);
  return vendorId ? { clientId, vendorId } : null;
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
