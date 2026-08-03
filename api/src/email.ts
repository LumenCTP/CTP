import { getDb } from "./db";
import type { ReportData } from "./reports";

// ── Email Identity ───────────────────────────────────────

const EMAIL_FROM_ADDRESS = "cleartopay-compliance-0d8d884b@ctomail.io";
const EMAIL_FROM_NAME = "ClearToPay Docs";
const EMAIL_REPLY_TO = "cleartopay-compliance-0d8d884b@ctomail.io";

// ── Email Sender ─────────────────────────────────────────

/**
 * Sends email by writing to the outgoing_email_queue table.
 *
 * The queue is processed by the platform's email delivery system.
 * Emails are also logged to email_log for audit purposes.
 *
 * From:     ClearToPay Compliance <cleartopay-compliance-0d8d884b@ctomail.io>
 * Reply-To: cleartopay-compliance-0d8d884b@ctomail.io
 *
 * To swap in a real email provider (SendGrid, AWS SES, Resend, etc.),
 * replace the queue insert with an HTTP fetch call.
 */
export function sendEmail(
  to: string[],
  subject: string,
  htmlBody: string,
  clientId?: number,
  vendorId?: number,
  emailType?: "weekly_report" | "monthly_report" | "renewal_reminder",
): void {
  const db = getDb();

  console.log("══════════════════════════════════════════════");
  console.log(`[email] QUEUING EMAIL`);
  console.log(`[email] From: ${EMAIL_FROM_NAME} <${EMAIL_FROM_ADDRESS}>`);
  console.log(`[email] Reply-To: ${EMAIL_REPLY_TO}`);
  console.log(`[email] To: ${to.join(", ")}`);
  console.log(`[email] Subject: ${subject}`);
  console.log(`[email] Type: ${emailType ?? "manual"}`);
  console.log("══════════════════════════════════════════════");

  // Log to email_log for every recipient
  const insertStmt = db.query(`
    INSERT INTO email_log (client_id, vendor_id, email_type, recipient_email, subject, status, sent_at)
    VALUES ($client_id, $vendor_id, $email_type, $recipient_email, $subject, 'queued', datetime('now'))
  `);

  for (const recipient of to) {
    insertStmt.run({
      $client_id: clientId ?? null,
      $vendor_id: vendorId ?? null,
      $email_type: emailType ?? "weekly_report",
      $recipient_email: recipient.trim(),
      $subject: subject,
    });

    // Queue for delivery
    db.query(`
      INSERT INTO outgoing_email_queue (from_address, from_name, reply_to, recipient_email, subject, html_body, client_id, vendor_id, email_type)
      VALUES ($from_addr, $from_name, $reply_to, $recipient, $subject, $body, $client_id, $vendor_id, $email_type)
    `).run({
      $from_addr: EMAIL_FROM_ADDRESS,
      $from_name: EMAIL_FROM_NAME,
      $reply_to: EMAIL_REPLY_TO,
      $recipient: recipient.trim(),
      $subject: subject,
      $body: htmlBody,
      $client_id: clientId ?? null,
      $vendor_id: vendorId ?? null,
      $email_type: emailType ?? "weekly_report",
    });
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
    payment_week: { monday: string; sunday: string };
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
      Payment Week: <strong>${formatDate(reportSummary.payment_week.monday)} – ${formatDate(reportSummary.payment_week.sunday)}</strong><br>
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
      Log in to your <a href="https://cleartopaycoi.ctonew.app" style="color: #1a56db;">ClearToPay dashboard</a> to view full details and manage your vendors.
    </p>
  </div>

  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
    This automated report was sent by ClearToPay Compliance. Reports are generated every Monday morning.
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
      Log in to your <a href="https://cleartopaycoi.ctonew.app" style="color: #1a56db;">ClearToPay dashboard</a> to view detailed compliance data and manage your vendors.
    </p>
  </div>

  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
    This automated report was sent by ClearToPay Compliance. Monthly reports are generated on the 1st of each month.
  </p>
</body>
</html>`;
}

export function buildRenewalReminderEmail(
  vendorName: string,
  documentType: string,
  expirationDate: string,
  daysUntilExpiry: number,
): string {
  const urgencyColor = daysUntilExpiry <= 7 ? "#dc2626" : daysUntilExpiry <= 15 ? "#d97706" : "#374151";
  const urgencyText = daysUntilExpiry === 0
    ? `expires <strong>today</strong>`
    : `expires in <strong>${daysUntilExpiry} days</strong>`;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${urgencyColor}; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 18px;">Document Expiration Reminder</h1>
  </div>

  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
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
      Please submit the updated ${documentType} at your earliest convenience to avoid any payment delays.
    </p>

    <p style="margin: 0; font-size: 13px; color: #6b7280;">
      Documents can be emailed directly to <a href="mailto:${EMAIL_FROM_ADDRESS}" style="color: #1a56db;">${EMAIL_FROM_ADDRESS}</a>.
    </p>
  </div>

  <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
    This is an automated reminder from ClearToPay Compliance on behalf of your client.
  </p>
</body>
</html>`;
}

// ── Helper: Parse comma-separated email string ──────────

export function parseRecipients(recipientsStr: string | null): string[] {
  if (!recipientsStr) return [];
  return recipientsStr
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
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
