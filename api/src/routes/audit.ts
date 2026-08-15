import { Hono } from "hono";
import { serverError } from "../errors";
import { generateAuditPackage } from "../audit";
import { storageGetStream } from "../storage";

const app = new Hono();

// Audit ZIPs are stored under a tenant-scoped key prefix (audits/tenant-<id>/),
// so a tenant can never download another tenant's files even if it knows the
// filename. The storage layer maps this 1:1 to the local layout
// data/audits/tenant-<id>/ in fallback mode.

function assertPlainFilename(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename !== "." &&
    filename !== ".." &&
    !filename.includes("/") &&
    !filename.includes("\\")
  );
}

// ── Audit Package ──────────────────────────────────────

// POST /api/audit/generate — generate an audit ZIP package
app.post("/api/audit/generate", async (c) => {
  try {
    const body = await c.req.json();
    const { client_id, vendor_id, document_type, date_from, date_to } = body;

    if (!client_id || typeof client_id !== "number" || isNaN(client_id)) {
      return c.json({ error: "Valid client_id is required" }, 400);
    }

    const result = await generateAuditPackage({
      client_id,
      vendor_id: vendor_id && typeof vendor_id === "number" ? vendor_id : undefined,
      document_type: document_type && typeof document_type === "string" ? document_type : undefined,
      date_from: date_from && typeof date_from === "string" ? date_from : undefined,
      date_to: date_to && typeof date_to === "string" ? date_to : undefined,
    }, c.get("tenant_id") as number);

    return c.json(result);
  } catch (err) {
    console.error("[audit] Error generating audit package:", err);
    return serverError(c, err);
  }
});

// GET /api/audit/download/:filename — download a generated audit ZIP
app.get("/api/audit/download/:filename", async (c) => {
  try {
    const filename = decodeURIComponent(c.req.param("filename"));
    // Only ever address the requesting tenant's own audits key space.
    if (!assertPlainFilename(filename)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const tenantId = c.get("tenant_id") as number;
    const key = `audits/tenant-${tenantId}/${filename}`;

    const obj = await storageGetStream(key);
    if (!obj) {
      return c.json({ error: "Audit file not found" }, 404);
    }

    return new Response(obj.stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
