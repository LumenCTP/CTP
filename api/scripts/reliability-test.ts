/**
 * Reliability regression test (2026-08-15, owner directive "make it failproof").
 * Runs against in-memory SQLite DBs only — never touches the live API database —
 * and verifies the persistence/dedup/watchdog/backup-retention logic that the
 * scheduler and ops endpoints rely on.
 *
 * Run: bun run scripts/reliability-test.ts   (exits non-zero on any failure)
 */

import { Database } from "bun:sqlite";
import {
  getSchedulerState,
  setSchedulerState,
  weeklyAlreadySent,
  markWeeklySent,
  gatherDeliveryHealth,
  shouldSendAlert,
  buildDeliveryAlertEmail,
  nyWallClock,
} from "../src/scheduler";
import { computeRetention, parseBackupKey, BACKUP_PREFIX } from "../src/backups";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── Test DB fixture ─────────────────────────────────────
function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scheduler_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE weekly_email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, payment_week_start TEXT NOT NULL, payment_week_end TEXT NOT NULL, approved_count INTEGER DEFAULT 0, hold_count INTEGER DEFAULT 0, review_count INTEGER DEFAULT 0, sent_to TEXT, sent_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'sent');
    CREATE TABLE email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, vendor_id INTEGER, email_type TEXT NOT NULL, recipient_email TEXT NOT NULL, subject TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'queued', error_message TEXT);
    CREATE TABLE outgoing_email_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_email TEXT NOT NULL, subject TEXT NOT NULL, html_body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  return db;
}

console.log("== scheduler_state persistence ==");
{
  const db = makeDb();
  check("get on empty table returns null", getSchedulerState(db, "last_weekly_check_date") === null);
  setSchedulerState(db, "last_weekly_check_date", "2026-08-17");
  check("set then get round-trip", getSchedulerState(db, "last_weekly_check_date") === "2026-08-17");
  setSchedulerState(db, "last_weekly_check_date", "2026-08-24");
  check("upsert overwrites value", getSchedulerState(db, "last_weekly_check_date") === "2026-08-24");
  check("distinct keys independent", getSchedulerState(db, "last_daily_renewal_date") === null);
}

console.log("== weekly per-client dedup (belt and braces) ==");
{
  const db = makeDb();
  check("no row yet → not sent", !weeklyAlreadySent(db, 84, "2026-08-17"));
  markWeeklySent(db, 84, "2026-08-17", "2026-08-23", { approved: 5, hold: 1, review: 2 }, "a@b.com, c@d.com");
  check("row written → already sent", weeklyAlreadySent(db, 84, "2026-08-17"));
  check("different Monday → not sent", !weeklyAlreadySent(db, 84, "2026-08-24"));
  check("different tenant → not sent", !weeklyAlreadySent(db, 17, "2026-08-17"));
  const row = db.query("SELECT approved_count, hold_count, review_count, status, sent_to FROM weekly_email_log WHERE tenant_id=84 AND payment_week_start='2026-08-17'").get() as Record<string, unknown>;
  check("counts + status recorded", row.approved_count === 5 && row.hold_count === 1 && row.review_count === 2 && row.status === "sent");
}

console.log("== backup retention (30 daily + 12 monthly) ==");
{
  check("parseBackupKey valid", parseBackupKey("backups/cleartopay-2026-08-15.db") === "2026-08-15");
  check("parseBackupKey rejects garbage", parseBackupKey("backups/other.db") === null);
  check("BACKUP_PREFIX", BACKUP_PREFIX === "backups/");

  const keys: string[] = [];
  // 45 consecutive dailies ending 2026-08-15
  const start = new Date(Date.UTC(2026, 6, 2)); // 2026-07-02
  for (let i = 0; i < 45; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    keys.push(`backups/cleartopay-${d.toISOString().slice(0, 10)}.db`);
  }
  keys.push("backups/cleartopay-2025-12-01.db", "backups/cleartopay-2025-08-01.db", "backups/cleartopay-2025-07-15.db", "backups/junk.db");

  const { keep, delete: toDelete } = computeRetention(keys, new Date("2026-08-15T12:00:00Z"));
  check("keep count = 30 daily + 2 monthly = 32", keep.length === 32, keep.length);
  check("newest 30 kept", keep.includes("backups/cleartopay-2026-08-15.db") && keep.includes("backups/cleartopay-2026-07-18.db"));
  check("dailies outside newest-30 deleted (07-03..07-16)", toDelete.includes("backups/cleartopay-2026-07-03.db") && toDelete.includes("backups/cleartopay-2026-07-16.db"));
  check("2026-07-02 kept as July's monthly first", keep.includes("backups/cleartopay-2026-07-02.db"));
  check("monthly 2025-12-01 kept", keep.includes("backups/cleartopay-2025-12-01.db"));
  check("2025-08-01 deleted (13 months back, outside 12-month window)", toDelete.includes("backups/cleartopay-2025-08-01.db"));
  check("old 2025-07-15 deleted (13 months back)", toDelete.includes("backups/cleartopay-2025-07-15.db"));
  check("junk key deleted", toDelete.includes("backups/junk.db"));
  check("every key accounted for", keep.length + toDelete.length === keys.length);

  // Fewer than 30 dailies → all kept
  const few = ["backups/cleartopay-2026-08-15.db", "backups/cleartopay-2026-08-14.db"];
  const fewResult = computeRetention(few, new Date("2026-08-15T12:00:00Z"));
  check("few dailies → all kept", fewResult.keep.length === 2 && fewResult.delete.length === 0);
}

