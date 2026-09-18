import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { entityKey } from "../entities";
import { findPossibleDuplicateVendor } from "../mapping";
import { logAudit } from "../middleware";
import { sendEmail, buildVendorRequestEmail, getTenantInboxAddress } from "../email";
import { calculateVendorCompliance, refreshMissingScores } from "../compliance";

const app = new Hono();

// ── Vendors ────────────────────────────────────────────

// Email types that are addressed TO a vendor (an outreach the vendor received).
// renewal_reminder: expiring-document nudge (scheduler.ts + manual send in
// routes/emails.ts). inbox_rejection: "some documents you sent couldn't be
// read" reply from the compliance inbox. vendor_request: the client-initiated
// "Request updated docs" email sent from the vendor detail page. Any future
// vendor-facing type must be added here or it will not show up as outreach.
const VENDOR_FACING_EMAIL_TYPES = "'renewal_reminder', 'inbox_rejection', 'vendor_request'";


// GET /api/vendors — list all vendors with client name, compliance/payment status,
// and the last vendor-facing email this tenant has on file for them.
//
// email_log has NO tenant_id column, so outreach is scoped by joining it to the
// requesting tenant's own vendor rows (vendors.tenant_id = $tenant_id). The
// sub-join carries the same guard so a row can never be attributed across
// tenants even if a vendor_id were reused.
app.get("/api/vendors", (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const clientId = c.req.query("client_id");

    // Cheap self-healing backfill: fills the derived score columns for vendors
    // whose compliance row predates the score feature. One no-op SELECT once
    // every vendor has been scored.
    refreshMissingScores(tenantId);

    let sql = `
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        v.insurance_agent_email,
        COALESCE(cs.status, 'needs_review') AS compliance_status,
        COALESCE(cs.payment_status, 'hold') AS payment_status,
        cs.compliance_score, cs.score_label,
        le.sent_at AS last_emailed_at,
        le.email_type AS last_email_type,
        le.status AS last_email_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
      LEFT JOIN email_log le ON le.id = (
        SELECT el.id FROM email_log el
        WHERE el.vendor_id = v.id
          AND el.vendor_id IN (SELECT id FROM vendors WHERE tenant_id = $tenant_id)
          AND el.email_type IN (${VENDOR_FACING_EMAIL_TYPES})
        ORDER BY el.sent_at DESC, el.id DESC
        LIMIT 1
      )
    `;

    const params: Record<string, unknown> = { $tenant_id: tenantId };
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
        cs.compliance_score, cs.score_label,
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
    const { client_id, name, contact_name, contact_email, contact_phone, insurance_agent_email, address } = body;

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
    // Name-only (suffix-tolerant) dedup fallback, using the SAME guard the
    // AI-extraction path uses (entities.normalizedNameForDedup): catches
    // "ABC Roofing" vs "ABC Roofing, LLC" even though their normalized_key
    // differs. A manual add must not silently create a near-duplicate.
    const nameDup = findPossibleDuplicateVendor(db, client_id, trimmedName);
    if (nameDup) {
      return c.json({ error: `A vendor with this name (or a very similar name) already exists: "${nameDup.name}". Select the existing vendor instead of creating a duplicate.` }, 409);
    }

    const result = db.query(`
      INSERT INTO vendors (tenant_id, client_id, name, address, normalized_key, contact_name, contact_email, contact_phone, insurance_agent_email)
      VALUES ($tenant_id, $client_id, $name, $address, $key, $contact_name, $contact_email, $contact_phone, $insurance_agent_email)
    `).run({
      $tenant_id: c.get("tenant_id") as number,
      $client_id: client_id,
      $name: trimmedName,
      $address: trimmedAddress,
      $key: key,
      $contact_name: contact_name?.trim() || null,
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
      $insurance_agent_email: insurance_agent_email?.trim() || null,
    });

    const newId = Number(result.lastInsertRowid);

    // Create initial compliance status. The score columns stay NULL here and are
    // filled by the engine run below, so a scoring failure can never block
    // vendor creation.
    db.query(`
      INSERT INTO compliance_status (vendor_id, client_id, status, payment_status)
      VALUES ($vendor_id, $client_id, 'needs_review', 'hold')
    `).run({ $vendor_id: newId, $client_id: client_id });

    // Run the compliance engine once so the new vendor's row carries a real
    // status / payment status / derived score immediately. A failure here must
    // not turn a successful creation into an error — the score is backfilled by
    // refreshMissingScores() on the next vendor-list or dashboard read.
    let score: { compliance_score: number | null; score_label: string | null } = { compliance_score: null, score_label: null };
    try {
      const engine = calculateVendorCompliance(newId, client_id, c.get("tenant_id") as number);
      score = { compliance_score: engine.compliance_score, score_label: engine.score_label };
    } catch { /* backfilled on next read */ }

    logAudit(db, "vendor", newId, "created", { client_id, name: trimmedName, address: trimmedAddress, contact_name, contact_email, contact_phone, insurance_agent_email });

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
    `).get({ $id: newId, $tenant_id: c.get("tenant_id") as number }) as Record<string, unknown> | undefined;

    return c.json({ ...(vendor ?? {}), ...score }, 201);
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
    const { client_id, name, contact_name, contact_email, contact_phone, insurance_agent_email, address } = body;

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
    // Name-only (suffix-tolerant) dedup fallback — same guard the POST create
    // path (and AI-extraction path) uses: renaming "ABC Roofing" →
    // "ABC Roofing, Inc." while "ABC Roofing LLC" already exists must be caught,
    // even though their normalized_key differs. The vendor being edited is
    // excluded so an unchanged-name edit (contact/address updates) still saves.
    const nameDup = findPossibleDuplicateVendor(db, client_id, trimmedName);
    if (nameDup && nameDup.id !== id) {
      return c.json({ error: `A vendor with this name (or a very similar name) already exists: "${nameDup.name}". Select the existing vendor instead of creating a duplicate.` }, 409);
    }

    db.query(`
      UPDATE vendors
      SET client_id = $client_id, name = $name, address = $address, normalized_key = $key,
          contact_name = $contact_name, contact_email = $contact_email, contact_phone = $contact_phone,
          insurance_agent_email = $insurance_agent_email,
          updated_at = datetime('now')
      WHERE id = $id AND tenant_id = $tenant_id
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
      $insurance_agent_email: insurance_agent_email?.trim() || null,
    });

    logAudit(db, "vendor", id, "updated", { client_id, name: trimmedName, address: trimmedAddress, contact_name, contact_email, contact_phone, insurance_agent_email });

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
      WHERE v.id = $id AND v.tenant_id = $tenant_id
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

