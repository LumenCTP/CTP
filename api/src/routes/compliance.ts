import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { calculateVendorCompliance, calculateClientCompliance, calculateAllCompliance } from "../compliance";

const app = new Hono();

// ── Compliance Recalculation ───────────────────────────

// POST /api/compliance/recalculate — recalculate compliance for all, one client, or one vendor
app.post("/api/compliance/recalculate", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const clientId = body.client_id ? Number(body.client_id) : undefined;
    const vendorId = body.vendor_id ? Number(body.vendor_id) : undefined;
    const clientIdRaw = body.client_id ? Number(body.client_id) : undefined;

    let summary: { vendor_count: number; approved: number; review: number; hold: number };

    if (vendorId && clientIdRaw) {
      // Single vendor
      const result = calculateVendorCompliance(vendorId, clientIdRaw, c.get("tenant_id") as number);
      summary = {
        vendor_count: 1,
        approved: result.payment_status === "approved" ? 1 : 0,
        review: result.payment_status === "review" ? 1 : 0,
        hold: result.payment_status === "hold" ? 1 : 0,
      };
    } else if (clientId) {
      summary = calculateClientCompliance(clientId, c.get("tenant_id") as number);
    } else {
      summary = calculateAllCompliance(c.get("tenant_id") as number);
    }

    return c.json(summary);
  } catch (err) {
    return serverError(c, err);
  }
});

// GET /api/vendors/:id/compliance-detail — detailed per-doc-type compliance breakdown
app.get("/api/vendors/:id/compliance-detail", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const vendor = db.query(
      "SELECT id, client_id, name FROM vendors WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { id: number; client_id: number; name: string } | undefined;

    if (!vendor) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    const client = db.query(
      "SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: vendor.client_id }) as { id: number; name: string } | undefined;

    // Recalculate fresh compliance for this vendor
    const result = calculateVendorCompliance(vendor.id, vendor.client_id, c.get("tenant_id") as number);

    return c.json({
      vendor_id: vendor.id,
      client_id: vendor.client_id,
      vendor_name: vendor.name,
      client_name: client?.name ?? "Unknown",
      status: result.status,
      payment_status: result.payment_status,
      details: result.details,
    });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
