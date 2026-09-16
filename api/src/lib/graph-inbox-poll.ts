// ── Branded inbox: Microsoft Graph mailbox poller ────────
// Owner directive 2026-09-10: every client-visible compliance inbox address is
// documents@cleartopayconstruction.com. This module makes that mailbox the
// INBOUND source: it polls the documents@ mailbox via Microsoft Graph
// Mail.Read (reusing the exact OAuth client-credentials auth from
// graph-mail.ts) and feeds every message with attachments into the same
// ingestInboundEmail core the /api/inbox/receive route uses — so sender-based
// tenant routing, dedup, and the unambiguous-match guard apply identically.
//
// Choice rationale (simplest robust option): no forwarding rules, no aliases,
// no new mailboxes — the app that already sends via Graph (Mail.Send
// permission) was verified to also hold Mail.Read for this mailbox, so the
// poller works today with the existing secrets. Messages the platform itself
// CC'd into documents@ (weekly/monthly reports, renewal reminders) are
// skipped by sender blocklist + self-CC detection so outbound loops can never
// be re-ingested as compliance documents.
import { getGraphAccessToken, graphMailConfigured } from "../graph-mail";
import { INBOX_ADDRESS } from "./inbox";
import { getDb } from "../db";
import { ingestInboundEmail } from "../routes/documents";

/** Opt-out flag: set DISABLE_GRAPH_INBOX_POLL=1 to turn the poller off. */
function pollEnabled(): boolean {
  return process.env.DISABLE_GRAPH_INBOX_POLL !== "1";
}
/** Addresses the platform itself sends FROM — an inbound message from one of
 * these is our own outbound copy, never a document submission. */
