import { Hono } from "hono";
import { getDb, applyDefaultRequiredDocs } from "../db";
import { entityKey } from "../entities";

const app = new Hono();

// ── CSV Imports ────────────────────────────────────────

function parseCsv(text: string): string[][] {
  // Excel's "CSV UTF-8" export (the most common way a construction office
  // produces this file) starts with a UTF-8 BOM — strip it so the first header
  // cell is "name", not "\uFEFFname", and header matching works.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(field.trim()); field = ""; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows;
}

const CLIENT_COLUMNS = ["name", "contact_email", "contact_phone", "address"];
const VENDOR_COLUMNS = ["name", "contact_name", "contact_email", "contact_phone", "address"];

async function importCsv(c: any, kind: "clients" | "vendors") {
  const form = await c.req.parseBody();
  const uploaded = form.file;
  if (!(uploaded instanceof File)) return c.json({ error: "CSV file is required" }, 400);
  const rows = parseCsv(await uploaded.text());
  if (rows.length < 1) return c.json({ imported: 0, skipped: 0, errors: [{ row: 1, error: "CSV is empty" }] });
  const expected = kind === "clients" ? CLIENT_COLUMNS : VENDOR_COLUMNS;
  // Normalize header keys (trim + lowercase, BOM already stripped) so files
  // exported with case differences or stray spaces still match.
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const indexes = expected.map((h) => headers.indexOf(h));
  if (indexes[0] < 0) return c.json({ imported: 0, skipped: 0, errors: [{ row: 1, error: "Missing name column" }] }, 400);
  const db = getDb();
  const tenantId = c.get("tenant_id") as number;
  const clientId = kind === "vendors" ? Number(form.client_id) : null;
  if (kind === "vendors" && (!clientId || !db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: tenantId }))) {
    return c.json({ error: "Client not found" }, 400);
  }

  // Per-row processing: good rows commit immediately, bad rows are collected
  // with their real row numbers. One bad row no longer rolls back the file, so
  // a client can fix a few rows and re-upload instead of re-doing everything.
  const result: { imported: number; skipped: number; errors: Array<{ row: number; error: string }> } = { imported: 0, skipped: 0, errors: [] };

  const vendorInsert = db.query("INSERT INTO vendors (tenant_id, client_id, name, contact_name, contact_email, contact_phone, address, normalized_key) VALUES ($tenant_id, $client_id, $name, $contact_name, $contact_email, $contact_phone, $address, $key)");
  const vendorStatusInsert = db.query("INSERT INTO compliance_status (vendor_id, client_id, status, payment_status) VALUES ($vendor_id, $client_id, 'needs_review', 'hold')");
  const vendorExists = db.query("SELECT id FROM vendors WHERE client_id = $cid AND normalized_key = $key");
  const clientInsert = db.query("INSERT INTO clients (tenant_id, name, contact_email, contact_phone, address, normalized_key) VALUES ($tenant_id, $name, $contact_email, $contact_phone, $address, $key)");
  const clientExists = db.query("SELECT id FROM clients WHERE tenant_id = $tid AND normalized_key = $key");

  for (let n = 1; n < rows.length; n++) {
    const values = expected.map((_, i) => indexes[i] >= 0 ? (rows[n][indexes[i]] || "").trim() : "");
    const rowNumber = n + 1; // 1-based data row number as shown in the file
    if (!values[0]) { result.errors.push({ row: rowNumber, error: "Missing name" }); continue; }
    try {
      if (kind === "vendors") {
        const key = entityKey(values[0], values[4] || null);
        // Dedup by key: re-importing the same list is idempotent. Vendors
        // whose normalized_key cannot be built (unlikely — name is present)
        // are skipped rather than inserted without a key.
        if (key && vendorExists.get({ $cid: clientId, $key: key })) { result.skipped++; continue; }
        if (!key) { result.errors.push({ row: rowNumber, error: "Could not build dedup key from name" }); continue; }
        const ins = vendorInsert.run({ $tenant_id: tenantId, $client_id: clientId, $name: values[0], $contact_name: values[1] || null, $contact_email: values[2] || null, $contact_phone: values[3] || null, $address: values[4] || null, $key: key });
        vendorStatusInsert.run({ $vendor_id: Number(ins.lastInsertRowid), $client_id: clientId });
        result.imported++;
      } else {
        const key = entityKey(values[0], values[3] || null);
        if (key && clientExists.get({ $tid: tenantId, $key: key })) { result.skipped++; continue; }
        if (!key) { result.errors.push({ row: rowNumber, error: "Could not build dedup key from name" }); continue; }
        const r = clientInsert.run({ $tenant_id: tenantId, $name: values[0], $contact_email: values[1] || null, $contact_phone: values[2] || null, $address: values[3] || null, $key: key });
        applyDefaultRequiredDocs(db, Number(r.lastInsertRowid));
        result.imported++;
      }
    } catch (err) {
      result.errors.push({ row: rowNumber, error: err instanceof Error ? err.message : "Import failed" });
    }
  }
  return c.json(result);
}

for (const kind of ["clients", "vendors"] as const) {
  app.get(`/api/import/${kind}-template`, (c) => {
    // Real newline (NOT a literal "\n") so the downloaded template is a valid
    // CSV; vendor template includes the address column so the name+address
    // dedup key can be built on import.
    const headers = kind === "clients" ? CLIENT_COLUMNS.join(",") : VENDOR_COLUMNS.join(",");
    return new Response(headers + "\n", { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=${kind}-template.csv` } });
  });
  app.post(`/api/import/${kind}`, (c) => importCsv(c, kind));
}

export default app;
