import { Hono } from "hono";
import { getDb } from "../db";
import { requireAuth, requireAdmin, logAudit } from "../middleware";

const app = new Hono();

// ── Admin Support Inbox (Accounts & Questions review) ─────────────
// These endpoints are admin-only (JWT role = 'admin') and operate ACROSS
// all tenants — unlike /api/support/* which is tenant-scoped to the caller.
// They are intentionally NOT in TENANT_DATA_PATHS (no requireTenant), so an
// admin can review and answer questions for every account in the book.

// GET /api/admin/support/messages
// List support questions across all accounts.
// Query params:
//   status    = "unanswered" (default) | "all"
//   tenant_id = optional: restrict to one tenant's full question history
// Order: unanswered (status='open') first, then newest first.
app.get("/api/admin/support/messages", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const status = c.req.query("status") || "unanswered";
  const tenantIdRaw = c.req.query("tenant_id");
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (status === "unanswered") {
    where.push("sm.status = 'open'");
  } else if (status !== "all") {
    return c.json({ error: "status must be 'unanswered' or 'all'" }, 400);
  }
  if (tenantIdRaw) {
    const tid = Number(tenantIdRaw);
    if (!Number.isInteger(tid) || tid <= 0) return c.json({ error: "Invalid tenant_id" }, 400);
    where.push("sm.tenant_id = $tenant_id");
    params.$tenant_id = tid;
  }
  const sql = `
    SELECT sm.id, sm.tenant_id, t.name AS tenant_name,
           sm.user_id, u.full_name AS sender_name, u.email AS sender_email,
           sm.message, sm.context, sm.status, sm.created_at,
           sm.reply_text, sm.replied_at, sm.replied_by
    FROM support_messages sm
    JOIN tenants t ON t.id = sm.tenant_id
    LEFT JOIN users u ON u.id = sm.user_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY CASE WHEN sm.status = 'open' THEN 0 ELSE 1 END,
             sm.created_at DESC, sm.id DESC
  `;
  const rows = db.query(sql).all(params);
  return c.json({ messages: rows, count: rows.length });
});

// POST /api/admin/support/reply
// Admin replies to ANY tenant's support question (not just their own tenant).
// The reply is written onto the message row (reply_text, status='closed',
// replied_at, replied_by = "<admin name> (Admin)"), so it shows up in the
// client's own thread via their existing GET /api/support/messages.
app.post("/api/admin/support/reply", requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = Number(body.message_id);
  const reply = typeof body.reply_text === "string" ? body.reply_text.trim() : "";
  if (!Number.isInteger(id) || !reply) {
    return c.json({ error: "message_id and reply_text are required" }, 400);
  }
  const db = getDb();
  const admin = db.query("SELECT full_name FROM users WHERE id = $id").get({ $id: c.get("user").user_id }) as { full_name: string } | undefined;
  const repliedBy = admin?.full_name ? `${admin.full_name} (Admin)` : "Admin";
  const row = db.query("SELECT id, tenant_id FROM support_messages WHERE id = $id").get({ $id: id }) as { id: number; tenant_id: number } | undefined;
  if (!row) return c.json({ error: "Message not found" }, 404);
  db.query(`
    UPDATE support_messages
    SET reply_text = $reply, status = 'closed', replied_at = datetime('now'), replied_by = $by
    WHERE id = $id
  `).run({ $reply: reply, $by: repliedBy, $id: id });
  logAudit(db, "support_message", id, "admin_replied", { reply_text: reply, tenant_id: row.tenant_id });
  const updated = db.query(`
    SELECT sm.id, sm.tenant_id, t.name AS tenant_name,
           sm.user_id, u.full_name AS sender_name, u.email AS sender_email,
           sm.message, sm.context, sm.status, sm.created_at,
           sm.reply_text, sm.replied_at, sm.replied_by
    FROM support_messages sm
    JOIN tenants t ON t.id = sm.tenant_id
    LEFT JOIN users u ON u.id = sm.user_id
    WHERE sm.id = $id
  `).get({ $id: id });
  return c.json({ message: updated });
});

export default app;
