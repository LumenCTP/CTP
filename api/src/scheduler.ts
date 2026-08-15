import { getDb } from "./db";
import { slugFromToAddress } from "./lib/inbox";
import { gatherReportData, generatePdfReport, generateExcelReport } from "./reports";
import {
  sendEmail,
  buildWeeklyReportEmail,
  buildMonthlyReportEmail,
  buildRenewalReminderEmail,
  parseRecipients,
  hasReminderBeenSent,
  markReminderSent,
} from "./email";
import { calculatePaymentWeek, calculateAllCompliance, calculateClientCompliance } from "./compliance";
import { calculateCommissions, runPartnerPayouts } from "./commissions";
import { ingestDocumentAttachment } from "./routes/documents";
import { hasPriorYearW9 } from "./mapping";
import { QUEUE_SECRET } from "./secrets";
import { storagePut } from "./storage";
import { runBackupAndRetain } from "./backups";

// ── State ──────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let inboxPollInterval: ReturnType<typeof setInterval> | null = null;

function inboxPollTick(): void {
  try {
    const db = getDb();
    const rows = db.query("SELECT id, raw_email_json FROM inbox_queue WHERE processed = 0 ORDER BY id LIMIT 5").all() as Array<{ id: number; raw_email_json: string }>;
    if (rows.length === 0) return;
    console.log(`[inbox-poll] Processing ${rows.length} queued emails`);
    for (const row of rows) {
      try {
        const email = JSON.parse(row.raw_email_json);
        // Extract slug from to_address — supports both the current
        // "<Slug>@cleartopayconstruction.com" format and the legacy
        // "…+<slug>@ctomail.io" +subaddress format.
        const toAddr = email.to_address || "";
        const tenantSlug = slugFromToAddress(toAddr) || null;

        if (!tenantSlug) {
          db.run("UPDATE inbox_queue SET processed = 1, processed_at = datetime('now'), error = 'no slug in to_address' WHERE id = ?", [row.id]);
          continue;
        }

        const tenant = db.query("SELECT id FROM tenants WHERE inbox_slug = ? COLLATE NOCASE").get(tenantSlug) as { id: number } | undefined;
        if (!tenant) {
          db.run("UPDATE inbox_queue SET processed = 1, processed_at = datetime('now'), error = 'tenant not found' WHERE id = ?", [row.id]);
          continue;
        }

        // Process attachments
        const attachments = email.attachments || [];
        for (const a of attachments) {
          // Convert base64 to buffer
          const content = Buffer.from(a.content_base64, 'base64');
          ingestDocumentAttachment({
            db,
            tenantId: tenant.id,
            filename: a.filename,
            content: new Uint8Array(content),
            contentType: a.content_type,
            senderName: email.from_name,
            senderEmail: email.from_address
          }).catch(err => console.error("[inbox-poll] ingest error:", err));
        }
        db.run("UPDATE inbox_queue SET processed = 1, processed_at = datetime('now') WHERE id = ?", [row.id]);
      } catch (err) {
        console.error("[inbox-poll] row error:", err);
        db.run("UPDATE inbox_queue SET processed = 1, processed_at = datetime('now'), error = ? WHERE id = ?", [String(err), row.id]);
      }
    }
  } catch (err) {
    console.error("[inbox-poll] tick error:", err);
  }
}

// ── Persisted scheduler state ────────────────────────────
// Last-run markers live in the scheduler_state table (see db.ts) so an API
// restart can never re-fire the weekly/monthly/daily batches (double-send).
// The in-memory cache is ONLY a fast path — every decision consults/updates
// the DB row, so a restart always sees the true last-run value.
const stateCache = new Map<string, string | null>();

export function getSchedulerState(db: ReturnType<typeof getDb>, key: string): string | null {
  if (stateCache.has(key)) return stateCache.get(key)!;
  const row = db.query("SELECT value FROM scheduler_state WHERE key = ?").get(key) as { value: string } | undefined;
  const v = row?.value ?? null;
  stateCache.set(key, v);
  return v;
}

