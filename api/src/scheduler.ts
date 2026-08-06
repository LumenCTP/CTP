import { getDb } from "./db";
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
import { calculatePaymentWeek } from "./compliance";
import { ingestDocumentAttachment } from "./index";
import { computeWeeklyPaymentStatus, hasPriorYearW9 } from "./mapping";
import { QUEUE_SECRET } from "./secrets";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";

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
        // Extract slug from to_address
        let tenantSlug: string | null = null;
        const toAddr = email.to_address || "";
        const slugMatch = toAddr.match(/\+([a-z0-9-]+)@/i);
        if (slugMatch) tenantSlug = slugMatch[1];

        if (!tenantSlug) {
          db.run("UPDATE inbox_queue SET processed = 1, processed_at = datetime('now'), error = 'no slug in to_address' WHERE id = ?", [row.id]);
          continue;
        }

        const tenant = db.query("SELECT id FROM tenants WHERE inbox_slug = ?").get(tenantSlug) as { id: number } | undefined;
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

// Track last-run dates to prevent duplicate sends within the same window
let lastWeeklyCheckDate: string | null = null;   // ISO date string (YYYY-MM-DD) of the Monday we last processed
let lastMonthlyCheckDate: string | null = null;   // ISO date string of the 1st we last processed
let lastDailyRenewalDate: string | null = null;   // ISO date string of the last day we ran renewal checks

const REPORTS_DIR = path.join(import.meta.dir, "..", "data", "reports");

