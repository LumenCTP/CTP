import { getDb } from "./db";
import { storageGet } from "./storage";
import { buildInboxAddress } from "./lib/inbox";
import { smtpConfigured, sendViaSmtp, SMTP_CC_ADDRESS } from "./smtp";
import { graphMailConfigured, sendViaGraphMail } from "./graph-mail";
import type { ReportData } from "./reports";

// ── Email Identity ───────────────────────────────────────

// Outbound sender identity. The From address/name are overridable via env vars
// (api/.env) so they can be flipped without a redeploy; the code defaults are
// the product's reports mailbox on the owner's domain.
const EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || "reports@cleartopayconstruction.com";
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "ClearToPay Compliance";
// Reply-To defaults to the same reports mailbox (it must be monitored or
// forwarded so replies are not lost); overridable via EMAIL_REPLY_TO.
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || EMAIL_FROM_ADDRESS;

// ── Attachments ──────────────────────────────────────────

/**
 * An attachment referenced by an outgoing email. The queue row stores only
 * this lightweight metadata (JSON in outgoing_email_queue.attachments) — the
 * file bytes stay in the storage layer and are resolved at send time via
 * storageGet, so big payloads are never copied into the DB.
 */
export interface EmailAttachment {
  /** Client-visible filename, e.g. "ClearToPay_Acme_1786….pdf". */
  filename: string;
  /** MIME type, e.g. "application/pdf". */
  contentType: string;
  /** Storage key the file was stored under (storagePut), e.g. "reports/tenant-49/….pdf". */
  storageKey: string;
}

/**
 * Resolves queued attachment metadata against the storage layer, returning the
 * file bytes as base64 for delivery. Used by the queue worker (process-queue)
 * so the outbound payload carries filename + MIME + non-empty bytes. Returns
 * `resolved: false` (contentBase64 null) when the object is missing so the
 * worker can still deliver the body while flagging the gap.
 */
export async function resolveEmailAttachments(
  attachments: EmailAttachment[],
): Promise<Array<EmailAttachment & { contentBase64: string | null; resolved: boolean }>> {
  const out: Array<EmailAttachment & { contentBase64: string | null; resolved: boolean }> = [];
  for (const a of attachments) {
    try {
      const obj = await storageGet(a.storageKey);
      if (obj && obj.data.length > 0) {
        out.push({ ...a, contentBase64: obj.data.toString("base64"), resolved: true });
      } else {
        out.push({ ...a, contentBase64: null, resolved: false });
      }
    } catch (err) {
      console.error(`[email] Attachment resolve failed for ${a.storageKey}:`, err);
      out.push({ ...a, contentBase64: null, resolved: false });
    }
  }
  return out;
}

/** Parses the JSON in outgoing_email_queue.attachments into EmailAttachment[]. */
export function parseAttachmentsJson(raw: string | null): EmailAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is EmailAttachment =>
        !!a && typeof a.filename === "string" && typeof a.contentType === "string" && typeof a.storageKey === "string",
    );
  } catch {
    return [];
  }
}

// ── Tenant Inbox Address ──────────────────────────────────

/**
 * Builds the tenant's custom document-submission inbox address
 * (e.g. cleartopay-compliance-0d8d884b+ABCCompany@ctomail.io)
 * from the tenant's inbox_slug. Falls back to the global sender address when
 * the tenant has no slug (or the lookup fails).
 */
export function getTenantInboxAddress(tenantId?: number | null): string {
  if (tenantId) {
    const row = getDb().query("SELECT inbox_slug FROM tenants WHERE id = $id").get({ $id: tenantId }) as { inbox_slug: string | null } | undefined;
    const addr = buildInboxAddress(row?.inbox_slug);
    if (addr) return addr;
  }
  return EMAIL_FROM_ADDRESS;
}

// ── Email Sender ─────────────────────────────────────────

