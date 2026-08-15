import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { requireQueueSecret } from "../middleware";
import { runBackupAndRetain, runRetentionOnly, computeRetention, BACKUP_PREFIX } from "../backups";
import { checkDeliveryWatchdog, gatherDeliveryHealth, getSchedulerState, shouldSendAlert } from "../scheduler";
import { storageList } from "../storage";

const app = new Hono();

// ── Ops endpoints (local-only by convention; require the shared queue secret) ──
// These are the manual triggers for the reliability machinery: a backup now,
// a retention pass, a watchdog dry-run, and a scheduler-state readout. They are
// NOT part of the tenant API — nothing here is reachable without X-Queue-Secret.

// POST /api/ops/backup — run the nightly backup job now (VACUUM INTO → R2 →
// retention). Mirrors exactly what the scheduler does at 03:00 ET.
app.post("/api/ops/backup", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    const result = await runBackupAndRetain();
    return c.json(result, result.ok ? 200 : 500);
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/ops/backup-retention — retention-only pass (list + compute + delete).
// body: { dry?: boolean } — dry=1 reports what WOULD be deleted without deleting.
app.post("/api/ops/backup-retention", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    let body: { dry?: unknown } = {};
    try { body = await c.req.json(); } catch { /* no body — run for real */ }
    const dry = body.dry === true || body.dry === 1;
    const existing = await storageList(BACKUP_PREFIX);
    if (dry) {
      const { keep, delete: toDelete } = computeRetention(existing, new Date());
      return c.json({ dry: true, existing: existing.length, would_keep: keep.length, would_delete: toDelete });
    }
    const { deleted } = await runRetentionOnly();
    return c.json({ dry: false, deleted });
  } catch (err) {
    return serverError(c, err);
  }
});

// GET /api/ops/backups — list objects currently under the backups/ prefix.
app.get("/api/ops/backups", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    return c.json({ prefix: BACKUP_PREFIX, keys: await storageList(BACKUP_PREFIX) });
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/ops/watchdog — run the delivery-failure watchdog.
// body: { dry?: boolean } — dry=1 reports the health signals + what WOULD have
// been sent WITHOUT sending (no email, no rate-limit marker update).
app.post("/api/ops/watchdog", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    let body: { dry?: unknown } = {};
    try { body = await c.req.json(); } catch { /* no body — run for real */ }
    const dry = body.dry === true || body.dry === 1;
    if (dry) {
      const db = getDb();
      const health = gatherDeliveryHealth(db);
      const wouldSend: string[] = [];
      if (health.emailErrorCount24h > 0 && shouldSendAlert(getSchedulerState(db, "last_alert_email_errors"))) wouldSend.push("email_errors");
      if (health.staleQueueCount > 0 && shouldSendAlert(getSchedulerState(db, "last_alert_queue_stale"))) wouldSend.push("queue_stale");
      return c.json({ dry: true, health, would_send: wouldSend });
    }
    const result = await checkDeliveryWatchdog();
    return c.json(result);
  } catch (err) {
    return serverError(c, err);
  }
});

// GET /api/ops/scheduler-state — persisted scheduler markers (read-only).
app.get("/api/ops/scheduler-state", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    const db = getDb();
    const rows = db.query("SELECT key, value, updated_at FROM scheduler_state ORDER BY key").all();
    return c.json({ state: rows });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
