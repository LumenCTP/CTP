import { Hono } from "hono";
import path from "node:path";
import { existsSync } from "node:fs";
import { generateAuditPackage } from "../audit";

const app = new Hono();

// ── Audit Package ──────────────────────────────────────

// POST /api/audit/generate — generate an audit ZIP package
app.post("/api/audit/generate", async (c) => {
  try {
    const body = await c.req.json();
    const { client_id, vendor_id, document_type, date_from, date_to } = body;

    if (!client_id || typeof client_id !== "number" || isNaN(client_id)) {
      return c.json({ error: "Valid client_id is required" }, 400);
    }

    const result = generateAuditPackage({
      client_id,
      vendor_id: vendor_id && typeof vendor_id === "number" ? vendor_id : undefined,
      document_type: document_type && typeof document_type === "string" ? document_type : undefined,
      date_from: date_from && typeof date_from === "string" ? date_from : undefined,
      date_to: date_to && typeof date_to === "string" ? date_to : undefined,
    }, c.get("tenant_id") as number);

    return c.json(result);
  } catch (err) {
    console.error("[audit] Error generating audit package:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/audit/download/:filename — download a generated audit ZIP
app.get("/api/audit/download/:filename", (c) => {
  try {
    const filename = decodeURIComponent(c.req.param("filename"));
    const auditsDir = path.join(import.meta.dir, "..", "..", "data", "audits");
    const filePath = path.join(auditsDir, filename);

    // Security: prevent directory traversal
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(auditsDir);
    if (!resolved.startsWith(resolvedDir)) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    if (!existsSync(filePath)) {
      return c.json({ error: "Audit file not found" }, 404);
    }

    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;
