// ── Microsoft 365 outbound delivery via Microsoft Graph sendMail ────────────
// PRIMARY delivery path for all product email once the owner's Entra app
// registration exists. Authenticates with the OAuth 2.0 client-credentials
// flow (Mail.Send application permission) and sends through
//   POST https://graph.microsoft.com/v1.0/users/{from}/sendMail
// which sends AS the mailbox user ({from} = EMAIL_FROM_ADDRESS), so messages
// go out From documents@cleartopayconstruction.com with the owner's SPF/DKIM.
//
// The three secrets are injected by the platform as env vars (NOT in .env and
// never hardcoded here):
//   M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET
// `graphMailConfigured()` is true only when ALL three are present, and that is
// the condition email.ts uses to pick this path FIRST (before the SMTP-AUTH
// path and before the platform queue). See sendEmail() in email.ts for the
// full fallback order.
//
// No credentials exist yet (owner is creating the Entra app registration), so
// everything here is verified via the stub-fetch harness in
// api/scripts/test-graph-mail.ts — see that file for the exact request shapes
// this module produces.

// ── Config / capability ──────────────────────────────────

export const GRAPH_TOKEN_URL_BASE = "https://login.microsoftonline.com";
export const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
export const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
/** Refresh the cached token this long before its `expires_in` elapses. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** True only when all three M365 client-credentials secrets are set. */
export function graphMailConfigured(): boolean {
  return (
    !!process.env.M365_TENANT_ID &&
    !!process.env.M365_CLIENT_ID &&
    !!process.env.M365_CLIENT_SECRET
  );
}

// ── OAuth 2.0 token (client-credentials) ──────────────────

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCacheEntry | null = null;

/** Test seam: clear the cached token so the next call refreshes. */
export function resetGraphTokenCache(): void {
  tokenCache = null;
}

/** Test seam: inspect the cache (harness uses it to prove the skew refresh). */
export function getGraphTokenCache(): TokenCacheEntry | null {
  return tokenCache;
}

/**
 * Obtains a Graph access token via the client-credentials flow:
 *   POST {GRAPH_TOKEN_URL_BASE}/{M365_TENANT_ID}/oauth2/v2.0/token
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=client_credentials
 *   scope=https://graph.microsoft.com/.default
 *   client_id={M365_CLIENT_ID}
 *   client_secret={M365_CLIENT_SECRET}
 * Caches the token and reuses it until ~5 minutes before `expires_in` elapses,
 * then fetches a fresh one. Errors surface the HTTP status and body so a
 * misconfigured app registration is diagnosable from the API log ([graph-mail]).
 */