/**
 * Which outbound path sendEmail() will take, in priority order:
 *   1. "graph" — Microsoft Graph sendMail (OAuth 2.0 client-credentials),
 *      active when M365_TENANT_ID + M365_CLIENT_ID + M365_CLIENT_SECRET are
 *      all set (the owner's Entra app registration; primary path).
 *   2. "smtp"  — direct M365 SMTP (smtp.office365.com with SMTP-AUTH app
 *      password), active when ClearToPaySMTP is set (works in tenants where
 *      SMTP client submission is enabled).
 *   3. "queue" — the platform outgoing_email_queue path (no M365 config).
 * Exported so the harness can assert the ordering without sending anything.
 */
export type DeliveryPath = "graph" | "smtp" | "queue";

export function getDeliveryPath(): DeliveryPath {
  if (graphMailConfigured()) return "graph";
  if (smtpConfigured()) return "smtp";
  return "queue";
}

/**
 * Sends email. Delivery is chosen centrally here so no call site can forget
 * the owner's outbound rules:
 *
 * - M365 Graph secrets set (primary, owner directive 2026-08-14): Microsoft
 *   Graph sendMail as EMAIL_FROM_ADDRESS with every message CC'd to
 *   documents@ (SMTP_CC_ADDRESS) — see deliverViaGraphMail().
 * - ClearToPaySMTP set (fallback): direct M365 SMTP delivery from
 *   EMAIL_FROM_ADDRESS with the same CC — see deliverViaM365Smtp().
 * - Neither set (dev/test): the platform queue path is used — a row goes to
 *   outgoing_email_queue for the process-queue worker and email_log records
 *   it as 'queued'.
 *
 * From:     ClearToPay Compliance <EMAIL_FROM_ADDRESS>
 * Reply-To: EMAIL_REPLY_TO
 */
export async function sendEmail(
  to: string[],
  subject: string,
  htmlBody: string,
  clientId?: number,
  vendorId?: number,
  emailType?: "weekly_report" | "monthly_report" | "renewal_reminder" | "password_reset" | "partner_payout" | "inbox_rejection",
  attachments?: EmailAttachment[],
): Promise<void> {
  const db = getDb();
  const recipients = to.map((r) => r.trim()).filter(Boolean);
  if (recipients.length === 0) return;
  const path = getDeliveryPath();
  console.log("══════════════════════════════════════════════");
  console.log(`[email] ${path === "graph" ? "GRAPH-DELIVER" : path === "smtp" ? "SMTP-DELIVER" : "QUEUING"} EMAIL`);
  console.log(`[email] From: ${EMAIL_FROM_NAME} <${EMAIL_FROM_ADDRESS}>`);
  console.log(`[email] Reply-To: ${EMAIL_REPLY_TO}`);
  console.log(`[email] To: ${recipients.join(", ")}`);
  console.log(`[email] Subject: ${subject}`);
  console.log(`[email] Type: ${emailType ?? "manual"}`);
  console.log(`[email] Attachments: ${attachments ? attachments.map((a) => `${a.filename} (${a.contentType})`).join(", ") || "(none)" : "(none)"}`);
  console.log("══════════════════════════════════════════════");
  if (path === "graph") {
    // Microsoft Graph sendMail (primary). No queue row is created: the Graph
    // sendMail conversation is the delivery, email_log is the audit trail,
    // and the platform worker can never double-send.
    await deliverViaGraphMail({ recipients, subject, htmlBody, clientId, vendorId, emailType, attachments, db });
    return;
  }
  if (path === "smtp") {
    // Direct M365 SMTP path — wins whenever ClearToPaySMTP is set. Every
    // message is CC'd to the documents@ mailbox (owner directive). No queue
    // row is created: the SMTP conversation is the delivery, email_log is
    // the audit trail, and the platform worker can never double-send.
    await deliverViaM365Smtp({ recipients, subject, htmlBody, clientId, vendorId, emailType, attachments, db });
    return;
  }
  // ── Platform queue path (fallback when ClearToPaySMTP is absent) ──
  // Log to email_log for every recipient
  const insertStmt = db.query(`
    INSERT INTO email_log (client_id, vendor_id, email_type, recipient_email, subject, status, sent_at)
    VALUES ($client_id, $vendor_id, $email_type, $recipient_email, $subject, 'queued', datetime('now'))
  `);
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
  for (const recipient of recipients) {
    insertStmt.run({
      $client_id: clientId ?? null,
      $vendor_id: vendorId ?? null,
      $email_type: emailType ?? "weekly_report",
      $recipient_email: recipient,
      $subject: subject,
    });
    // Queue for delivery
    db.query(`
      INSERT INTO outgoing_email_queue (from_address, from_name, reply_to, recipient_email, subject, html_body, attachments, client_id, vendor_id, email_type)
      VALUES ($from_addr, $from_name, $reply_to, $recipient, $subject, $body, $attachments, $client_id, $vendor_id, $email_type)
    `).run({
      $from_addr: EMAIL_FROM_ADDRESS,
      $from_name: EMAIL_FROM_NAME,
      $reply_to: EMAIL_REPLY_TO,
      $recipient: recipient,
      $subject: subject,
      $body: htmlBody,
      $attachments: attachmentsJson,
      $client_id: clientId ?? null,
      $vendor_id: vendorId ?? null,
      $email_type: emailType ?? "weekly_report",
    });
  }
}

