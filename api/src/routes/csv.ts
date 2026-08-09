import { Hono } from "hono";
import { getDb } from "../db";

const app = new Hono();

// ── CSV Imports ────────────────────────────────────────

function parseCsv(text: string): string[][] {
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

async function importCsv(c: any, kind: "clients" | "vendors") {
  const form = await c.req.parseBody();
  const uploaded = form.file;
  if (!(uploaded instanceof File)) return c.json({ error: "CSV file is required" }, 400);
  const rows = parseCsv(await uploaded.text());
  if (rows.length < 1) return c.json({ imported: 0, errors: [{ row: 1, error: "CSV is empty" }] });
  const expected = kind === "clients"
    ? ["name", "contact_email", "contact_phone", "address"]
    : ["name", "contact_name", "contact_email", "contact_phone"];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const indexes = expected.map((h) => headers.indexOf(h));
  if (indexes[0] < 0) return c.json({ imported: 0, errors: [{ row: 1, error: "Missing name column" }] }, 400);
  const errors: Array<{ row: number; error: string }> = [];
  const valid: string[][] = [];
  for (let n = 1; n < rows.length; n++) {
    const values = expected.map((_, i) => indexes[i] >= 0 ? (rows[n][indexes[i]] || "").trim() : "");
    if (!values[0]) errors.push({ row: n + 1, error: "Missing name" });
    else valid.push(values);
  }
  const db = getDb();
  const tenantId = c.get("tenant_id") as number;
  let imported = 0;
  try {
    const transaction = db.transaction(() => {
      if (kind === "vendors") {
        const clientId = Number(form.client_id);
        if (!clientId || !db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: tenantId })) throw new Error("Client not found");
        const insert = db.query("INSERT INTO vendors (tenant_id, client_id, name, contact_name, contact_email, contact_phone) VALUES ($tenant_id, $client_id, $name, $contact_name, $contact_email, $contact_phone)");
        const status = db.query("INSERT INTO compliance_status (vendor_id, client_id, status, payment_status) VALUES ($vendor_id, $client_id, 'needs_review', 'hold')");
        for (const v of valid) {
          const result = insert.run({ $tenant_id: tenantId, $client_id: clientId, $name: v[0], $contact_name: v[1] || null, $contact_email: v[2] || null, $contact_phone: v[3] || null });
          status.run({ $vendor_id: Number(result.lastInsertRowid), $client_id: clientId }); imported++;
        }
      } else {
        const insert = db.query("INSERT INTO clients (tenant_id, name, contact_email, contact_phone, address) VALUES ($tenant_id, $name, $contact_email, $contact_phone, $address)");
        for (const v of valid) { insert.run({ $tenant_id: tenantId, $name: v[0], $contact_email: v[1] || null, $contact_phone: v[2] || null, $address: v[3] || null }); imported++; }
      }
    });
    transaction();
  } catch (err) { return c.json({ imported: 0, errors: [{ row: 1, error: err instanceof Error ? err.message : "Import failed" }] }, 400); }
  return c.json({ imported, errors });
}

for (const kind of ["clients", "vendors"] as const) {
  app.get(`/api/import/${kind}-template`, (c) => {
    const headers = kind === "clients" ? "name,contact_email,contact_phone,address" : "name,contact_name,contact_email,contact_phone";
    return new Response(headers + "\\n", { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=${kind}-template.csv` } });
  });
  app.post(`/api/import/${kind}`, (c) => importCsv(c, kind));
}

export default app;
