import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { requireQueueSecret } from "../middleware";
import { sendEmail, buildWeeklyReportEmail, buildRenewalReminderEmail, parseRecipients, parseAttachmentsJson, resolveEmailAttachments } from "../email";
import { gatherReportData, generatePdfReport, generateExcelReport, countDocumentRows } from "../reports";
import { markWeeklySent } from "../scheduler";
import { QUEUE_SECRET } from "../secrets";
import { storagePut } from "../storage";

const app = new Hono();

// ── Email Queue Processing ─────────────────────────────────

// POST /api/emails/process-queue — claim/read queued messages for the delivery worker.
// Attachments are resolved from the storage layer at claim time: each queued
// attachment's metadata (filename, contentType, storageKey) is looked up via
// storageGet and returned inline as base64, so the outbound payload carries
// filename + MIME + bytes without the DB ever holding file payloads.
app.post("/api/emails/process-queue", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    const db = getDb();
    const rows = db.query(`
      SELECT id, from_address, from_name, reply_to, recipient_email, subject,
             html_body, attachments, client_id, vendor_id, email_type
      FROM outgoing_email_queue
      WHERE status = 'queued'
      ORDER BY id ASC
    `).all() as Array<Record<string, unknown> & { attachments: string | null }>;

    const out = [];
    for (const row of rows) {
      const atts = parseAttachmentsJson(row.attachments);
      const resolved = atts.length > 0 ? await resolveEmailAttachments(atts) : [];
      out.push({ ...row, attachments: resolved });
    }
    return c.json(out);
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/emails/mark-sent — acknowledge successful delivery of queue IDs.
app.post("/api/emails/mark-sent", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    const body = await c.req.json() as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.some((id) => !Number.isInteger(id) || (id as number) < 1)) {
      return c.json({ error: "ids must be an array of positive integers" }, 400);
    }
    const db = getDb();
    const update = db.query("UPDATE outgoing_email_queue SET status = 'sent', sent_at = datetime('now') WHERE id = $id");
    const updateLogs = db.query(`
      UPDATE email_log SET status = 'sent', sent_at = datetime('now')
      WHERE status IN ('queued', 'error')
        AND recipient_email = $recipient AND subject = $subject
        AND (client_id IS $client_id OR client_id = $client_id)
    `);
    let updated = 0;
    for (const rawId of body.ids as number[]) {
      const id = Number(rawId);
      const row = db.query("SELECT client_id, vendor_id, recipient_email, subject FROM outgoing_email_queue WHERE id = $id").get({ $id: id }) as any;
      if (!row) continue;
      update.run({ $id: id });
      updateLogs.run({ $recipient: row.recipient_email, $subject: row.subject, $client_id: row.client_id });
      updated++;
    }
    return c.json({ success: true, updated });
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/emails/mark-failed — record a delivery failure.
app.post("/api/emails/mark-failed", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    const body = await c.req.json() as { id?: unknown; error?: unknown };
    if (!Number.isInteger(body.id) || (body.id as number) < 1 || typeof body.error !== "string") {
      return c.json({ error: "id and error are required" }, 400);
    }
    const db = getDb();
    const result = db.query("UPDATE outgoing_email_queue SET status = 'failed', error_message = $error WHERE id = $id").run({ $id: body.id as number, $error: body.error });
    return c.json({ success: true, updated: result.changes });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── Email Configuration ──────────────────────────────────

// GET /api/emails/config/:client_id — get email config
app.get("/api/emails/config/:client_id", (c) => {
  try {
    const db = getDb();
    const clientId = Number(c.req.param("client_id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    let config = db.query(
      "SELECT id, client_id, weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled, created_at, updated_at FROM client_email_config WHERE client_id = $client_id AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $client_id: clientId, $tenant_id: c.get("tenant_id") as number }) as Record<string, unknown> | undefined;

    if (!config) {
      // Return defaults — config gets created on first save
      return c.json({
        client_id: clientId,
        weekly_report_recipients: null,
        monthly_report_recipients: null,
        renewal_reminders_enabled: 1,
      });
    }

    return c.json(config);
  } catch (err) {
    return serverError(c, err);
  }
});

// PUT /api/emails/config/:client_id — update email recipients
app.put("/api/emails/config/:client_id", async (c) => {
  try {
    const db = getDb();
    const clientId = Number(c.req.param("client_id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const body = await c.req.json();
    const { weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled } = body;

    // Upsert: try insert, then update on conflict
    db.query(`
      INSERT INTO client_email_config (client_id, weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled, updated_at)
      VALUES ($client_id, $weekly, $monthly, $renewal, datetime('now'))
      ON CONFLICT(client_id) DO UPDATE SET
        weekly_report_recipients = COALESCE($weekly, weekly_report_recipients),
        monthly_report_recipients = COALESCE($monthly, monthly_report_recipients),
        renewal_reminders_enabled = COALESCE($renewal, renewal_reminders_enabled),
        updated_at = datetime('now')
    `).run({
      $client_id: clientId,
      $weekly: weekly_report_recipients !== undefined ? (typeof weekly_report_recipients === "string" ? weekly_report_recipients.trim() || null : null) : null,
      $monthly: monthly_report_recipients !== undefined ? (typeof monthly_report_recipients === "string" ? monthly_report_recipients.trim() || null : null) : null,
      $renewal: renewal_reminders_enabled !== undefined ? (renewal_reminders_enabled ? 1 : 0) : null,
    });

    const config = db.query(
      "SELECT id, client_id, weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled, created_at, updated_at FROM client_email_config WHERE client_id = $client_id AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $client_id: clientId, $tenant_id: c.get("tenant_id") as number });

    return c.json(config);
  } catch (err) {
    return serverError(c, err);
  }
});

// GET /api/emails/log — list recent emails, supports ?client_id=
app.get("/api/emails/log", (c) => {
  try {
    const db = getDb();
    const clientId = c.req.query("client_id");
    const limit = Math.min(Number(c.req.query("limit")) || 100, 500);

    let sql = `
      SELECT el.id, el.client_id, el.vendor_id, el.email_type, el.recipient_email,
             el.subject, el.sent_at, el.status,
             (el.error_message IS NOT NULL AND el.error_message != '') AS delivery_failed,
             cl.name as client_name,
             v.name as vendor_name
      FROM email_log el
      JOIN clients scope_client ON scope_client.id = el.client_id AND scope_client.tenant_id = $tenant_id
      LEFT JOIN clients cl ON cl.id = el.client_id
      LEFT JOIN vendors v ON v.id = el.vendor_id
    `;

    const params: Record<string, unknown> = { $limit: limit, $tenant_id: c.get("tenant_id") as number };

    if (clientId) {
      sql += " WHERE el.client_id = $client_id";
      params.$client_id = Number(clientId);
    }

    sql += " ORDER BY el.sent_at DESC LIMIT $limit";

    const rows = db.query(sql).all(params);
    return c.json(rows);
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/emails/test-weekly/:client_id — manually send a test weekly report
app.post("/api/emails/test-weekly/:client_id", async (c) => {
  try {
    const db = getDb();
    const clientId = Number(c.req.param("client_id"));

    const client = db.query("SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string } | undefined;
    if (!client) {
      return c.json({ error: "Client not found" }, 404);
    }

    // Get email config to know recipients
    const config = db.query(
      "SELECT weekly_report_recipients FROM client_email_config WHERE client_id = $client_id AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $client_id: clientId, $tenant_id: c.get("tenant_id") as number }) as { weekly_report_recipients: string | null } | undefined;

    if (!config?.weekly_report_recipients) {
      return c.json({ error: "No weekly report recipients configured. Set them up first." }, 400);
    }

    const recipients = parseRecipients(config.weekly_report_recipients);

    // Gather report data
    const reportData = gatherReportData(clientId);

    // Generate and persist the same PDF + XLSX report files the Monday
    // scheduler attaches, so the test email carries identical attachments.
    const timestamp = Date.now();
    const clientSlug = client.name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);
    const tenantPrefix = `reports/tenant-${c.get("tenant_id") as number}`;

    const pdfFilename = `ClearToPay_${clientSlug}_${timestamp}.pdf`;
    const pdfDoc = generatePdfReport(reportData);
    const pdfBuffers: Buffer[] = [];
    for await (const chunk of pdfDoc) {
      pdfBuffers.push(Buffer.from(chunk));
    }
    await storagePut(`${tenantPrefix}/${pdfFilename}`, Buffer.concat(pdfBuffers), "application/pdf");

    const xlsxFilename = `ClearToPay_${clientSlug}_${timestamp}.xlsx`;
    const xlsxBuffer = await generateExcelReport(reportData);
    await storagePut(`${tenantPrefix}/${xlsxFilename}`, xlsxBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const attachments = [
      { filename: pdfFilename, contentType: "application/pdf", storageKey: `${tenantPrefix}/${pdfFilename}` },
      { filename: xlsxFilename, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", storageKey: `${tenantPrefix}/${xlsxFilename}` },
    ];

    // Build email
    const emailBody = buildWeeklyReportEmail(client.name, {
      approved_count: reportData.approved.length,
      review_count: reportData.review.length,
      hold_count: reportData.hold.length,
      expiring_count: reportData.expiring_during_week.length,
      missing_count: reportData.missing_docs.length,
      payment_week: reportData.payment_week,
      report_date: reportData.report_date,
    });

    const subject = `[TEST] Clear-to-Pay Weekly Report — ${reportData.payment_week.week_start} to ${reportData.payment_week.week_end}`;

    sendEmail(recipients, subject, emailBody, clientId, undefined, "weekly_report", attachments);

    return c.json({
      success: true,
      recipients,
      subject,
      attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType })),
      summary: {
        approved_count: reportData.approved.length,
        review_count: reportData.review.length,
        hold_count: reportData.hold.length,
        expiring_count: reportData.expiring_during_week.length,
        missing_count: reportData.missing_docs.length,
      },
    });
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/emails/run-weekly/:client_id — send the REAL weekly Clear-to-Pay
// report for one client (backend for the future "Run Weekly Report Now"
// button). Mirrors the Monday scheduler pipeline (scheduler.ts checkWeekly)
// exactly, minus the all-client loop and the [TEST] subject prefix, and
// records the delivery in weekly_email_log so the Monday run does not
// double-send for this payment week.
app.post("/api/emails/run-weekly/:client_id", async (c) => {
  try {
    const db = getDb();
    const clientId = Number(c.req.param("client_id"));

    const client = db.query("SELECT id, name, tenant_id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string; tenant_id: number } | undefined;
    if (!client) {
      return c.json({ error: "Client not found" }, 404);
    }

    const config = db.query(
      "SELECT weekly_report_recipients FROM client_email_config WHERE client_id = $client_id AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $client_id: clientId, $tenant_id: c.get("tenant_id") as number }) as { weekly_report_recipients: string | null } | undefined;
    if (!config?.weekly_report_recipients) {
      return c.json({ error: "No weekly report recipients configured. Set them up first." }, 400);
    }

    const recipients = parseRecipients(config.weekly_report_recipients);

    // Same gather → generate → store → send pipeline the Monday scheduler uses.
    const reportData = gatherReportData(clientId);

    const timestamp = Date.now();
    const clientSlug = client.name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);
    const tenantPrefix = `reports/tenant-${c.get("tenant_id") as number}`;

    const pdfFilename = `ClearToPay_${clientSlug}_${timestamp}.pdf`;
    const pdfDoc = generatePdfReport(reportData);
    const pdfBuffers: Buffer[] = [];
    for await (const chunk of pdfDoc) {
      pdfBuffers.push(Buffer.from(chunk));
    }
    await storagePut(`${tenantPrefix}/${pdfFilename}`, Buffer.concat(pdfBuffers), "application/pdf");

    const xlsxFilename = `ClearToPay_${clientSlug}_${timestamp}.xlsx`;
    const xlsxBuffer = await generateExcelReport(reportData);
    await storagePut(`${tenantPrefix}/${xlsxFilename}`, xlsxBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const attachments = [
      { filename: pdfFilename, contentType: "application/pdf", storageKey: `${tenantPrefix}/${pdfFilename}` },
      { filename: xlsxFilename, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", storageKey: `${tenantPrefix}/${xlsxFilename}` },
    ];

    const emailBody = buildWeeklyReportEmail(client.name, {
      approved_count: reportData.approved.length,
      review_count: reportData.review.length,
      hold_count: reportData.hold.length,
      expiring_count: reportData.expiring_during_week.length,
      missing_count: reportData.missing_docs.length,
      payment_week: reportData.payment_week,
      report_date: reportData.report_date,
    });

    // Real subject — no [TEST] prefix, same wording as the Monday scheduler.
    const subject = `Clear-to-Pay Weekly Report — ${reportData.payment_week.week_start} to ${reportData.payment_week.week_end}`;

    await sendEmail(recipients, subject, emailBody, clientId, undefined, "weekly_report", attachments);

    // Record the delivery so the Monday run skips this payment week
    // (weeklyAlreadySent backstop in scheduler.ts).
    markWeeklySent(db, client.tenant_id, reportData.payment_week.week_start, reportData.payment_week.week_end, {
      approved: reportData.approved.length,
      hold: reportData.hold.length,
      review: reportData.review.length,
    }, recipients.join(", "));

    // Let the delivery worker pick up queued messages immediately (no-op when
    // the Graph/SMTP path delivered directly). Same call the scheduler makes
    // at the end of its weekly batch.
    try {
      const port = process.env.PORT || "3001";
      await fetch(`http://127.0.0.1:${port}/api/emails/process-queue`, {
        method: "POST",
        headers: { "X-Queue-Secret": QUEUE_SECRET },
      });
    } catch (err) {
      console.error("[run-weekly] Queue processing request error:", err);
    }

    return c.json({
      success: true,
      recipients,
      subject,
      attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType })),
      summary: {
        vendor_count: reportData.approved.length + reportData.review.length + reportData.hold.length,
        document_row_count: countDocumentRows(reportData),
        approved_vendors: reportData.approved.length,
        review_vendors: reportData.review.length,
        hold_vendors: reportData.hold.length,
        expiring_count: reportData.expiring_during_week.length,
        missing_count: reportData.missing_docs.length,
      },
    });
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/emails/test-renewal/:document_id — manually send a renewal reminder
app.post("/api/emails/test-renewal/:document_id", async (c) => {
  try {
    const db = getDb();
    const docId = Number(c.req.param("document_id"));

    const doc = db.query(`
      SELECT d.id, d.vendor_id, d.client_id, d.document_type, d.sender_email,
             de.expiration_date, de.producer_email, de.producer_name, v.name as vendor_name
      FROM documents d
      JOIN document_extractions de ON de.document_id = d.id
      JOIN vendors v ON v.id = d.vendor_id
      WHERE d.id = $id AND de.is_reviewed = 1 AND d.tenant_id = $tenant_id
    `).get({ $id: docId, $tenant_id: c.get("tenant_id") }) as {
      id: number; vendor_id: number; client_id: number; document_type: string;
      sender_email: string | null; expiration_date: string | null;
      producer_email: string | null; producer_name: string | null; vendor_name: string;
    } | undefined;

    if (!doc) {
      return c.json({ error: "Document not found or not reviewed" }, 404);
    }

    // Recipient preference — same order as the scheduler's renewal job:
    // producer_email (COI agency/agent contact) first, falling back to
    // sender_email (the submitter). A manually-entered doc with only a
    // producer email must still get a reminder.
    const recipient = (doc.producer_email ?? "").trim() || (doc.sender_email ?? "").trim();
    if (!recipient) {
      return c.json({ error: "No producer email or sender email on this document" }, 400);
    }

    if (!doc.expiration_date) {
      return c.json({ error: "No expiration date on this document" }, 400);
    }

    const expDate = new Date(doc.expiration_date + "T00:00:00Z");
    const diffMs = expDate.getTime() - Date.now();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    const emailBody = buildRenewalReminderEmail(
      doc.vendor_name,
      doc.document_type,
      doc.expiration_date,
      Math.max(0, diffDays),
      undefined,
      doc.producer_name,
    );

    const subject = `[TEST] Reminder: ${doc.document_type} for ${doc.vendor_name} expires ${diffDays <= 0 ? "today" : `in ${diffDays} days`}`;

    sendEmail([recipient], subject, emailBody, doc.client_id, doc.vendor_id, "renewal_reminder");

    return c.json({
      success: true,
      recipient,
      recipient_source: (doc.producer_email ?? "").trim() ? "producer_email" : "sender_email",
      subject,
      vendor_name: doc.vendor_name,
      document_type: doc.document_type,
      expiration_date: doc.expiration_date,
      days_until_expiry: diffDays,
    });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