console.log("== NY wall clock (DST) ==");
{
  const summer = nyWallClock(new Date("2026-08-17T11:00:00Z"));
  check("Aug 17 11:00Z → Mon 07:00 EDT", summer.dow === 1 && summer.hour === 7 && summer.day === 17, summer);
  const winter = nyWallClock(new Date("2026-11-02T11:00:00Z"));
  check("Nov 2 11:00Z → Mon 06:00 EST", winter.dow === 1 && winter.hour === 6 && winter.day === 2, winter);
  const sat = nyWallClock(new Date("2026-08-15T17:00:00Z"));
  check("Aug 15 17:00Z → Sat 13:00 EDT", sat.dow === 6 && sat.hour === 13, sat);
}

console.log("== delivery-failure watchdog ==");
{
  const db = makeDb();
  const clean = gatherDeliveryHealth(db);
  check("clean state → no signals", clean.emailErrorCount24h === 0 && clean.staleQueueCount === 0);

  db.query(`INSERT INTO email_log (email_type, recipient_email, subject, status, error_message, sent_at)
            VALUES ('weekly_report', 'client@x.com', 'Weekly Report', 'error', 'R2 PUT failed', datetime('now', '-2 hours'))`).run();
  db.query(`INSERT INTO email_log (email_type, recipient_email, subject, status, error_message, sent_at)
            VALUES ('renewal_reminder', 'agent@x.com', 'Reminder', 'error', 'boom', datetime('now', '-30 hours'))`).run();
  db.query(`INSERT INTO outgoing_email_queue (recipient_email, subject, html_body, status, error_message, created_at)
            VALUES ('client@x.com', 'Weekly', '<p>x</p>', 'queued', NULL, datetime('now', '-40 minutes'))`).run();
  db.query(`INSERT INTO outgoing_email_queue (recipient_email, subject, html_body, status, created_at)
            VALUES ('client@x.com', 'Fresh', '<p>x</p>', 'queued', datetime('now', '-2 minutes'))`).run();

  const h = gatherDeliveryHealth(db);
  check("1 error in last 24h (30h-old excluded)", h.emailErrorCount24h === 1, h.emailErrorCount24h);
  check("oldest error surfaced", h.oldestEmailError?.recipient_email === "client@x.com" && h.oldestEmailError?.subject === "Weekly Report");
  check("1 stale queue row (2-min-old excluded)", h.staleQueueCount === 1, h.staleQueueCount);
  check("oldest stale row surfaced", h.oldestStaleQueue?.subject === "Weekly" && h.oldestStaleQueue?.created_at != null);

  const email = buildDeliveryAlertEmail(h);
  check("alert subject carries counts", email.subject.includes("1 error(s), 1 stale queued"), email.subject);
  check("alert body mentions oldest error + queue", email.body.includes("Weekly Report") && email.body.includes("stuck in the outbound queue"));

  check("shouldSendAlert: never sent → true", shouldSendAlert(null) === true);
  const now = new Date("2026-08-15T12:00:00Z");
  check("shouldSendAlert: sent 59 min ago → false", shouldSendAlert(new Date(now.getTime() - 59 * 60000).toISOString(), now) === false);
  check("shouldSendAlert: sent 61 min ago → true", shouldSendAlert(new Date(now.getTime() - 61 * 60000).toISOString(), now) === true);
  check("shouldSendAlert: garbage timestamp → true", shouldSendAlert("not-a-date", now) === true);
}

if (failures === 0) {
  console.log("\nAll reliability checks passed ✅");
} else {
  console.error(`\n${failures} reliability check(s) FAILED ❌`);
  process.exit(1);
}
