import { Hono } from "hono";
import { getDb } from "../db";
import { storageProbe, isStorageConfigured } from "../storage";
import { graphMailConfigured } from "../graph-mail";
import { smtpConfigured } from "../smtp";
import { getSchedulerState } from "../scheduler";

const app = new Hono();

// ── Health ──────────────────────────────────────────────

// GET /api/health — enriched liveness + reliability checks.
//
// Backward-compatible shape: {"status":"ok","db":"connected"} plus a new
// top-level `checks` object an external uptime monitor can page on:
//   db            — SELECT 1
//   storage       — R2 reachability (cheap HEAD probe; local mode always ok)
//   email         — which delivery path is active (graph/smtp/queue) + config presence
//   email_queue   — outgoing_email_queue depth + oldest row age
//   email_log     — error count (last 24h)
//   scheduler     — persisted last-run markers (scheduler_state)
// The R2 probe runs with a short timeout so a hung object store never blocks
// the monitor. status stays "ok"/"error" based on the DB only (backward compat);
// individual checks carry their own ok flag for granular alerting.
app.get("/api/health", async (c) => {
  try {
    const db = getDb();
    // Verify DB is alive with a simple query
    db.query("SELECT 1").get();

    // R2 probe (5s cap).
    let storageOk = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      storageOk = await storageProbe(controller.signal);
      clearTimeout(timer);
    } catch {
      storageOk = false;
    }

    // Queue depth + oldest row age (minutes).
    const queueDepthRow = db.query("SELECT COUNT(*) AS c FROM outgoing_email_queue WHERE status IN ('queued','failed')").get() as { c: number };
    const oldestQueueRow = db.query(
      `SELECT ROUND((julianday('now') - julianday(created_at)) * 24 * 60) AS age_minutes
       FROM outgoing_email_queue WHERE status IN ('queued','failed') ORDER BY created_at ASC LIMIT 1`,
    ).get() as { age_minutes: number | null } | undefined;

    // email_log errors in the last 24h.
    const errorRow = db.query(
      "SELECT COUNT(*) AS c FROM email_log WHERE status = 'error' AND sent_at >= datetime('now', '-24 hours')",
    ).get() as { c: number };

    // Scheduler last-run markers.
    const scheduler = {
      last_weekly_check_date: getSchedulerState(db, "last_weekly_check_date"),
      last_monthly_check_date: getSchedulerState(db, "last_monthly_check_date"),
      last_daily_renewal_date: getSchedulerState(db, "last_daily_renewal_date"),
      last_backup_date: getSchedulerState(db, "last_backup_date"),
    };

    const graph = graphMailConfigured();
    const smtp = smtpConfigured();

    return c.json({
      status: "ok",
      db: "connected",
      checks: {
        db: { ok: true },
        storage: {
          ok: storageOk,
          mode: isStorageConfigured() ? "r2" : "local",
        },
        email: {
          path: graph ? "graph" : smtp ? "smtp" : "queue",
          graph_configured: graph,
          smtp_configured: smtp,
        },
        email_queue: {
          depth: queueDepthRow.c,
          oldest_age_minutes: oldestQueueRow?.age_minutes ?? null,
        },
        email_log: {
          errors_24h: errorRow.c,
        },
        scheduler,
      },
    });
  } catch (err) {
    // Opaque failure shape — never expose the DB engine or the raw error.
    console.error("[health] db check failed:", err);
    return c.json({ status: "error" }, 500);
  }
});

export default app;
