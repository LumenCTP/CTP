import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { entityKey } from "../entities";
import { logAudit } from "../middleware";

const app = new Hono();

// ── Vendors ────────────────────────────────────────────

// GET /api/vendors — list all vendors with client name, compliance/payment status
app.get("/api/vendors", (c) => {
  try {
    const db = getDb();
    const clientId = c.req.query("client_id");

    let sql = `
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        COALESCE(cs.status, 'needs_review') AS compliance_status,
        COALESCE(cs.payment_status, 'hold') AS payment_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
    `;

    const params: Record<string, unknown> = { $tenant_id: c.get("tenant_id") as number };
    sql += " WHERE v.tenant_id = $tenant_id";

    if (clientId) {
      sql += " AND v.client_id = $client_id";
      params.$client_id = Number(clientId);
    }

    sql += " ORDER BY v.name ASC";

    const vendors = db.query(sql).all(params);
    return c.json(vendors);
  } catch (err) {
    return serverError(c, err);
  }
});

// GET /api/vendors/:id — single vendor with client info, compliance, document summary
app.get("/api/vendors/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const vendor = db.query(`
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        COALESCE(cs.status, 'needs_review') AS compliance_status,
        COALESCE(cs.payment_status, 'hold') AS payment_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
      WHERE v.id = $id AND v.tenant_id = $tenant_id
    `).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as Record<string, unknown> | undefined;

    if (!vendor) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    // Document summary
    const docCount = (db.query(
      "SELECT COUNT(*) as count FROM documents WHERE vendor_id = $vendor_id AND tenant_id = $tenant_id"
    ).get({ $vendor_id: id, $tenant_id: c.get("tenant_id") as number }) as { count: number }).count;

    const latestExtraction = db.query(`
      SELECT MAX(de.extracted_at) AS latest_date
      FROM document_extractions de
      JOIN documents d ON de.document_id = d.id
      WHERE d.vendor_id = $vendor_id AND d.tenant_id = $tenant_id
    `).get({ $vendor_id: id, $tenant_id: c.get("tenant_id") as number }) as { latest_date: string | null };

    return c.json({
      ...vendor,
      document_count: docCount,
      latest_extraction_date: latestExtraction?.latest_date ?? null,
    });
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/vendors — create a vendor
app.post("/api/vendors", async (c) => {
  try {
    const db = getDb();
    const body = await c.req.json();
    const { client_id, name, contact_name, contact_email, contact_phone, address } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "Vendor name is required" }, 400);
    }

    if (!client_id || typeof client_id !== "number") {
      return c.json({ error: "client_id is required and must be a number" }, 400);
    }

    // Verify client exists
    const clientExists = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: client_id, $tenant_id: c.get("tenant_id") as number });
    if (!clientExists) {
      return c.json({ error: "Client not found" }, 404);
    }

    const trimmedName = name.trim();
    const trimmedAddress = address && typeof address === "string" ? address.trim() : null;
    // Every creation path writes the same dedup key (single source of truth in
    // entities.ts) so the unique index can prevent exact duplicates here.
    const key = entityKey(trimmedName, trimmedAddress);
    if (key && db.query("SELECT id FROM vendors WHERE client_id = $client_id AND normalized_key = $key").get({ $client_id: client_id, $key: key })) {
      return c.json({ error: "A vendor with this name already exists under this client" }, 409);
    }

    const result = db.query(`
      INSERT INTO vendors (tenant_id, client_id, name, address, normalized_key, contact_name, contact_email, contact_phone)
      VALUES ($tenant_id, $client_id, $name, $address, $key, $contact_name, $contact_email, $contact_phone)
    `).run({
      $tenant_id: c.get("tenant_id") as number,
      $client_id: client_id,
      $name: trimmedName,
      $address: trimmedAddress,
      $key: key,
      $contact_name: contact_name?.trim() || null,
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
    });

    const newId = Number(result.lastInsertRowid);

    // Create initial compliance status
    db.query(`
      INSERT INTO compliance_status (vendor_id, client_id, status, payment_status)
      VALUES ($vendor_id, $client_id, 'needs_review', 'hold')
    `).run({ $vendor_id: newId, $client_id: client_id });

    logAudit(db, "vendor", newId, "created", { client_id, name: trimmedName, address: trimmedAddress, contact_name, contact_email, contact_phone });

    // Return the new vendor with client name
    const vendor = db.query(`
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        'needs_review' AS compliance_status,
        'hold' AS payment_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      WHERE v.id = $id AND v.tenant_id = $tenant_id
    `).get({ $id: newId, $tenant_id: c.get("tenant_id") as number });

    return c.json(vendor, 201);
  } catch (err) {
    return serverError(c, err);
  }
});

// PUT /api/vendors/:id — update a vendor
app.put("/api/vendors/:id", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id FROM vendors WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    const body = await c.req.json();
    const { client_id, name, contact_name, contact_email, contact_phone, address } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "Vendor name is required" }, 400);
    }

    if (!client_id || typeof client_id !== "number") {
      return c.json({ error: "client_id is required and must be a number" }, 400);
    }

    // Verify client exists
    const clientExists = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: client_id, $tenant_id: c.get("tenant_id") as number });
    if (!clientExists) {
      return c.json({ error: "Client not found" }, 404);
    }

    const trimmedName = name.trim();
    const trimmedAddress = address && typeof address === "string" ? address.trim() : null;
    // Keep the dedup key in sync with the edited name/address, and refuse an
    // edit that would collide with an existing vendor's key under this client.
    const key = entityKey(trimmedName, trimmedAddress);
    if (key && db.query("SELECT id FROM vendors WHERE client_id = $client_id AND normalized_key = $key AND id != $id").get({ $client_id: client_id, $key: key, $id: id })) {
      return c.json({ error: "Another vendor with this name already exists under this client" }, 409);
    }

    db.query(`
      UPDATE vendors
      SET client_id = $client_id, name = $name, address = $address, normalized_key = $key,
          contact_name = $contact_name, contact_email = $contact_email, contact_phone = $contact_phone,
          updated_at = datetime('now')
      WHERE id = $id
    `).run({
      $id: id,
      $tenant_id: c.get("tenant_id") as number,
      $client_id: client_id,
      $name: trimmedName,
      $address: trimmedAddress,
      $key: key,
      $contact_name: contact_name?.trim() || null,
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
    });

    logAudit(db, "vendor", id, "updated", { client_id, name: trimmedName, address: trimmedAddress, contact_name, contact_email, contact_phone });

    // Return updated vendor
    const vendor = db.query(`
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        COALESCE(cs.status, 'needs_review') AS compliance_status,
        COALESCE(cs.payment_status, 'hold') AS payment_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
      WHERE v.id = $id
    `).get({ $id: id, $tenant_id: c.get("tenant_id") as number });

    return c.json(vendor);
  } catch (err) {
    return serverError(c, err);
  }
});

// DELETE /api/vendors/:id — delete a vendor (cascade deletes their documents, extractions, compliance)
app.delete("/api/vendors/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id, name FROM vendors WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string } | undefined;
    if (!existing) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    logAudit(db, "vendor", id, "deleted", { name: existing.name });

    db.query("DELETE FROM vendors WHERE id = $id AND tenant_id = $tenant_id").run({ $id: id, $tenant_id: c.get("tenant_id") as number });

    return c.json({ success: true });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