// POST /api/vendors/:id/request-docs — ask a vendor for updated compliance
// documents. Optional body { document_types: string[] }; when omitted (or
// empty) the doc types are derived from the vendor's live compliance detail —
// every required type that is missing, expired, expiring soon, or below the
// client's required coverage limit (the types that actually need a fresh
// document from the vendor). Types the client only needs to REVIEW
// (needs_review / unreviewed docs) are NOT requested: the client resolves those
// internally, so asking the vendor for another copy would be noise.
//
// Exactly ONE email goes out through the normal sendEmail chain (Graph → SMTP →
// queue), logged to email_log as email_type 'vendor_request' with vendor_id and
// client_id set. Vendor-facing copy only (no platform internals, existing
// disclaimer sentence).
//
// Strictly tenant-scoped: the vendor row is looked up by id AND tenant_id, so a
// cross-tenant id is a 404 and the caller's own tenant can never be bypassed.
const REQUESTABLE_STATUSES = new Set(["missing", "expired", "expiring_soon", "below_limit"]);

app.post("/api/vendors/:id/request-docs", async (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    const vendor = db.query(`
      SELECT v.id, v.client_id, v.name, v.contact_name, v.contact_email,
             v.insurance_agent_email, cl.name AS client_name
      FROM vendors v
      JOIN clients cl ON cl.id = v.client_id
      WHERE v.id = $id AND v.tenant_id = $tenant_id
    `).get({ $id: id, $tenant_id: tenantId }) as {
      id: number; client_id: number; name: string; contact_name: string | null;
      contact_email: string | null; insurance_agent_email: string | null; client_name: string;
    } | undefined;
    if (!vendor) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    // Body is optional — an absent or non-JSON body means "derive the list".
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    let documentTypes: string[] = [];
    const requested = (body as { document_types?: unknown }).document_types;
    if (requested !== undefined) {
      if (!Array.isArray(requested) || requested.some((t) => typeof t !== "string" || t.trim().length === 0)) {
        return c.json({ error: "document_types must be an array of non-empty strings" }, 400);
      }
      // Trim, drop blanks, de-duplicate (case-insensitive), cap the list so a
      // hostile body cannot bloat the email.
      const seen = new Set<string>();
      for (const raw of requested as string[]) {
        const t = raw.trim().slice(0, 80);
        const key = t.toLowerCase();
        if (!t || seen.has(key)) continue;
        seen.add(key);
        documentTypes.push(t);
        if (documentTypes.length >= 20) break;
      }
      if (documentTypes.length === 0) {
        return c.json({ error: "document_types must contain at least one document type" }, 400);
      }
    }

    if (documentTypes.length === 0) {
      // Derive from the live compliance detail (same engine the dashboard and
      // reports use, so the request always matches what the client sees).
      const detail = calculateVendorCompliance(vendor.id, vendor.client_id, tenantId);
      documentTypes = detail.details
        .filter((d) => REQUESTABLE_STATUSES.has(d.status))
        .map((d) => d.document_type);
      if (documentTypes.length === 0) {
        return c.json({
          error: "This vendor has no missing, expired, expiring, or below-limit documents — nothing to request. You can still request specific document types.",
        }, 400);
      }
    }

    // Recipient: vendor contact first, then the insurance agent on file. Both
    // empty is a client-side fix (the UI tells the client to add one).
    const contactEmail = (vendor.contact_email ?? "").trim();
    const agentEmail = (vendor.insurance_agent_email ?? "").trim();
    const recipient = contactEmail || agentEmail;
    const recipientSource = contactEmail ? "contact_email" : "insurance_agent_email";
    if (!recipient) {
      return c.json({
        error: "No email on file for this vendor — add a contact email first.",
        code: "no_email_on_file",
      }, 400);
    }

    const inboxAddress = getTenantInboxAddress(tenantId);
    const subject = `Action needed: updated compliance documents for ${vendor.client_name}`;
    const emailBody = buildVendorRequestEmail(
      vendor.name,
      vendor.client_name,
      documentTypes,
      inboxAddress,
      vendor.contact_name,
    );

    // One email, through the normal chain. sendEmail() records exactly one
    // terminal email_log row ('sent' via Graph/SMTP, or 'queued' on the
    // platform queue path) — this route never writes a second log row.
    await sendEmail([recipient], subject, emailBody, vendor.client_id, vendor.id, "vendor_request");

    logAudit(db, "vendor", vendor.id, "docs_requested", {
      recipient,
      recipient_source: recipientSource,
      document_types: documentTypes,
    });

    return c.json({
      success: true,
      vendor_id: vendor.id,
      client_id: vendor.client_id,
      recipient,
      recipient_source: recipientSource,
      email_type: "vendor_request",
      subject,
      document_types: documentTypes,
    });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