function ensureReportsDir() {
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

// ── Scheduler Tick ─────────────────────────────────────

async function tick(): Promise<void> {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  await checkWeekly(now, todayStr);
  await checkMonthly(now, todayStr);
  checkRenewals(now, todayStr);
}

// ── Weekly Report Check ────────────────────────────────

async function checkWeekly(now: Date, todayStr: string): Promise<void> {
  // Day 1 = Monday, 11:00 AM UTC (= 7:00 AM ET / 6:00 AM EST)
  if (now.getUTCDay() !== 1) return;
  if (now.getUTCHours() < 11) return;

  // Determine the Monday of this week
  const { monday } = calculatePaymentWeek();

  // Prevent duplicate: only send once per Monday
  if (lastWeeklyCheckDate === monday) return;

  console.log(`[scheduler] Monday ${monday} 11:00 UTC (7am ET) — generating weekly reports`);
  lastWeeklyCheckDate = monday;

  const db = getDb();
  ensureReportsDir();

  // Get all clients with weekly recipients configured
  const configs = db.query(`
    SELECT cec.client_id, cec.weekly_report_recipients, cl.name as client_name
    FROM client_email_config cec
    JOIN clients cl ON cl.id = cec.client_id
    WHERE cec.weekly_report_recipients IS NOT NULL
      AND cec.weekly_report_recipients != ''
  `).all() as Array<{
    client_id: number;
    weekly_report_recipients: string;
    client_name: string;
  }>;

  for (const config of configs) {
    try {
      console.log(`[scheduler] Generating weekly report for client ${config.client_id} (${config.client_name})`);

      const reportData = gatherReportData(config.client_id);
      const timestamp = Date.now();
      const clientSlug = config.client_name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);

      // Generate PDF
      const pdfFilename = `ClearToPay_${clientSlug}_${timestamp}.pdf`;
      const pdfPath = path.join(REPORTS_DIR, pdfFilename);
      const pdfDoc = generatePdfReport(reportData);
      const pdfBuffers: Buffer[] = [];
      for await (const chunk of pdfDoc) {
        pdfBuffers.push(Buffer.from(chunk));
      }
      Bun.write(pdfPath, Buffer.concat(pdfBuffers));

      // Generate Excel
      const xlsxFilename = `ClearToPay_${clientSlug}_${timestamp}.xlsx`;
      const xlsxPath = path.join(REPORTS_DIR, xlsxFilename);
      const xlsxBuffer = await generateExcelReport(reportData);
      Bun.write(xlsxPath, xlsxBuffer);

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
      const subject = `Clear-to-Pay Weekly Report — ${reportData.payment_week.monday} to ${reportData.payment_week.sunday}`;

      sendEmail(recipients, subject, emailBody, config.client_id, undefined, "weekly_report");
      console.log(`[scheduler] Weekly report sent for client ${config.client_id}`);
      for (const result of computeWeeklyPaymentStatus(db, (db.query("SELECT tenant_id FROM clients WHERE id=$id").get({$id: config.client_id}) as {tenant_id:number}).tenant_id)) {
        db.query("INSERT INTO compliance_status (vendor_id,client_id,payment_status,status,calculated_at) VALUES ($vid,$cid,$payment,$status,datetime('now')) ON CONFLICT(vendor_id) DO UPDATE SET client_id=excluded.client_id,payment_status=excluded.payment_status,calculated_at=datetime('now')").run({$vid:result.vendorId,$cid:result.clientId,$payment:result.paymentStatus,$status:result.paymentStatus === "approved" ? "compliant" : result.paymentStatus === "review" ? "expiring_soon" : "expired"});
      }
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
}

// ── Monthly Report Check ───────────────────────────────

async function checkMonthly(now: Date, todayStr: string): Promise<void> {
  // 1st of the month, 6:00 AM UTC
  if (now.getUTCDate() !== 1) return;
  if (now.getUTCHours() < 6) return;

  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

  if (lastMonthlyCheckDate === monthKey) return;

  console.log(`[scheduler] 1st of month (${monthKey}) 06:00+ UTC — generating monthly reports`);
  lastMonthlyCheckDate = monthKey;

  const db = getDb();

  const configs = db.query(`
    SELECT cec.client_id, cec.monthly_report_recipients, cl.name as client_name
    FROM client_email_config cec
    JOIN clients cl ON cl.id = cec.client_id
    WHERE cec.monthly_report_recipients IS NOT NULL
      AND cec.monthly_report_recipients != ''
  `).all() as Array<{
    client_id: number;
    monthly_report_recipients: string;
    client_name: string;
  }>;

  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  for (const config of configs) {
    try {
      console.log(`[scheduler] Generating monthly report for client ${config.client_id} (${config.client_name})`);

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
  // Only run once per day
  if (lastDailyRenewalDate === todayStr) return;
  lastDailyRenewalDate = todayStr;

  const db = getDb();

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
    // Find all reviewed documents for this client's vendors that have expiration dates
    const docs = db.query(`
      SELECT d.id as document_id, d.vendor_id, d.document_type, d.sender_email,
             de.expiration_date, v.name as vendor_name
      FROM documents d
      JOIN document_extractions de ON de.document_id = d.id
      JOIN vendors v ON v.id = d.vendor_id
      WHERE d.client_id = $client_id
        AND de.is_reviewed = 1
        AND de.expiration_date IS NOT NULL
        AND de.expiration_date != ''
        AND d.sender_email IS NOT NULL
        AND d.sender_email != ''
    `).all({ $client_id: config.client_id }) as Array<{
      document_id: number;
      vendor_id: number;
      document_type: string;
      sender_email: string;
      expiration_date: string;
      vendor_name: string;
    }>;

    for (const doc of docs) {
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
            console.log(`[scheduler] Sending ${window}-day renewal reminder for document ${doc.document_id} (${doc.vendor_name} — ${doc.document_type})`);

            const emailBody = buildRenewalReminderEmail(
              doc.vendor_name,
              doc.document_type,
              doc.expiration_date,
              window,
              config.tenant_id,
            );
            const outreach = hasPriorYearW9(db, doc.vendor_id, now.getFullYear() - 1)
              ? "Please submit an updated Certificate of Insurance (COI)."
              : "Please submit an updated Certificate of Insurance (COI) and a new W-9 form.";
            const emailBodyWithOutreach = `${emailBody}\n\n${outreach}`;

            const subject = `Reminder: ${doc.document_type} for ${doc.vendor_name} expires ${window === 0 ? "today" : `in ${window} days`}`;

            sendEmail(
              [doc.sender_email],
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
}

// ── Start / Stop ───────────────────────────────────────

export function startScheduler(): void {
  if (schedulerInterval) return; // Already running

  console.log("[scheduler] Email scheduler started — checking every 60s");

  // Run an immediate tick on startup so we don't miss anything
  tick().catch((err) => console.error("[scheduler] Initial tick error:", err));

  schedulerInterval = setInterval(tick, 60_000);
  inboxPollTick();
  inboxPollInterval = setInterval(inboxPollTick, 5 * 60_000);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    if (inboxPollInterval) clearInterval(inboxPollInterval);
    inboxPollInterval = null;
    schedulerInterval = null;
    console.log("[scheduler] Email scheduler stopped");
  }
}