function ownSenderAddresses(): string[] {
  const set = new Set<string>();
  for (const v of [process.env.EMAIL_FROM_ADDRESS, "reports@cleartopayconstruction.com", "documents@cleartopayconstruction.com"]) {
    if (v && typeof v === "string") set.add(v.trim().toLowerCase());
  }
  return [...set];
}
interface GraphMessage {
  id: string;
  subject?: string | null;
  hasAttachments?: boolean;
  isRead?: boolean;
  internetMessageId?: string | null;
  receivedDateTime?: string | null;
  from?: { emailAddress?: { name?: string | null; address?: string | null } | null } | null;
  toRecipients?: Array<{ emailAddress?: { address?: string | null } | null }> | null;
  ccRecipients?: Array<{ emailAddress?: { address?: string | null } | null }> | null;
}
interface GraphAttachment {
  "@odata.type"?: string;
  name?: string | null;
  contentType?: string | null;
  contentBytes?: string | null;
  size?: number | null;
  isInline?: boolean | null;
}
async function graphJson(token: string, url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init?.headers ?? {}) },
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new Error(`[graph-inbox-poll] ${init?.method ?? "GET"} ${url.split("/v1.0/")[1] ?? url} failed HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { status: res.status, body };
}
/**
 * Polls the documents@ mailbox for unread messages WITH attachments and feeds
 * each through ingestInboundEmail (identical routing/dedup/guard as
 * /api/inbox/receive). Messages are marked read only after the ingest core
 * accepted them (including UNROUTED — the queue row preserves them for review,
 * and the dedup key prevents re-delivery). Idempotent: a poller crash between
 * ingest and mark-read re-delivers the message, which the dedup key absorbs.
 */
export async function pollDocumentsMailbox(): Promise<{ checked: number; processed: number; skipped: number; failed: number }> {
  if (!pollEnabled()) return { checked: 0, processed: 0, skipped: 0, failed: 0 };
  if (!graphMailConfigured()) {
    console.log("[graph-inbox-poll] Graph not configured — poller inactive");
    return { checked: 0, processed: 0, skipped: 0, failed: 0 };
  }
  const token = await getGraphAccessToken();
  const box = INBOX_ADDRESS;
  const own = ownSenderAddresses();
  const listUrl = `${process.env.GRAPH_API_BASE || "https://graph.microsoft.com/v1.0"}/users/${encodeURIComponent(box)}/messages?$top=10&$filter=hasAttachments eq true and isRead eq false&$select=id,subject,from,toRecipients,ccRecipients,hasAttachments,internetMessageId,receivedDateTime`;
  const { body } = await graphJson(token, listUrl);
  const messages: GraphMessage[] = Array.isArray(body?.value) ? body.value : [];
  // The poll set is "unread AND has attachments" ($top=10). Anything we decide
  // NOT to ingest must be marked read, or it stays in that window on every
  // future poll: our own CC'd report copies alone would eventually fill the 10
  // slots and hide a real vendor submission. Best-effort — a failure here only
  // costs a repeated skip, never a lost document.
  const apiBase = process.env.GRAPH_API_BASE || "https://graph.microsoft.com/v1.0";
  const markRead = async (id: string) => {
    try {
      await graphJson(token, `${apiBase}/users/${encodeURIComponent(box)}/messages/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
    } catch (err) {
      console.error(`[graph-inbox-poll] could not mark msg ${id} read:`, err instanceof Error ? err.message : err);
    }
  };
  let processed = 0, skipped = 0, failed = 0;
  for (const msg of messages) {
    try {
      const sender = msg.from?.emailAddress?.address?.trim().toLowerCase() ?? "";
      const tos = (msg.toRecipients ?? []).map((r) => r.emailAddress?.address?.trim().toLowerCase() ?? "").filter(Boolean);
      const ccs = (msg.ccRecipients ?? []).map((r) => r.emailAddress?.address?.trim().toLowerCase() ?? "").filter(Boolean);
      // Skip our own outbound (weekly/monthly reports CC the shared inbox so
      // they could otherwise be re-ingested as compliance documents).
      if (own.includes(sender)) { skipped++; await markRead(msg.id); continue; }
      const addressedToUs = tos.length === 0 || tos.includes(box);
      const selfCc = ccs.includes(box) && !tos.includes(box);
      if (!addressedToUs || selfCc) { skipped++; console.log(`[graph-inbox-poll] skipping msg ${msg.id} (self-CC or not addressed to ${box})`); await markRead(msg.id); continue; }
      // Download attachments (file attachments only).
      const attUrl = `${process.env.GRAPH_API_BASE || "https://graph.microsoft.com/v1.0"}/users/${encodeURIComponent(box)}/messages/${encodeURIComponent(msg.id)}/attachments`;
      const attRes = await graphJson(token, attUrl);
      const atts: Array<{ filename: string; content_type: string; content_base64: string }> = [];
      for (const a of (Array.isArray(attRes.body?.value) ? attRes.body.value : []) as GraphAttachment[]) {
        if (a.isInline) continue;
        const odt = a["@odata.type"] ?? "";
        if (!odt.includes("fileAttachment")) continue;
        if (!a.name || !a.contentType || !a.contentBytes) continue;
        atts.push({ filename: a.name, content_type: a.contentType, content_base64: a.contentBytes });
      }
      if (atts.length === 0) { skipped++; await markRead(msg.id); continue; }
      const result = await ingestInboundEmail(getDb(), {
        to_address: box,
        from_address: msg.from?.emailAddress?.address ?? null,
        from_name: msg.from?.emailAddress?.name ?? null,
        subject: msg.subject ?? null,
        message_id: msg.internetMessageId ?? msg.id,
        date: msg.receivedDateTime ?? null,
        attachments: atts,
      });
      processed++;
      if (!result.routed) console.warn(`[graph-inbox-poll] msg ${msg.id} ${result.httpBody.reason ?? "UNROUTED"} (queue ${result.queueId})`);
      else console.log(`[graph-inbox-poll] ingested msg ${msg.id} → tenant ${result.tenantId} (queue ${result.queueId})`);
      // Mark read so the poll set shrinks; dedup_key already guards re-delivery.
      await markRead(msg.id);
    } catch (err) {
      failed++;
      console.error(`[graph-inbox-poll] message ${msg.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[graph-inbox-poll] poll done: checked=${messages.length} processed=${processed} skipped=${skipped} failed=${failed}`);
  return { checked: messages.length, processed, skipped, failed };
}
