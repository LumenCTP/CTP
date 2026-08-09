import { Hono } from "hono";
import { getDb } from "../db";

const app = new Hono();

// ── Support Messages ─────────────────────────────────────
app.post("/api/support/ask", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "Message is required" }, 400);
  const db = getDb();
  const result = db.query(`INSERT INTO support_messages (tenant_id, user_id, message, context) VALUES ($tid, $uid, $message, $context)`).run({ $tid: c.get("tenant_id"), $uid: c.get("user").user_id, $message: message, $context: typeof body.context === "string" ? body.context.slice(0, 120) : null });
  const row = db.query("SELECT id, message, status, created_at FROM support_messages WHERE id = $id").get({ $id: Number(result.lastInsertRowid) });
  return c.json(row, 201);
});

app.get("/api/support/messages", (c) => {
  const rows = getDb().query("SELECT id, message, context, status, created_at, reply_text, replied_at, replied_by FROM support_messages WHERE tenant_id = $tid ORDER BY created_at DESC, id DESC").all({ $tid: c.get("tenant_id") });
  return c.json(rows);
});

app.post("/api/support/reply", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = Number(body.message_id);
  const reply = typeof body.reply_text === "string" ? body.reply_text.trim() : "";
  const by = typeof body.replied_by === "string" ? body.replied_by.trim() : "";
  if (!Number.isInteger(id) || !reply || !by) return c.json({ error: "message_id, reply_text, and replied_by are required" }, 400);
  const db = getDb();
  const result = db.query("UPDATE support_messages SET reply_text = $reply, status = 'closed', replied_at = datetime('now'), replied_by = $by WHERE id = $id AND tenant_id = $tid").run({ $reply: reply, $by: by, $id: id, $tid: c.get("tenant_id") });
  if (!result.changes) return c.json({ error: "Message not found" }, 404);
  return c.json({ success: true });
});

export default app;