export async function getGraphAccessToken(): Promise<string> {
  const tenantId = process.env.M365_TENANT_ID;
  const clientId = process.env.M365_CLIENT_ID;
  const clientSecret = process.env.M365_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "[graph-mail] M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET must all be set for Graph delivery",
    );
  }
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
    return tokenCache.token;
  }
  const tokenUrl = `${GRAPH_TOKEN_URL_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const form = new URLSearchParams();
  form.set("grant_type", "client_credentials");
  form.set("scope", GRAPH_DEFAULT_SCOPE);
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(
      `[graph-mail] Token request failed HTTP ${res.status}: ${bodyText.slice(0, 500)}`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    throw new Error(
      `[graph-mail] Token response missing access_token: ${JSON.stringify(data).slice(0, 500)}`,
    );
  }
  const expiresInMs = (data.expires_in && data.expires_in > 0 ? data.expires_in : 3600) * 1000;
  tokenCache = { token: data.access_token, expiresAt: Date.now() + expiresInMs };
  console.log(`[graph-mail] Token acquired (expires_in=${Math.round(expiresInMs / 1000)}s, cached until ${new Date(tokenCache.expiresAt).toISOString()})`);
  return data.access_token;
}

// ── Graph sendMail payload ───────────────────────────────

/** Attachment part with base64 content already resolved (see email.ts). */
export interface ResolvedAttachmentPart {
  filename: string;
  contentType: string;
  contentBase64: string | null;
}

export interface GraphSendPayload {
  message: {
    subject: string;
    body: { contentType: "HTML" | "Text"; content: string };
    toRecipients: Array<{ emailAddress: { address: string } }>;
    ccRecipients: Array<{ emailAddress: { address: string } }>;
    attachments: Array<{
      "@odata.type": "#microsoft.graph.fileAttachment";
      name: string;
      contentType: string;
      contentBytes: string;
    }>;
  };
  saveToSentItems: boolean;
}

/**
 * Builds the Graph sendMail JSON body from the same data the SMTP multipart
 * builder uses (subject / body / to / cc / resolved attachments). Exported as
 * a pure function so the harness can assert the exact shape without network.
 * `cc` is passed in already deduped against `to` by the caller (email.ts
 * applies the CC-documents@ rule before calling).
 */
export function buildGraphSendPayload(opts: {
  subject: string;
  htmlBody: string;
  bodyContentType?: "HTML" | "Text";
  to: string[];
  cc: string[];
  attachments: ResolvedAttachmentPart[];
}): GraphSendPayload {
  return {
    message: {
      subject: opts.subject.replace(/[\r\n]/g, " "),
      body: {
        contentType: opts.bodyContentType ?? "HTML",
        content: opts.htmlBody,
      },
      toRecipients: opts.to.map((addr) => ({ emailAddress: { address: addr.trim() } })),
      ccRecipients: opts.cc.map((addr) => ({ emailAddress: { address: addr.trim() } })),
      attachments: opts.attachments.map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.filename,
        contentType: a.contentType,
        contentBytes: a.contentBase64 ?? "",
      })),
    },
    saveToSentItems: true,
  };
}

// ── Send ─────────────────────────────────────────────────

export interface GraphMailDelivery {
  /** The M365 mailbox identity — Graph sends AS this user (the URL user). */
  fromAddress: string;
  to: string[];
  /** CC recipients, deduped against `to` by the caller. */
  cc: string[];
  subject: string;
  htmlBody: string;
  bodyContentType?: "HTML" | "Text";
  /** Attachments with base64 content already resolved. */
  attachments: ResolvedAttachmentPart[];
}

export interface GraphMailResult {
  ok: boolean;
  /** Graph sendMail returns 202 Accepted with no message id — always null. */
  messageId: null;
  /** Human-readable server outcome, e.g. "202 Accepted". */
  serverResponse: string;
}

/**
 * Sends a message via Graph sendMail as `fromAddress`:
 *   POST {GRAPH_API_BASE}/users/{fromAddress}/sendMail
 *   Authorization: Bearer {access_token}
 *   Content-Type: application/json
 *   body = buildGraphSendPayload(...)  (saveToSentItems: true)
 * Throws on HTTP error (caller records email_log 'error'); returns
 * { ok: true, messageId: null, serverResponse: "202 Accepted" } on success.
 */
export async function sendViaGraphMail(d: GraphMailDelivery): Promise<GraphMailResult> {
  if (!graphMailConfigured()) {
    throw new Error("[graph-mail] M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET must all be set for Graph delivery");
  }
  const token = await getGraphAccessToken();
  const payload = buildGraphSendPayload({
    subject: d.subject,
    htmlBody: d.htmlBody,
    bodyContentType: d.bodyContentType,
    to: d.to,
    cc: d.cc,
    attachments: d.attachments,
  });
  const url = `${GRAPH_API_BASE}/users/${d.fromAddress}/sendMail`;
  const envelope = [...d.to, ...d.cc];
  console.log(`[graph-mail] Sending via Graph sendMail → ${envelope.join(", ")}`);
  console.log(`[graph-mail] Endpoint: ${url}`);
  console.log(`[graph-mail] From: ${d.fromAddress} | Subject: ${d.subject.replace(/[\r\n]/g, " ")} | To: ${d.to.join(", ")} | Cc: ${d.cc.join(", ") || "(none)"} | Attachments: ${d.attachments.length}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.error(`[graph-mail] sendMail failed HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
    throw new Error(`[graph-mail] Graph sendMail failed HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  }
  // Graph sendMail answers 202 Accepted with an empty body on success.
  const serverResponse = res.status === 202 ? "202 Accepted" : `HTTP ${res.status}`;
  console.log(`[graph-mail] DELIVERED (${serverResponse})`);
  return { ok: true, messageId: null, serverResponse };
}