export function setSchedulerState(db: ReturnType<typeof getDb>, key: string, value: string): void {
  db.query(
    `INSERT INTO scheduler_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
  stateCache.set(key, value);
}

/**
 * Wall-clock time in America/New_York (full-ICU Intl — DST-correct year-round).
 * The weekly 7:00 AM ET window uses this instead of a hardcoded UTC offset,
 * which drifted by an hour across DST transitions.
 */
export function nyWallClock(now: Date = new Date()): { year: number; month: number; day: number; hour: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const h = Number(get("hour"));
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour: h === 24 ? 0 : h, // ICU h23 quirk: midnight can render as "24"
    dow: dowMap[get("weekday")] ?? -1,
  };
}

// Weekly per-client dedup backstop: weekly_email_log is consulted BEFORE every
// weekly report send and written AFTER a successful send, so a client can never
// receive two reports for the same payment week — even if scheduler_state is
// lost entirely (belt and braces).
export function weeklyAlreadySent(db: ReturnType<typeof getDb>, tenantId: number, monday: string): boolean {
  return !!db.query("SELECT id FROM weekly_email_log WHERE tenant_id = ? AND payment_week_start = ? LIMIT 1").get(tenantId, monday);
}

export function markWeeklySent(
  db: ReturnType<typeof getDb>,
  tenantId: number,
  monday: string,
  weekEnd: string,
  counts: { approved: number; hold: number; review: number },
  sentTo: string,
): void {
  db.query(
    `INSERT INTO weekly_email_log (tenant_id, payment_week_start, payment_week_end, approved_count, hold_count, review_count, sent_to, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')`,
  ).run(tenantId, monday, weekEnd, counts.approved, counts.hold, counts.review, sentTo);
}

// ── Scheduler Tick ─────────────────────────────────────

async function tick(): Promise<void> {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  await checkWeekly(now, todayStr);
  await checkMonthly(now, todayStr);
  checkRenewals(now, todayStr);
  // Nightly offsite backup (3:00–5:59 AM ET, once per day). Failures are logged
  // by runBackupAndRetain and never crash the tick.
  await checkBackup(now);
  // Daily: auto-create partner commissions for the current billing period
  // (idempotent per partner/tenant/period). Per-tenant failures never abort
  // the rest of the job.
  try {
    calculateCommissions(now);
  } catch (err) {
    console.error("[scheduler] Commission calculation error:", err);
  }
  // End-of-month: aggregate approved commissions into one pending payout per
  // partner (once per calendar month), email the partner, and attempt the
  // transfer seam (delegation B). No-op unless day 30 / last day of month.
  try {
    runPartnerPayouts(now);
  } catch (err) {
    console.error("[scheduler] Partner payout run error:", err);
  }
}

// ── Weekly Report Check ────────────────────────────────

async function checkWeekly(now: Date, todayStr: string): Promise<void> {
  // Weekly Clear-to-Pay report window: Monday from 7:00 AM ET
  // (America/New_York — DST-correct year-round, unlike the old hardcoded
  // 11:00 UTC which became 6:00 AM EST in winter). The persisted marker plus
  // the per-client weekly_email_log guard make the whole Monday window
  // idempotent, so a restart after 7:00 AM ET cannot double-send.
  const ny = nyWallClock(now);
  if (ny.dow !== 1) return;
  if (ny.hour < 7) return;

  // Determine the Monday of this week (the weekly email always goes out on
  // Monday morning per the product spec — independent of each tenant's
  // payment-week start day, which only shapes the report's week window).
  const { week_start: monday } = calculatePaymentWeek("monday");

  const db = getDb();

  // Fast path + persisted marker: at most one weekly batch per Monday even
  // across restarts. Written AFTER the batch completes; the per-client
  // weekly_email_log rows below are the idempotency backstop, so a crash
  // mid-batch re-runs only the clients that were not yet sent.
  if (getSchedulerState(db, "last_weekly_check_date") === monday) return;

  console.log(`[scheduler] Monday ${monday} 07:00 AM ET (America/New_York) — generating weekly reports`);

  // Get all clients with weekly recipients configured
  const configs = db.query(`
    SELECT cec.client_id, cec.weekly_report_recipients, cl.name as client_name, cl.tenant_id as tenant_id
    FROM client_email_config cec
    JOIN clients cl ON cl.id = cec.client_id
    WHERE cec.weekly_report_recipients IS NOT NULL
      AND cec.weekly_report_recipients != ''
  `).all() as Array<{
    client_id: number;
    weekly_report_recipients: string;
    client_name: string;
    tenant_id: number | null;
  }>;

  // Track which clients had their compliance computed by the report loop so
  // the whole-tenant refresh below can skip tenants that were fully refreshed
  // (one compliance pass per vendor per run, instead of a client pass plus a
  // second whole-tenant pass over the same vendors).
  const coveredClientIds = new Set<number>();
  for (const config of configs) {
    try {
      // Belt-and-braces per-client dedup: never email a client twice for the
      // same payment week, even if scheduler_state is lost or the batch
      // re-runs after a crash. weekly_email_log is the source of truth for
      // what was actually delivered.
      if (config.tenant_id != null && weeklyAlreadySent(db, config.tenant_id, monday)) {
        console.log(`[scheduler] Weekly report already sent for client ${config.client_id} (tenant ${config.tenant_id}) for ${monday} — skipping`);
        continue;
      }

      console.log(`[scheduler] Generating weekly report for client ${config.client_id} (${config.client_name})`);

      const reportData = gatherReportData(config.client_id);
      coveredClientIds.add(config.client_id);
      const timestamp = Date.now();
      const clientSlug = config.client_name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);

      // Reports are written into the tenant's own key prefix so the download
      // route (routes/reports.ts) can serve strictly tenant-scoped files. The
      // storage layer maps this to data/reports/tenant-<id>/ in fallback mode.
      const tenantPrefix = `reports/tenant-${config.tenant_id ?? "unknown"}`;

      // Generate PDF
      const pdfFilename = `ClearToPay_${clientSlug}_${timestamp}.pdf`;
      const pdfDoc = generatePdfReport(reportData);
      const pdfBuffers: Buffer[] = [];
      for await (const chunk of pdfDoc) {
        pdfBuffers.push(Buffer.from(chunk));
      }
      await storagePut(`${tenantPrefix}/${pdfFilename}`, Buffer.concat(pdfBuffers), "application/pdf");

      // Generate Excel
      const xlsxFilename = `ClearToPay_${clientSlug}_${timestamp}.xlsx`;
      const xlsxBuffer = await generateExcelReport(reportData);
      await storagePut(`${tenantPrefix}/${xlsxFilename}`, xlsxBuffer,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

      // Both report files are persisted via the storage layer; the email only
      // references them by storage key (resolved to bytes at send time), so the
      // queue never carries the file payloads.
      const attachments = [
        { filename: pdfFilename, contentType: "application/pdf", storageKey: `${tenantPrefix}/${pdfFilename}` },
        { filename: xlsxFilename, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", storageKey: `${tenantPrefix}/${xlsxFilename}` },
      ];

      // Build email body
      const emailBody = buildWeeklyReportEmail(config.client_name, {
        approved_count: reportData.approved.length,
        review_count: reportData.review.length,
        hold_count: reportData.hold.length,
        expiring_count: reportData.expiring_during_week.length,
        missing_count: reportData.missing_docs.length,
        payment_week: reportData.payment_week,
        report_date: reportData.report_date,
      });

      const recipients = parseRecipients(config.weekly_report_recipients);
      const subject = `Clear-to-Pay Weekly Report — ${reportData.payment_week.week_start} to ${reportData.payment_week.week_end}`;

      await sendEmail(recipients, subject, emailBody, config.client_id, undefined, "weekly_report", attachments);
      // Record the delivery in weekly_email_log (idempotency backstop).
      if (config.tenant_id != null) {
        markWeeklySent(db, config.tenant_id, monday, reportData.payment_week.week_end, {
          approved: reportData.approved.length,
          hold: reportData.hold.length,
          review: reportData.review.length,
        }, recipients.join(", "));
      }
      console.log(`[scheduler] Weekly report sent for client ${config.client_id}`);
    } catch (err) {
      console.error(`[scheduler] Error generating weekly report for client ${config.client_id}:`, err);
      // Log error to email_log
      const db = getDb();
      const recipients = parseRecipients(config.weekly_report_recipients);
      for (const r of recipients) {
        db.query(`
          INSERT INTO email_log (client_id, email_type, recipient_email, subject, status, error_message)
          VALUES ($client_id, 'weekly_report', $recipient_email, $subject, 'error', $error_message)
        `).run({
          $client_id: config.client_id,
          $recipient_email: r,
          $subject: `Clear-to-Pay Weekly Report`,
          $error_message: String(err),
        });
      }
    }
  }

  // Whole-book refresh: recalculate accurate compliance for EVERY active tenant,
  // not just clients with weekly report recipients configured. Clients without
  // recipients never get a scheduled refresh otherwise. To avoid recomputing
  // vendors the report loop above already refreshed, only each tenant's
  // UNCOVERED clients are computed here (one compliance pass per vendor per
  // run). Each tenant is wrapped in try/catch so a single failure cannot kill
  // the job.
  const activeTenants = db.query(
    "SELECT id FROM tenants WHERE UPPER(subscription_status) IN ('ACTIVE', 'TRIAL')"
  ).all() as Array<{ id: number }>;
  for (const tenant of activeTenants) {
    try {
      const tenantClients = db.query("SELECT id FROM clients WHERE tenant_id = $tid").all({ $tid: tenant.id }) as Array<{ id: number }>;
      const uncovered = tenantClients.filter((cl) => !coveredClientIds.has(cl.id));
      // Defensive: vendors with NULL client_id are only reachable via a
      // whole-tenant scan. If any exist, fall back to calculateAllCompliance so
      // the old behavior is preserved exactly. (None exist in the data today.)
      const nullClientVendors = db.query("SELECT COUNT(*) as c FROM vendors WHERE tenant_id = $tid AND client_id IS NULL").get({ $tid: tenant.id }) as { c: number };
      if (uncovered.length === 0 && nullClientVendors.c === 0) {
        console.log(`[scheduler] Tenant ${tenant.id} already fully refreshed by weekly report run — skipping whole-tenant recompute`);
        continue;
      }
      let approved = 0;
      let review = 0;
      let hold = 0;
      let vendorCount = 0;
      if (nullClientVendors.c > 0) {
        const summary = calculateAllCompliance(tenant.id);
        approved = summary.approved;
        review = summary.review;
        hold = summary.hold;
        vendorCount = summary.vendor_count;
      }
      for (const cl of uncovered) {
        const summary = calculateClientCompliance(cl.id, tenant.id);
        approved += summary.approved;
        review += summary.review;
        hold += summary.hold;
        vendorCount += summary.vendor_count;
      }
      console.log(`[scheduler] Weekly compliance refresh for tenant ${tenant.id}: ${vendorCount} vendors (approved=${approved}, review=${review}, hold=${hold})`);
    } catch (err) {
      console.error(`[scheduler] Error refreshing compliance for tenant ${tenant.id}:`, err);
    }
  }
  // The delivery worker can pick these queued messages up immediately after the
  // weekly batch is created. The endpoint is local-only by convention and still
  // requires the shared queue secret.
  try {
    const port = process.env.PORT || "3001";
    const response = await fetch(`http://127.0.0.1:${port}/api/emails/process-queue`, {
      method: "POST",
      headers: { "X-Queue-Secret": QUEUE_SECRET },
    });
    if (!response.ok) console.error(`[scheduler] Queue processing request failed: HTTP ${response.status}`);
    else console.log(`[scheduler] Queue processing requested (${(await response.json() as unknown[]).length} queued emails)`);
  } catch (err) {
    console.error("[scheduler] Queue processing request error:", err);
  }

  // Persist the completed-week marker LAST: the batch is done only now, and the
  // per-client weekly_email_log rows written above mean a crash at any earlier
  // point re-runs only the unsent clients on the next tick.
  setSchedulerState(db, "last_weekly_check_date", monday);
}

// ── Nightly Offsite Backup ──────────────────────────────

async function checkBackup(now: Date): Promise<void> {
  // Nightly window 03:00–05:59 AM ET with at-most-once-per-day semantics. If
  // the 03:00 attempt fails, the marker is not set, so 04:00/05:00 retry;
  // after a success (or at 06:00) the next attempt is tomorrow night.
  const ny = nyWallClock(now);
  if (ny.hour < 3 || ny.hour > 5) return;
  const db = getDb();
  const todayStr = `${ny.year}-${String(ny.month).padStart(2, "0")}-${String(ny.day).padStart(2, "0")}`;
  if (getSchedulerState(db, "last_backup_date") === todayStr) return;

  console.log(`[scheduler] Nightly backup ${todayStr} 03:00+ AM ET — starting`);
  try {
    const result = await runBackupAndRetain(now);
    if (result.ok) setSchedulerState(db, "last_backup_date", todayStr);
  } catch (err) {
    console.error(`[scheduler] Nightly backup error: ${String(err)}`);
  }
}

// ── Delivery-Failure Watchdog ───────────────────────────

export interface DeliveryHealth {
  emailErrorCount24h: number;
  oldestEmailError: { sent_at: string; recipient_email: string; subject: string; error_message: string | null } | null;
  staleQueueCount: number;
  oldestStaleQueue: { created_at: string; recipient_email: string; subject: string; error_message: string | null } | null;
}

/** Queries delivery health signals: email_log errors (24h) + stale queue rows. */
export function gatherDeliveryHealth(db: ReturnType<typeof getDb>): DeliveryHealth {
  const emailErrors = db.query(`
    SELECT sent_at, recipient_email, subject, error_message
    FROM email_log
    WHERE status = 'error' AND sent_at >= datetime('now', '-24 hours')
    ORDER BY sent_at ASC LIMIT 1
  `).get() as DeliveryHealth["oldestEmailError"];
  const errorCount = db.query(
    "SELECT COUNT(*) AS c FROM email_log WHERE status = 'error' AND sent_at >= datetime('now', '-24 hours')",
  ).get() as { c: number };
  const staleQueue = db.query(`
    SELECT created_at, recipient_email, subject, error_message
    FROM outgoing_email_queue
    WHERE status IN ('queued', 'failed') AND created_at <= datetime('now', '-15 minutes')
    ORDER BY created_at ASC LIMIT 1
  `).get() as DeliveryHealth["oldestStaleQueue"];
  const staleCount = db.query(
    "SELECT COUNT(*) AS c FROM outgoing_email_queue WHERE status IN ('queued', 'failed') AND created_at <= datetime('now', '-15 minutes')",
  ).get() as { c: number };
  return {
    emailErrorCount24h: errorCount.c,
    oldestEmailError: emailErrors ?? null,
    staleQueueCount: staleCount.c,
    oldestStaleQueue: staleQueue ?? null,
  };
}

/** True when the last alert for this category is absent or older than 1 hour. */
export function shouldSendAlert(lastAlertAt: string | null, now: Date = new Date()): boolean {
  if (!lastAlertAt) return true;
  const last = new Date(lastAlertAt.endsWith("Z") ? lastAlertAt : lastAlertAt + "Z");
  if (isNaN(last.getTime())) return true;
  return now.getTime() - last.getTime() >= 60 * 60 * 1000;
}

// Internal alert recipient — owner by default; overridable so tests/other
// environments never reach a real mailbox.
const DELIVERY_ALERT_RECIPIENT = process.env.DELIVERY_ALERT_RECIPIENT || "bosleyjustin@yahoo.com";

export function buildDeliveryAlertEmail(health: DeliveryHealth): { subject: string; body: string } {
  const parts: string[] = [];
  if (health.emailErrorCount24h > 0) {
    parts.push(`• ${health.emailErrorCount24h} email delivery error(s) in the last 24 hours.`);
    if (health.oldestEmailError) {
      parts.push(`  Oldest: "${health.oldestEmailError.subject}" → ${health.oldestEmailError.recipient_email} at ${health.oldestEmailError.sent_at} UTC` +
        (health.oldestEmailError.error_message ? ` (${health.oldestEmailError.error_message.slice(0, 300)})` : ""));
    }
  }
  if (health.staleQueueCount > 0) {
    parts.push(`• ${health.staleQueueCount} email(s) stuck in the outbound queue longer than 15 minutes.`);
    if (health.oldestStaleQueue) {
      parts.push(`  Oldest: "${health.oldestStaleQueue.subject}" → ${health.oldestStaleQueue.recipient_email} queued at ${health.oldestStaleQueue.created_at} UTC` +
        (health.oldestStaleQueue.error_message ? ` (${health.oldestStaleQueue.error_message.slice(0, 300)})` : ""));
    }
  }
  const body = parts.join("\n");
  const subject = `[ClearToPay] Delivery failures — ${health.emailErrorCount24h} error(s), ${health.staleQueueCount} stale queued`;
  return { subject, body };
}

/**
 * Watchdog: sends at most one internal alert per category per hour (rate
 * markers live in scheduler_state). Never throws — alerting must not take the
 * scheduler down. Returns which alerts were sent so the ops endpoint can
 * surface it.
 */
export async function checkDeliveryWatchdog(now: Date = new Date()): Promise<{ alertsSent: string[]; health: DeliveryHealth }> {
  const db = getDb();
  const health = gatherDeliveryHealth(db);
  const alertsSent: string[] = [];

  if (health.emailErrorCount24h > 0 && shouldSendAlert(getSchedulerState(db, "last_alert_email_errors"), now)) {
    try {
      const { subject, body } = buildDeliveryAlertEmail(health);
      await sendEmail([DELIVERY_ALERT_RECIPIENT], subject, body, undefined, undefined, "internal_alert");
      setSchedulerState(db, "last_alert_email_errors", now.toISOString());
      alertsSent.push("email_errors");
    } catch (err) {
      console.error(`[watchdog] Alert send failed (email_errors): ${String(err)}`);
    }
  }
  if (health.staleQueueCount > 0 && shouldSendAlert(getSchedulerState(db, "last_alert_queue_stale"), now)) {
    try {
      const { subject, body } = buildDeliveryAlertEmail(health);
      await sendEmail([DELIVERY_ALERT_RECIPIENT], subject, body, undefined, undefined, "internal_alert");
      setSchedulerState(db, "last_alert_queue_stale", now.toISOString());
      alertsSent.push("queue_stale");
    } catch (err) {
      console.error(`[watchdog] Alert send failed (queue_stale): ${String(err)}`);
    }
  }
  return { alertsSent, health };
}

// ── Monthly Report Check ───────────────────────────────

async function checkMonthly(now: Date, todayStr: string): Promise<void> {
  // 1st of the month, 6:00 AM UTC
  if (now.getUTCDate() !== 1) return;
  if (now.getUTCHours() < 6) return;

  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

  const db = getDb();
  // Persisted marker (written BEFORE the batch, preserving the existing
  // at-most-once-per-month semantics even across restarts).
  if (getSchedulerState(db, "last_monthly_check_date") === monthKey) return;

  console.log(`[scheduler] 1st of month (${monthKey}) 06:00+ UTC — generating monthly reports`);
  setSchedulerState(db, "last_monthly_check_date", monthKey);

  const configs = db.query(`
    SELECT cec.client_id, cec.monthly_report_recipients, cl.name as client_name, cl.tenant_id as tenant_id
    FROM client_email_config cec
    JOIN clients cl ON cl.id = cec.client_id
    WHERE cec.monthly_report_recipients IS NOT NULL
      AND cec.monthly_report_recipients != ''
  `).all() as Array<{
    client_id: number;
    monthly_report_recipients: string;
    client_name: string;
    tenant_id: number | null;
  }>;

  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  for (const config of configs) {
    try {
      console.log(`[scheduler] Generating monthly report for client ${config.client_id} (${config.client_name})`);

      // Recalculate accurate compliance first so the counts below are never
      // based on stale (or COI-only) cached values.
      if (config.tenant_id) calculateClientCompliance(config.client_id, config.tenant_id);
      // Get compliance summary for this client
      const vendors = db.query(`
        SELECT v.id, cs.payment_status
        FROM vendors v
        LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
        WHERE v.client_id = $client_id
      `).all({ $client_id: config.client_id }) as Array<{ id: number; payment_status: string | null }>;

      const totalVendors = vendors.length;
      const approved = vendors.filter((v) => v.payment_status === "approved").length;
      const review = vendors.filter((v) => v.payment_status === "review").length;
      const hold = vendors.filter((v) => v.payment_status === "hold" || !v.payment_status).length;
      const compliancePercentage = totalVendors > 0 ? (approved / totalVendors) * 100 : 0;

      const emailBody = buildMonthlyReportEmail(config.client_name, {
        compliance_percentage: compliancePercentage,
        total_vendors: totalVendors,
        approved,
        review,
        hold,
        month: monthNames[now.getUTCMonth()],
        year: now.getUTCFullYear(),
      });

      const recipients = parseRecipients(config.monthly_report_recipients);
      const subject = `Monthly Compliance Report — ${monthNames[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

      sendEmail(recipients, subject, emailBody, config.client_id, undefined, "monthly_report");
      console.log(`[scheduler] Monthly report sent for client ${config.client_id}`);
    } catch (err) {
      console.error(`[scheduler] Error generating monthly report for client ${config.client_id}:`, err);
      const db = getDb();
      const recipients = parseRecipients(config.monthly_report_recipients);
      for (const r of recipients) {
        db.query(`
          INSERT INTO email_log (client_id, email_type, recipient_email, subject, status, error_message)
          VALUES ($client_id, 'monthly_report', $recipient_email, $subject, 'error', $error_message)
        `).run({
          $client_id: config.client_id,
          $recipient_email: r,
          $subject: `Monthly Compliance Report`,
          $error_message: String(err),
        });
      }
    }
  }
}

// ── Renewal Reminder Check ─────────────────────────────

function checkRenewals(now: Date, todayStr: string): void {
  const db = getDb();
  // Only run once per day — persisted across restarts. Written AFTER the scan
  // completes (the scan itself is idempotent via renewal_reminders_sent, so a
  // crash mid-scan just re-scans on the next tick without duplicating).
  if (getSchedulerState(db, "last_daily_renewal_date") === todayStr) return;

  // Get all clients with renewal reminders enabled
  const configs = db.query(`
    SELECT cec.client_id, cl.name as client_name, cl.tenant_id as tenant_id
    FROM client_email_config cec
    JOIN clients cl ON cl.id = cec.client_id
    WHERE cec.renewal_reminders_enabled = 1
  `).all() as Array<{ client_id: number; client_name: string; tenant_id: number | null }>;

  // Reminder windows: 30, 15, 7, 0 days before expiration
  const REMINDER_WINDOWS = [30, 15, 7, 0];

  for (const config of configs) {
    // Find all reviewed documents for this client's vendors that have expiration dates.
    // Recipient preference (per doc): producer_email (the agency/agent contact from
    // the top-right Producer block of a COI) first, falling back to sender_email
    // (the person who submitted the document). Manually-entered documents have no
    // sender_email, so the producer email is what makes them reachable. A doc with
    // NEITHER is skipped (no recipient to mail). The producer_email requirement was
    // previously a hard `sender_email IS NOT NULL` filter, which silently excluded
    // every manual-entry document — that filter is gone.
    const docs = db.query(`
      SELECT d.id as document_id, d.vendor_id, d.document_type, d.sender_email,
             de.expiration_date, de.producer_email, de.producer_name, v.name as vendor_name
      FROM documents d
      JOIN document_extractions de ON de.document_id = d.id
      JOIN vendors v ON v.id = d.vendor_id
      WHERE d.client_id = $client_id
        AND de.is_reviewed = 1
        AND de.expiration_date IS NOT NULL
        AND de.expiration_date != ''
    `).all({ $client_id: config.client_id }) as Array<{
      document_id: number;
      vendor_id: number;
      document_type: string;
      sender_email: string | null;
      expiration_date: string;
      producer_email: string | null;
      producer_name: string | null;
      vendor_name: string;
    }>;

    for (const doc of docs) {
      // Recipient selection — exact order: producer_email (COI agency/agent) →
      // sender_email (submitter). Neither → skip (no recipient; the doc gets no
      // reminder until a producer or sender email is recorded).
      const recipientEmail = (doc.producer_email ?? "").trim() || (doc.sender_email ?? "").trim();
      if (!recipientEmail) {
        console.log(`[scheduler] Renewal reminder skipped for document ${doc.document_id} (${doc.vendor_name} — ${doc.document_type}): no producer_email and no sender_email`);
        continue;
      }

      const expDate = new Date(doc.expiration_date + "T00:00:00Z");
      const diffMs = expDate.getTime() - now.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      // Check each reminder window
      for (const window of REMINDER_WINDOWS) {
        if (diffDays === window) {
          // Check if we already sent this reminder
          if (hasReminderBeenSent(doc.document_id, window)) {
            continue;
          }

          try {
            console.log(`[scheduler] Sending ${window}-day renewal reminder for document ${doc.document_id} (${doc.vendor_name} — ${doc.document_type}) → ${recipientEmail}`);

            const emailBody = buildRenewalReminderEmail(
              doc.vendor_name,
              doc.document_type,
              doc.expiration_date,
              window,
              config.tenant_id,
              doc.producer_name,
            );
            const outreach = hasPriorYearW9(db, doc.vendor_id, now.getFullYear() - 1)
              ? "Please submit an updated Certificate of Insurance (COI)."
              : "Please submit an updated Certificate of Insurance (COI) and a new W-9 form.";
            const emailBodyWithOutreach = `${emailBody}\n\n${outreach}`;

            const subject = `Reminder: ${doc.document_type} for ${doc.vendor_name} expires ${window === 0 ? "today" : `in ${window} days`}`;

            sendEmail(
              [recipientEmail],
              subject,
              emailBodyWithOutreach,
              config.client_id,
              doc.vendor_id,
              "renewal_reminder",
            );

            markReminderSent(doc.document_id, window);
            console.log(`[scheduler] Renewal reminder sent: doc ${doc.document_id}, window ${window} days`);
          } catch (err) {
            console.error(`[scheduler] Error sending renewal reminder for document ${doc.document_id}:`, err);
          }
        }
      }
    }
  }

  // Persist after the full scan completes.
  setSchedulerState(db, "last_daily_renewal_date", todayStr);
}

// ── Start / Stop ───────────────────────────────────────

let watchdogInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (schedulerInterval) return; // Already running

  console.log("[scheduler] Email scheduler started — checking every 60s");

  // Run an immediate tick on startup so we don't miss anything
  tick().catch((err) => console.error("[scheduler] Initial tick error:", err));

  schedulerInterval = setInterval(tick, 60_000);
  inboxPollTick();
  inboxPollInterval = setInterval(inboxPollTick, 5 * 60_000);

  // Delivery-failure watchdog every 30 minutes (internally rate-limited to at
  // most one alert per category per hour).
  watchdogInterval = setInterval(() => {
    checkDeliveryWatchdog().catch((err) => console.error("[watchdog] Tick error:", err));
  }, 30 * 60_000);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    if (inboxPollInterval) clearInterval(inboxPollInterval);
    if (watchdogInterval) clearInterval(watchdogInterval);
    inboxPollInterval = null;
    schedulerInterval = null;
    watchdogInterval = null;
    console.log("[scheduler] Email scheduler stopped");
  }
}
