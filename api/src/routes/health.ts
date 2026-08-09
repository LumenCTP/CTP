import { Hono } from "hono";
import { getDb } from "../db";

const app = new Hono();

// ── Health ──────────────────────────────────────────────

app.get("/api/health", (c) => {
  try {
    const db = getDb();
    // Verify DB is alive with a simple query
    db.query("SELECT 1").get();
    return c.json({ status: "ok", db: "connected" });
  } catch (err) {
    return c.json({ status: "error", db: "disconnected", error: String(err) }, 500);
  }
});

export default app;
