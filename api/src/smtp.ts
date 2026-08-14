import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

// ── M365 SMTP Delivery (direct, branded outbound) ─────────
// When ClearToPaySMTP (an app password for the owner's Microsoft 365
// mailbox) is present in the environment, ALL product email is delivered
// directly through smtp.office365.com so messages go out From the owner's
// domain (documents@cleartopayconstruction.com) with the owner's SPF/DKIM,
// and every message is CC'd to the documents@ mailbox (the M365 Sent folder
// then doubles as an automatic backup).
//
// When ClearToPaySMTP is NOT set (dev/test environments), the platform
// delivery path (outgoing_email_queue + process-queue worker) remains the
// fallback — see sendEmail() in email.ts. SMTP wins whenever the env var is
// present.

export const SMTP_CC_ADDRESS = "documents@cleartopayconstruction.com";

export function smtpConfigured(): boolean {
  const p = process.env.ClearToPaySMTP;
  return typeof p === "string" && p.length > 0;
}

function normalizeEmail(addr: string): string {
  return addr.trim().toLowerCase();
}

/** Lower-cased, trimmed, de-duplicated address list. */
function dedupeAddrs(addrs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const n = normalizeEmail(a);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(a.trim());
  }
  return out;
}

export interface SmtpDelivery {
  /** Authenticating sender — must be the M365 mailbox the app password belongs to. */
  fromAddress: string;
  fromName: string;
  replyTo: string;
  /** Envelope + header recipients. */
  to: string[];
  /** CC recipients (deduped against `to`). */
  cc: string[];
  subject: string;
  /** Complete RFC 2822 MIME message (headers + body), e.g. from buildMultipartMessage. */
  mimeMessage: string;
}

export interface SmtpResult {
  ok: boolean;
  messageId: string | null;
  /** The final SMTP server response line(s), e.g. "250 2.6.0 ... Queued mail for delivery". */
  serverResponse: string;
}

let cachedTransport: Transporter | null = null;

function getTransport(fromAddress: string): Transporter {
  if (cachedTransport) return cachedTransport;
  const pass = process.env.ClearToPaySMTP;
  if (!pass) throw new Error("ClearToPaySMTP is not set — cannot deliver via M365 SMTP");
  cachedTransport = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    secure: false, // STARTTLS
    requireTLS: true,
    auth: { user: fromAddress, pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });
  return cachedTransport;
}

/**
 * Sends a prebuilt MIME message through smtp.office365.com with the given
 * envelope. `cc` addresses are added to the SMTP envelope (RCPT TO) so the
 * CC is actually delivered, and they must also appear in the Cc: header of
 * the MIME (buildMultipartMessage emits that). Recipients already in `to`
 * are not duplicated into `cc`.
 */
export async function sendViaSmtp(d: SmtpDelivery): Promise<SmtpResult> {
  const transport = getTransport(d.fromAddress);
  // Envelope recipients = To + CC, de-duplicated (case-insensitive).
  const envelopeTo = dedupeAddrs([...d.to, ...d.cc]);
  if (envelopeTo.length === 0) throw new Error("SMTP delivery: no recipients");
  console.log(`[smtp] Sending via smtp.office365.com:587 (STARTTLS) → ${envelopeTo.join(", ")}`);
  console.log(`[smtp] From: ${d.fromName} <${d.fromAddress}> | Reply-To: ${d.replyTo} | Subject: ${d.subject.replace(/[\r\n]/g, " ")}`);
  try {
    const info = await transport.sendMail({
      envelope: { from: d.fromAddress, to: envelopeTo },
      raw: d.mimeMessage,
    });
    const serverResponse = Array.isArray(info.response) ? info.response.join("\n") : (info.response ?? "");
    console.log(`[smtp] DELIVERED messageId=${info.messageId || "(none)"} response=${serverResponse.slice(0, 300)}`);
    return { ok: true, messageId: info.messageId || null, serverResponse };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[smtp] SEND FAILED: ${msg}`);
    throw err;
  }
}

/** Best-effort close of the cached transport (used on API shutdown paths, never fatal). */
export function closeSmtpTransport(): void {
  if (cachedTransport) {
    try {
      cachedTransport.close();
    } catch {
      // ignore
    }
    cachedTransport = null;
  }
}