/**
 * Records one email_log row per recipient with the given status. Shared by the
 * Graph and SMTP direct-delivery paths so both write the same audit trail
 * (status 'sent' on success / 'error' with message on failure; no queue row).
 */
function recordEmailLog(args: {
  db: ReturnType<typeof getDb>;
  recipients: string[];
  clientId?: number;
  vendorId?: number;
  emailType?: string;
  subject: string;
  status: "sent" | "error";
  errorMessage?: string;
}): void {
  const { db, recipients, clientId, vendorId, emailType, subject, status, errorMessage } = args;
  const stmt = db.query(`
    INSERT INTO email_log (client_id, vendor_id, email_type, recipient_email, subject, status, sent_at, error_message)
    VALUES ($client_id, $vendor_id, $email_type, $recipient_email, $subject, $status, datetime('now'), $error_message)
  `);
  for (const recipient of recipients) {
    stmt.run({
      $client_id: clientId ?? null,
      $vendor_id: vendorId ?? null,
      $email_type: emailType ?? "weekly_report",
      $recipient_email: recipient,
      $subject: subject,
      $status: status,
      $error_message: errorMessage ?? null,
    });
  }
}

/**
 * Direct Microsoft Graph sendMail delivery (used when the M365 client-credentials
 * secrets are set — the primary path). Resolves attachment bytes from the
 * storage layer, builds the Graph JSON payload (subject / HTML body / To /
 * Cc / base64 attachments / saveToSentItems), sends it through
 * POST https://graph.microsoft.com/v1.0/users/{EMAIL_FROM_ADDRESS}/sendMail,
 * and records the outcome in email_log. Every message is CC'd to documents@
 * (SMTP_CC_ADDRESS) unless the recipient already IS documents@ — the CC is
 * deduped so the owner's mailbox never gets a duplicate of its own mail.
 * Delivery failures are logged and recorded on email_log as 'error' (never
 * silently retried); the platform path is NOT a fallback here because Graph
 * wins whenever the M365 secrets are present.
 */
