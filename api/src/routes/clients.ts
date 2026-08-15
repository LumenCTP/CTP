import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb, applyDefaultRequiredDocs } from "../db";
import { entityKey } from "../entities";
import { logAudit } from "../middleware";

const app = new Hono();

// ── Clients ────────────────────────────────────────────

// GET /api/clients — list all clients with their required document types
app.get("/api/clients", (c) => {
  try {
    const db = getDb();

    const clients = db.query(`
      SELECT c.id, c.name, c.contact_email, c.contact_phone, c.address, c.created_at, c.updated_at
      FROM clients c
      WHERE c.tenant_id = $tenant_id
      ORDER BY c.name ASC
    `).all({ $tenant_id: c.get("tenant_id") as number }) as Array<{
      id: number; name: string; contact_email: string | null;
      contact_phone: string | null; address: string | null;
      created_at: string; updated_at: string;
    }>;

    // Fetch required document types for all clients in ONE batched query
    // (client_ids are all tenant-scoped from the query above), joined in memory.
    const clientIds = clients.map((cl) => cl.id);
    const docsRows = clientIds.length > 0 ? db.query(`
      SELECT client_id, document_type, coverage_requirement
      FROM client_required_documents
      WHERE client_id IN (SELECT value FROM json_each($client_ids))
        AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)
      ORDER BY client_id, document_type
    `).all({ $client_ids: JSON.stringify(clientIds), $tenant_id: c.get("tenant_id") as number }) as Array<{ client_id: number; document_type: string; coverage_requirement: string | null }> : [];
    const docsByClient = new Map<number, Array<{ document_type: string; coverage_requirement: string | null }>>();
    for (const d of docsRows) {
      const arr = docsByClient.get(d.client_id);
      if (arr) arr.push({ document_type: d.document_type, coverage_requirement: d.coverage_requirement });
      else docsByClient.set(d.client_id, [{ document_type: d.document_type, coverage_requirement: d.coverage_requirement }]);
    }
    const result = clients.map((client) => ({
      ...client,
      required_documents: docsByClient.get(client.id) ?? [],
    }));
    return c.json(result);
  } catch (err) {
    return serverError(c, err);
  }
});

// GET /api/clients/:id — single client with their required document types
app.get("/api/clients/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const client = db.query(
      "SELECT id, name, contact_email, contact_phone, address, created_at, updated_at FROM clients WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as {
      id: number; name: string; contact_email: string | null;
      contact_phone: string | null; address: string | null;
      created_at: string; updated_at: string;
    } | undefined;

    if (!client) {
      return c.json({ error: "Client not found" }, 404);
    }

    const docs = db.query(
      "SELECT document_type, coverage_requirement FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: id }) as Array<{ document_type: string; coverage_requirement: string | null }>;

    return c.json({
      ...client,
      required_documents: docs.map((d) => ({ document_type: d.document_type, coverage_requirement: d.coverage_requirement })),
    });
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/clients — create a client
app.post("/api/clients", async (c) => {
  try {
    const db = getDb();
    const body = await c.req.json();
    const { name, contact_email, contact_phone, address } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "Name is required" }, 400);
    }

    const trimmedName = name.trim();
    const trimmedAddress = address && typeof address === "string" ? address.trim() : null;
    // Every creation path writes the same dedup key (entities.ts) so the unique
    // index can prevent exact duplicate clients here.
    const key = entityKey(trimmedName, trimmedAddress);
    if (key && db.query("SELECT id FROM clients WHERE tenant_id = $tenant_id AND normalized_key = $key").get({ $tenant_id: c.get("tenant_id") as number, $key: key })) {
      return c.json({ error: "A client with this name already exists" }, 409);
    }

    const result = db.query(`
      INSERT INTO clients (tenant_id, name, contact_email, contact_phone, address, normalized_key)
      VALUES ($tenant_id, $name, $contact_email, $contact_phone, $address, $key)
    `).run({
      $tenant_id: c.get("tenant_id") as number,
      $name: trimmedName,
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
      $address: trimmedAddress,
      $key: key,
    });

    const newId = Number(result.lastInsertRowid);

    logAudit(db, "client", newId, "created", { name: trimmedName, contact_email, contact_phone, address: trimmedAddress });
    // New clients start with the standard default requirement set (never overwrites
    // anything — the client is brand new).
    applyDefaultRequiredDocs(db, newId);

    // Every new client also gets a client_email_config row defaulting the
    // weekly report recipients to the tenant owner's email. The Monday
    // Clear-to-Pay email is the core product promise — a brand-new client must
    // not silently receive nothing because the config row was missing. The
    // owner can change recipients later in Clients → Email Settings.
    const owner = db.query(`
      SELECT u.email FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE t.id = $tid
    `).get({ $tid: c.get("tenant_id") as number }) as { email: string } | undefined;
    db.query(`
      INSERT INTO client_email_config (client_id, weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled)
      VALUES ($client_id, $weekly, NULL, 1)
      ON CONFLICT(client_id) DO NOTHING
    `).run({
      $client_id: newId,
      $weekly: owner?.email ?? null,
    });

    const client = db.query("SELECT id, name, contact_email, contact_phone, address, created_at, updated_at FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: newId, $tenant_id: c.get("tenant_id") as number }) as any;
    const docs = db.query(
      "SELECT document_type, coverage_requirement FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: newId }) as Array<{ document_type: string; coverage_requirement: string | null }>;

    return c.json({ ...client, required_documents: docs.map((d) => ({ document_type: d.document_type, coverage_requirement: d.coverage_requirement })) }, 201);
  } catch (err) {
    return serverError(c, err);
  }
});

