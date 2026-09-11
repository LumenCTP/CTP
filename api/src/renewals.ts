/**
 * Shared renewal-reminder windowing logic.
 *
 * Used by BOTH the daily scheduler scan (scheduler.ts checkRenewals) and the
 * manual test/preview endpoint (routes/emails.ts POST /api/emails/test-renewal)
 * so a preview is a faithful preview of the scheduled job: same windows, same
 * due-window selection, same dedup key, same subject phrasing.
 *
 * Pure functions — no DB access, no email sending.
 */

/** Reminder windows: days before expiration at which a renewal reminder is due. */
export const REMINDER_WINDOWS: number[] = [30, 15, 7, 0];

/**
 * Pick the single reminder window that is due for a document with `diffDays`
 * days left until expiration (negative when already expired).
 *
 * A window is DUE once `diffDays <= window` — send-if-not-sent semantics — so
 * a window whose exact calendar day was missed (API/process down on that day,
 * long weekend, etc.) still fires on the next daily scan instead of being
 * permanently skipped. Only the MOST URGENT (smallest) due window is returned
 * so at most ONE reminder per document per scan is ever sent: an
 * already-expired doc gets a single "expires today" catch-up instead of a
 * 4-email burst, and a doc that crossed several thresholds during a long
 * outage gets the most relevant one. Per-document/window dedup
 * (renewal_reminders_sent, via hasReminderBeenSent/markReminderSent) then
 * keeps each doc+window at exactly one send, no matter how many scans pass.
 *
 * Returns null when no window is due yet (doc expires more than 30 days out).
 */
export function findDueReminderWindow(diffDays: number): number | null {
  for (const window of [...REMINDER_WINDOWS].sort((a, b) => a - b)) {
    if (diffDays <= window) return window;
  }
  return null;
}

/**
 * Human-readable expiry phrase used in the reminder subject line. Shared by the
 * scheduled job and the test endpoint so the email content is byte-identical on
 * both paths (remainingDays is clamped at 0 by the caller for expired docs).
 */
export function renewalExpiryPhrase(remainingDays: number): string {
  if (remainingDays <= 0) return "today";
  return `in ${remainingDays} ${remainingDays === 1 ? "day" : "days"}`;
}