async function deliverViaGraphMail(args: {
  recipients: string[];
  subject: string;
  htmlBody: string;
  clientId?: number;
  vendorId?: number;
  emailType?: "weekly_report" | "monthly_report" | "renewal_reminder" | "password_reset" | "partner_payout";
  attachments?: EmailAttachment[];
  db: ReturnType<typeof getDb>;
}): Promise<void> {
  const { recipients, subject, htmlBody, clientId, vendorId, emailType, attachments, db } = args;
  // Resolve attachment bytes (storage layer) for the Graph payload.
  const resolvedAtts = attachments && attachments.length > 0 ? await resolveEmailAttachments(attachments) : [];
  for (const att of resolvedAtts) {
    if (!att.resolved) console.warn(`[graph-mail] Attachment ${att.filename} (${att.storageKey}) could not be resolved — sending without bytes`);
  }
  // CC documents@ on every outbound message; dedupe when the recipient IS documents@.
  const cc = recipients.some((r) => r.toLowerCase() === SMTP_CC_ADDRESS) ? [] : [SMTP_CC_ADDRESS];
  try {
    await sendViaGraphMail({
      fromAddress: EMAIL_FROM_ADDRESS,
      to: recipients,
      cc,
      subject,
      htmlBody,
      bodyContentType: "HTML",
      attachments: resolvedAtts.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        contentBase64: a.contentBase64,
      })),
    });
    recordEmailLog({ db, recipients, clientId, vendorId, emailType, subject, status: "sent" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[graph-mail] Delivery failed for "${subject}" → ${recipients.join(", ")}: ${msg}`);
    recordEmailLog({ db, recipients, clientId, vendorId, emailType, subject, status: "error", errorMessage: msg });
  }
}

/**
 * Direct M365 SMTP delivery (used when ClearToPaySMTP is set).
 * Resolves attachment bytes from the storage layer, builds the multipart
 * MIME message (From / Reply-To / To / Cc headers), sends it through
 * smtp.office365.com, and records the outcome in email_log. Every message
 * is CC'd to documents@ (SMTP_CC_ADDRESS) unless the recipient already IS
 * documents@ — the CC is deduped so the owner's mailbox never gets a
 * duplicate of its own mail. Delivery failures are logged and recorded on
 * email_log as 'error' (never silently retried); the platform path is NOT a
 * fallback here because SMTP wins whenever ClearToPaySMTP is present.
 */
async function deliverViaM365Smtp(args: {
  recipients: string[];
  subject: string;
  htmlBody: string;
  clientId?: number;
  vendorId?: number;
  emailType?: "weekly_report" | "monthly_report" | "renewal_reminder" | "password_reset" | "partner_payout";
  attachments?: EmailAttachment[];
  db: ReturnType<typeof getDb>;
}): Promise<void> {
  const { recipients, subject, htmlBody, clientId, vendorId, emailType, attachments, db } = args;
  // Resolve attachment bytes (storage layer) for the MIME payload.
  const resolvedAtts = attachments && attachments.length > 0 ? await resolveEmailAttachments(attachments) : [];
  for (const att of resolvedAtts) {
    if (!att.resolved) console.warn(`[smtp] Attachment ${att.filename} (${att.storageKey}) could not be resolved — sending without bytes`);
  }
  // CC documents@ on every outbound message; dedupe when the recipient IS documents@.
  const cc = recipients.some((r) => r.toLowerCase() === SMTP_CC_ADDRESS) ? [] : [SMTP_CC_ADDRESS];
  const mimeMessage = buildMultipartMessage({
    fromAddress: EMAIL_FROM_ADDRESS,
    fromName: EMAIL_FROM_NAME,
    replyTo: EMAIL_REPLY_TO,
    to: recipients,
    cc,
    subject,
    htmlBody,
    attachments: resolvedAtts.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      contentBase64: a.contentBase64,
    })),
  });
  try {
    await sendViaSmtp({
      fromAddress: EMAIL_FROM_ADDRESS,
      fromName: EMAIL_FROM_NAME,
      replyTo: EMAIL_REPLY_TO,
      to: recipients,
      cc,
      subject,
      mimeMessage,
    });
    recordEmailLog({ db, recipients, clientId, vendorId, emailType, subject, status: "sent" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[smtp] Delivery failed for "${subject}" → ${recipients.join(", ")}: ${msg}`);
    recordEmailLog({ db, recipients, clientId, vendorId, emailType, subject, status: "error", errorMessage: msg });
  }
}

// ── Helpers ──────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── Email Templates ──────────────────────────────────────