// PUT /api/clients/:id — update a client
app.put("/api/clients/:id", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const body = await c.req.json();
    const { name, contact_email, contact_phone, address } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "Name is required" }, 400);
    }

    // Recompute the dedup key on rename (mirroring vendors' PUT) so the key
    // never goes stale: a renamed client must be re-discoverable under its new
    // name, and re-adding the OLD name must not be falsely rejected as a 409.
    const trimmedName = name.trim();
    const trimmedAddress = address && typeof address === "string" ? address.trim() : null;
    const key = entityKey(trimmedName, trimmedAddress);
    if (key && db.query("SELECT id FROM clients WHERE tenant_id = $tenant_id AND normalized_key = $key AND id != $id").get({ $tenant_id: c.get("tenant_id") as number, $key: key, $id: id })) {
      return c.json({ error: "A client with this name already exists" }, 409);
    }

    db.query(`
      UPDATE clients
      SET name = $name, contact_email = $contact_email, contact_phone = $contact_phone, address = $address, normalized_key = $key, updated_at = datetime('now')
      WHERE id = $id
    `).run({
      $id: id,
      $tenant_id: c.get("tenant_id") as number,
      $name: trimmedName,
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
      $address: trimmedAddress,
      $key: key,
    });

    logAudit(db, "client", id, "updated", { name: trimmedName, contact_email, contact_phone, address });

    const client = db.query("SELECT id, name, contact_email, contact_phone, address, created_at, updated_at FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as any;

    const docs = db.query(
      "SELECT document_type, coverage_requirement FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: id }) as Array<{ document_type: string; coverage_requirement: string | null }>;

    return c.json({ ...client, required_documents: docs.map((d) => ({ document_type: d.document_type, coverage_requirement: d.coverage_requirement })) });
  } catch (err) {
    return serverError(c, err);
  }
});

// DELETE /api/clients/:id — delete a client
app.delete("/api/clients/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string } | undefined;
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    logAudit(db, "client", id, "deleted", { name: existing.name });

    db.query("DELETE FROM clients WHERE id = $id AND tenant_id = $tenant_id").run({ $id: id, $tenant_id: c.get("tenant_id") as number });

    return c.json({ success: true });
  } catch (err) {
    return serverError(c, err);
  }
});

// GET /api/clients/:id/documents-required — get required document types
app.get("/api/clients/:id/documents-required", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const docs = db.query(
      "SELECT id, client_id, document_type, coverage_requirement, created_at FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: id });

    return c.json(docs);
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/clients/:id/documents-required — set required document types
// Accepts document_types as either an array of strings (legacy: type only) or an
// array of { document_type, coverage_requirement } objects.
app.post("/api/clients/:id/documents-required", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const body = await c.req.json();
    const { document_types } = body as { document_types: Array<string | { document_type?: unknown; coverage_requirement?: unknown }> };

    if (!Array.isArray(document_types)) {
      return c.json({ error: "document_types must be an array" }, 400);
    }

    // Remove existing entries
    db.query("DELETE FROM client_required_documents WHERE client_id = $client_id").run({ $client_id: id });

    // Insert new entries (normalize string entries to { document_type, coverage_requirement: null })
    const insertStmt = db.query(
      "INSERT INTO client_required_documents (client_id, document_type, coverage_requirement) VALUES ($client_id, $document_type, $coverage_requirement)"
    );

    for (const entry of document_types) {
      const docType = typeof entry === "string" ? entry.trim() : (typeof entry?.document_type === "string" ? (entry.document_type as string).trim() : "");
      if (docType.length === 0) continue;
      const coverage =
        typeof entry === "object" && entry !== null && typeof (entry as { coverage_requirement?: unknown }).coverage_requirement === "string"
          ? ((entry as { coverage_requirement: string }).coverage_requirement.trim() || null)
          : null;
      insertStmt.run({ $client_id: id, $document_type: docType, $coverage_requirement: coverage });
    }

    logAudit(db, "client", id, "set_required_documents", { document_types });

    const docs = db.query(
      "SELECT id, client_id, document_type, coverage_requirement, created_at FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: id });

    return c.json(docs);
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
