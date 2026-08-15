import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { storagePut, storageGet, storageDelete } from "../storage";
import { logAudit } from "../middleware";

const app = new Hono();

// ── Per-tenant company logo (TopBar branding) ────────────────────────────
// Logo bytes live in object storage under logos/tenant-<id>.<ext> (tenant
// scoped); the tenants.logo_key column holds the current key so the upload is
// an overwrite (old object is deleted). All routes resolve the tenant from the
// JWT via the shared requireAuth + requireTenant middleware (TENANT_DATA_PATHS).
const MAX_LOGO_BYTES = 1 * 1024 * 1024; // ~1MB
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};
const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" };
const ALLOWED_EXT = /\.(png|jpe?g|svg)$/i;

function detectImageType(buf: Buffer): string | null {
  // PNG: 89 50 4E 47
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // SVG: text — look for the "<svg" marker in the first chunk
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf8").trimStart();
  if (/<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

// GET /api/tenant/logo — serve the tenant's logo image (auth-gated, tenant
// scoped). The SPA fetches it with its Bearer token and renders a blob URL.
app.get("/api/tenant/logo", async (c) => {
  try {
    const tenantId = c.get("tenant_id") as number;
    const db = getDb();
    const row = db.query("SELECT logo_key FROM tenants WHERE id = $id").get({ $id: tenantId }) as
      { logo_key: string | null } | undefined;
    const key = row?.logo_key;
    if (!key) return c.json({ error: "No logo uploaded" }, 404);
    const obj = await storageGet(key);
    if (!obj) return c.json({ error: "Logo not found" }, 404);
    const ext = key.split(".").pop() ?? "";
    const contentType = MIME_BY_EXT[ext] ?? obj.contentType ?? "application/octet-stream";
    c.header("Content-Type", contentType);
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(obj.data);
  } catch (err) {
    console.error("[tenant/logo GET]", err);
    return serverError(c, err);
  }
});

// POST /api/tenant/logo — upload/overwrite the tenant's logo (multipart,
// PNG/JPEG/SVG up to ~1MB). Replaces any previous logo for this tenant.
app.post("/api/tenant/logo", async (c) => {
  try {
    const tenantId = c.get("tenant_id") as number;
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File) || file.size === 0) {
      return c.json({ error: "A logo file is required (PNG, JPG, or SVG)" }, 400);
    }
    if (file.size > MAX_LOGO_BYTES) {
      return c.json({ error: "Logo must be 1MB or smaller" }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    // Content-based validation (magic bytes) — the browser/Bun multipart
    // Content-Type is not trustworthy, so the file's actual content decides.
    // A renamed non-image (e.g. a .png that is really a text file) is rejected.
    const sniffed = detectImageType(buf);
    const ext = sniffed ? EXT_BY_MIME[sniffed] : undefined;
    if (!ext) {
      return c.json({ error: "Logo must be a PNG, JPG, or SVG image" }, 400);
    }
    if (!ALLOWED_EXT.test(file.name || "")) {
      return c.json({ error: "Logo file must have a .png, .jpg, or .svg extension" }, 400);
    }
    const db = getDb();
    const old = db.query("SELECT logo_key FROM tenants WHERE id = $id").get({ $id: tenantId }) as
      { logo_key: string | null } | undefined;
    const key = `logos/tenant-${tenantId}.${ext}`;
    await storagePut(key, buf, sniffed);
    db.query("UPDATE tenants SET logo_key = $key WHERE id = $id").run({ $key: key, $id: tenantId });
    // Overwrite semantics — drop the previous object if it was a different key
    // (e.g. the tenant switched from .png to .svg).
    if (old?.logo_key && old.logo_key !== key) {
      try {
        await storageDelete(old.logo_key);
      } catch (err) {
        console.error(`[tenant/logo] failed to delete old object ${old.logo_key}`, err);
      }
    }
    logAudit(db, "tenant", tenantId, "logo_updated", { logo_key: key });
    return c.json({ logo_url: "/api/tenant/logo", logo_key: key }, 200);
  } catch (err) {
    console.error("[tenant/logo POST]", err);
    return serverError(c, err);
  }
});

export default app;