export function buildWeeklyReportEmail(
  clientName: string,
  reportSummary: {
    approved_count: number;
    review_count: number;
    hold_count: number;
    expiring_count: number;
    missing_count: number;
    payment_week: { week_start: string; week_end: string };
    report_date: string;
  },
): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1a56db; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">Clear-to-Pay Weekly Report</h1>
    <p style="color: #c7d2fe; margin: 4px 0 0; font-size: 13px;">${clientName}</p>
  </div>

  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    <p style="margin: 0 0 16px; color: #374151; font-size: 14px;">
      Payment Week: <strong>${formatDate(reportSummary.payment_week.week_start)} – ${formatDate(reportSummary.payment_week.week_end)}</strong><br>
      Report Date: ${formatDate(reportSummary.report_date)}
    </p>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr style="background: #f9fafb;">
        <th style="padding: 10px; text-align: left; font-size: 13px; border-bottom: 2px solid #e5e7eb;">Category</th>
        <th style="padding: 10px; text-align: right; font-size: 13px; border-bottom: 2px solid #e5e7eb;">Count</th>
      </tr>
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f3f4f6;">✅ Approved for Payment</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: #059669; border-bottom: 1px solid #f3f4f6;">${reportSummary.approved_count}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f3f4f6;">⚠️ Review Before Payment</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: #d97706; border-bottom: 1px solid #f3f4f6;">${reportSummary.review_count}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f3f4f6;">🚫 Hold Payment</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: #dc2626; border-bottom: 1px solid #f3f4f6;">${reportSummary.hold_count}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f3f4f6;">📅 Expiring This Week</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: #d97706; border-bottom: 1px solid #f3f4f6;">${reportSummary.expiring_count}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px;">❌ Missing Required Documents</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: #dc2626;">${reportSummary.missing_count}</td>
      </tr>
    </table>

    <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">
      A full PDF and Excel report is attached to this email.
    </p>

    <p style="margin: 0; font-size: 13px; color: #6b7280;">
      Log in to your <a href="https://cleartopay.ctonew.app" style="color: #1a56db;">ClearToPay dashboard</a> to view full details and manage your vendors.
    </p>
  </div>

  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
    This automated report was sent by ClearToPay Compliance. Reports are generated every Monday morning.
  </p>
  <p style="margin: 8px 0 0; font-size: 10px; color: #9ca3af; text-align: center;">
    This report reflects the compliance documents on file and the criteria configured for ${clientName} as of ${formatDate(reportSummary.report_date)}. It is an administrative tool, not legal advice. ClearToPay does not determine coverage adequacy; final payment and coverage decisions are the client's responsibility.
  </p>
</body>
</html>`;
}

export function buildMonthlyReportEmail(
  clientName: string,
  monthlySummary: {
    compliance_percentage: number;
    total_vendors: number;
    approved: number;
    review: number;
    hold: number;
    month: string;
    year: number;
  },
): string {
  const percent = monthlySummary.compliance_percentage.toFixed(1);
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1a56db; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">Monthly Compliance Report</h1>
    <p style="color: #c7d2fe; margin: 4px 0 0; font-size: 13px;">${clientName} — ${monthlySummary.month} ${monthlySummary.year}</p>
  </div>

  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    <p style="margin: 0 0 16px; color: #374151; font-size: 16px;">
      Overall Compliance: <strong style="color: ${percent === '100.0' ? '#059669' : '#d97706'}">${percent}%</strong>
    </p>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr style="background: #f9fafb;">
        <th style="padding: 10px; text-align: left; font-size: 13px; border-bottom: 2px solid #e5e7eb;">Category</th>
        <th style="padding: 10px; text-align: right; font-size: 13px; border-bottom: 2px solid #e5e7eb;">Count</th>
      </tr>
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f3f4f6;">Total Vendors</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; border-bottom: 1px solid #f3f4f6;">${monthlySummary.total_vendors}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f3f4f6;">✅ Approved for Payment</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: #059669; border-bottom: 1px solid #f3f4f6;">${monthlySummary.approved}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f3f4f6;">⚠️ Review Before Payment</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: #d97706; border-bottom: 1px solid #f3f4f6;">${monthlySummary.review}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px;">🚫 Hold Payment</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: #dc2626;">${monthlySummary.hold}</td>
      </tr>
    </table>

    <p style="margin: 0; font-size: 13px; color: #6b7280;">
      Log in to your <a href="https://cleartopay.ctonew.app" style="color: #1a56db;">ClearToPay dashboard</a> to view detailed compliance data and manage your vendors.
    </p>
  </div>

  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
    This automated report was sent by ClearToPay Compliance. Monthly reports are generated on the 1st of each month.
  </p>
  <p style="margin: 8px 0 0; font-size: 10px; color: #9ca3af; text-align: center;">
    This report reflects the compliance documents on file and the criteria configured for ${clientName} as of ${monthlySummary.month} ${monthlySummary.year}. It is an administrative tool, not legal advice. ClearToPay does not determine coverage adequacy; final payment and coverage decisions are the client's responsibility.
  </p>
</body>
</html>`;
}

export function buildRenewalReminderEmail(
  vendorName: string,
  documentType: string,
  expirationDate: string,
  daysUntilExpiry: number,
  tenantId?: number | null,
  producerName?: string | null,
): string {
  const inboxAddress = getTenantInboxAddress(tenantId);
  const urgencyColor = daysUntilExpiry <= 7 ? "#dc2626" : daysUntilExpiry <= 15 ? "#d97706" : "#374151";
  const urgencyText = daysUntilExpiry === 0
    ? `expires <strong>today</strong>`
    : `expires in <strong>${daysUntilExpiry} days</strong>`;
  // When the recipient is the COI producer (agency/agent), address them by name
  // so the reminder reads as intended instead of a generic greeting.
  const attentionLine = producerName && producerName.trim()
    ? `<p style="margin: 0 0 12px; font-size: 14px; color: #374151;">Attention: <strong>${producerName}</strong></p>`
    : "";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${urgencyColor}; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 18px;">Document Expiration Reminder</h1>
  </div>

  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    ${attentionLine}
    <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
      This is a reminder that the following compliance document for <strong>${vendorName}</strong> ${urgencyText}:
    </p>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr>
        <td style="padding: 8px 10px; font-weight: bold; background: #f9fafb; border-bottom: 1px solid #e5e7eb; width: 140px;">Vendor:</td>
        <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb;">${vendorName}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px; font-weight: bold; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">Document Type:</td>
        <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb;">${documentType}</td>
      </tr>
      <tr>
        <td style="padding: 8px 10px; font-weight: bold; background: #f9fafb;">Expiration Date:</td>
        <td style="padding: 8px 10px; color: ${urgencyColor}; font-weight: bold;">${formatDate(expirationDate)}</td>
      </tr>
    </table>

    <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
      Please submit the updated document so your client can review its compliance records.
    </p>

    <p style="margin: 0; font-size: 13px; color: #6b7280;">
      Documents can be emailed directly to <a href="mailto:${inboxAddress}" style="color: #1a56db;">${inboxAddress}</a>.
    </p>
  </div>

  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
    This is an automated reminder from ClearToPay Compliance on behalf of your client.
  </p>

  <p style="margin: 8px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
    The dates shown are based on information on file and may require confirmation. ClearToPay does not verify coverage or make payment decisions. Your client remains responsible for its requirements and payment decisions.
  </p>
</body>
</html>`;
}


// Inbox Rejection Reply: automatic plain-language reply to the sender of an
// inbound email whose attachment(s) could not be accepted (HEIC photo,
// unsupported type, too large). Vendor-facing: humble tone, no internals (no
// "API", no tech stack, no file paths), and only existing disclaimer phrasing
// from the other templates.
function friendlyInboxReason(reason: string): string {
  if (reason.startsWith("file too large:")) {
    return reason.replace(" exceeds 10MB cap", " — the maximum file size is 10MB");
  }
  if (reason.startsWith("unsupported file type:")) {
    return "the file type isn't supported (we accept PDF, JPG, and PNG)";
  }
  return reason;
}
export function buildInboxRejectionEmail(
  rejected: Array<{ filename: string; reason: string }>,
  inboxAddress: string | null,
): string {
  const rows = rejected
    .map(
      (r) => `<tr>
        <td style="padding: 8px 10px; font-weight: bold; background: #f9fafb; border-bottom: 1px solid #e5e7eb; width: 40%;">${r.filename.replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch] as string)}</td>
        <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb;">${friendlyInboxReason(r.reason)}</td>
      </tr>`
    )
    .join("\n");
  const resendLine = inboxAddress
    ? `<p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
      Please send those files again, this time as PDF, JPG, or PNG, to <a href="mailto:${inboxAddress}" style="color: #1a56db;">${inboxAddress}</a>.
    </p>`
    : `<p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
      Please send those files again, this time as PDF, JPG, or PNG.
    </p>`;
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #b45309; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 18px;">A few files couldn't be read</h1>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
      Thank you for sending your documents. We were able to read most of them, but the following files couldn't be processed:
    </p>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr>
        <td style="padding: 8px 10px; font-weight: bold; background: #f3f4f6; border-bottom: 1px solid #e5e7eb; width: 40%;">File</td>
        <td style="padding: 8px 10px; font-weight: bold; background: #f3f4f6; border-bottom: 1px solid #e5e7eb;">What happened</td>
      </tr>
      ${rows}
    </table>
    ${resendLine}
    <p style="margin: 0; font-size: 14px; color: #374151;">
      Your other documents were received and are being processed — no need to send them again.
    </p>
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
    This email was sent by ClearToPay Compliance.
  </p>
</body>
</html>`;
}

// ── Helper: Parse comma-separated email string ────────────────────
export function parseRecipients(recipientsStr: string | null): string[] {
  if (!recipientsStr) return [];
  return recipientsStr
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

// ── Password Reset Email Template ───────────────────────

export function buildPasswordResetEmail(fullName: string, resetLink: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1a56db; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">Reset your ClearToPay password</h1>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">Hi ${fullName},</p>
    <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
      We received a request to reset your ClearToPay password. Click the button below to choose a new one.
      This link expires in <strong>1 hour</strong>.
    </p>
    <p style="margin: 24px 0; text-align: center;">
      <a href="${resetLink}" style="display: inline-block; background: #1a56db; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-size: 14px;">Reset Password</a>
    </p>
    <p style="margin: 0 0 12px; font-size: 13px; color: #6b7280;">If the button doesn't work, copy and paste this link into your browser:</p>
    <p style="margin: 0 0 16px; font-size: 12px; color: #6b7280; word-break: break-all;">${resetLink}</p>
    <p style="margin: 0; font-size: 13px; color: #6b7280;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">This email was sent by ClearToPay Compliance.</p>
</body>
</html>`;
}

// ── Partner Payout Email (monthly payout run) ───────────
// Honest wording: the payout is being PROCESSED, not paid. Money is only
// transferred in delegation B (Stripe Connect); until then the payout stays
// 'pending' and the partner is told exactly that.
export function buildPartnerPayoutEmail(partnerName: string, amount: number, periodLabel: string): string {
  const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1a56db; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">Your ClearToPay partner payout is being processed</h1>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">Hi ${partnerName},</p>
    <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
      Your partner commission payout for <strong>${periodLabel}</strong> is
      <strong>${formatted}</strong>. We have started processing this payment — it is
      currently <strong>pending</strong> and will be transferred to your account on file.
    </p>
    <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
      You will receive a separate confirmation once the transfer has actually been completed.
      No action is needed from you at this time.
    </p>
    <p style="margin: 0; font-size: 13px; color: #6b7280;">Questions? Reply to this email and our team will help.</p>
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">This email was sent by ClearToPay Compliance.</p>
</body>
</html>`;
}
// ── Partner Transfer Confirmation (Stripe Connect, delegation B) ─────────
// Honest wording: the transfer COMPLETED (paid) or FAILED (failed). These fire
// from the transfer.paid / transfer.failed webhooks, never locally.
function partnerTransferEmailShell(title: string, bodyLines: string[], footer: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1a56db; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">${title}</h1>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    ${bodyLines.map((l) => `<p style="margin: 0 0 12px; font-size: 14px; color: #374151;">${l}</p>`).join("\n    ")}
    <p style="margin: 0; font-size: 13px; color: #6b7280;">${footer}</p>
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">This email was sent by ClearToPay Compliance.</p>
</body>
</html>`;
}

export function buildPartnerTransferPaidEmail(partnerName: string, amount: number, transferId: string): string {
  const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  return partnerTransferEmailShell(
    "Your ClearToPay partner payout has been transferred",
    [
      `Hi ${partnerName},`,
      `Your partner commission payout of <strong>${formatted}</strong> has been <strong>completed</strong> and transferred to your connected account.`,
      `Stripe transfer reference: <strong>${transferId}</strong>.`,
      `No action is needed from you. The funds are now in your Stripe account and will be available according to your payout schedule.`,
    ],
    "Questions? Reply to this email and our team will help.",
  );
}

export function buildPartnerTransferFailedEmail(partnerName: string, amount: number, transferId: string, reason: string): string {
  const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  return partnerTransferEmailShell(
    "Action needed: your ClearToPay partner payout could not be transferred",
    [
      `Hi ${partnerName},`,
      `We attempted to transfer your partner commission payout of <strong>${formatted}</strong>, but the transfer <strong>failed</strong>.`,
      `Stripe transfer reference: <strong>${transferId}</strong>.`,
      `Reason: <strong>${reason || "unknown"}</strong>.`,
      `Your payout stays recorded as failed on your account. Please check that your payout details are correct (bank account, onboarding requirements), then contact us and we will retry.`,
    ],
    "Questions? Reply to this email and our team will help.",
  );
}

// ── Helper: Has a specific reminder been sent? ──────────

export function hasReminderBeenSent(documentId: number, reminderDays: number): boolean {
  const db = getDb();
  const row = db.query(
    "SELECT id FROM renewal_reminders_sent WHERE document_id = $document_id AND reminder_days = $reminder_days"
  ).get({ $document_id: documentId, $reminder_days: reminderDays }) as { id: number } | undefined;
  return !!row;
}

export function markReminderSent(documentId: number, reminderDays: number): void {
  const db = getDb();
  db.query(
    "INSERT OR IGNORE INTO renewal_reminders_sent (document_id, reminder_days) VALUES ($document_id, $reminder_days)"
  ).run({ $document_id: documentId, $reminder_days: reminderDays });
}

// ── Multipart message builder ────────────────────────────
// Builds a complete RFC 2822 MIME message (multipart/alternative + attachments)
// from a queued email row. Used by the delivery worker contract test to prove
// the queue row + resolved storage bytes form a valid email with both report
// files attached; also the seam a direct SMTP sender would use.

/** Base64 content of an attachment in the order it should appear in the MIME body. */
export interface ResolvedAttachmentPart {
  filename: string;
  contentType: string;
  contentBase64: string | null;
}

const CRLF = "\r\n";

function base64Wrap(b64: string, lineLength = 76): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += lineLength) out.push(b64.slice(i, i + lineLength));
  return out.join(CRLF);
}

/**
 * Builds a multipart/alternative MIME message with an HTML part and one
 * application/octet-stream attachment part per resolved attachment. Returns
 * the complete message as a string (headers + body) that can be handed to any
 * SMTP client.
 */
export function buildMultipartMessage(opts: {
  fromAddress: string;
  fromName: string;
  replyTo: string;
  to: string[];
  cc?: string[];
  subject: string;
  htmlBody: string;
  attachments: ResolvedAttachmentPart[];
}): string {
  const boundary = `ctp-boundary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const lines: string[] = [];

  // Headers
  lines.push(`From: ${opts.fromName} <${opts.fromAddress}>`);
  lines.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${opts.cc.join(", ")}`);
  lines.push(`Reply-To: ${opts.replyTo}`);
  lines.push(`Subject: ${opts.subject.replace(/[\r\n]/g, " ")}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push("");

  // HTML body part
  lines.push(`--${boundary}`);
  lines.push(`Content-Type: text/html; charset="utf-8"`);
  lines.push(`Content-Transfer-Encoding: 7bit`);
  lines.push("");
  lines.push(opts.htmlBody);
  lines.push("");

  // Attachment parts
  for (const att of opts.attachments) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.contentType}; name="${att.filename.replace(/["\r\n]/g, "")}"`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push(`Content-Disposition: attachment; filename="${att.filename.replace(/["\r\n]/g, "")}"`);
    lines.push("");
    if (att.contentBase64) {
      lines.push(base64Wrap(att.contentBase64));
    }
    lines.push("");
  }

  lines.push(`--${boundary}--`);
  return lines.join(CRLF);
}
