#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// Test harness for the Microsoft Graph sendMail integration (api/src/graph-mail.ts
// + the wiring in api/src/email.ts). NO real credentials: globalThis.fetch is
// stubbed, so nothing leaves the machine.
//
// Run:  cd api && bun run scripts/test-graph-mail.ts
//       (run with the API stopped — see skill cleartopay-db-verify-offline —
//        to avoid SQLite contention; restart the API afterwards)
//
// Proves (all offline):
//   1. sendEmail() delivery-path ordering: graph > smtp > queue
//   2. buildGraphSendPayload shape (subject/body/toRecipients/ccRecipients/
//      fileAttachment base64/saveToSentItems)
//   3. OAuth token request shape (URL, form fields, content-type) + cache:
//      reused while fresh, refreshed inside the 5-min skew window
//   4. sendViaGraphMail request shape (endpoint /users/<from>/sendMail,
//      Authorization Bearer, JSON body incl. attachments + CC, saveToSentItems)
//   5. sendEmail() Graph path: email_log 'sent' + NO queue row; CC dedupe
//      when the recipient already IS documents@
//   6. sendEmail() Graph path failure: email_log 'error' with [graph-mail] msg
//   7. sendEmail() queue fallback (no M365/SMTP vars): outgoing_email_queue
//      row + email_log 'queued' — the pre-existing platform path still works
//
// Exit code: 0 only when ALL checks PASS.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "../src/db";
import {
  buildGraphSendPayload,
  getGraphAccessToken,
  getGraphTokenCache,
  graphMailConfigured,
  resetGraphTokenCache,
  sendViaGraphMail,
  GRAPH_API_BASE,
  GRAPH_TOKEN_URL_BASE,
  GRAPH_DEFAULT_SCOPE,
} from "../src/graph-mail";
import { getDeliveryPath, sendEmail } from "../src/email";

const M365 = {
  M365_TENANT_ID: "tenant-abc-123",
  M365_CLIENT_ID: "client-xyz-456",
  M365_CLIENT_SECRET: "client-secret-value",
};
const FROM = "documents@cleartopayconstruction.com";
const CC = "documents@cleartopayconstruction.com";

// ── Env helpers ──────────────────────────────────────────
const savedEnv = new Map<string, string | undefined>();
for (const k of ["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET", "ClearToPaySMTP"]) {
  savedEnv.set(k, process.env[k]);
}
function setEnv(e: Record<string, string>): void {
  for (const [k, v] of Object.entries(e)) process.env[k] = v;
}
function clearEnv(keys: string[]): void {
  for (const k of keys) delete process.env[k];
}
function resetEnv(): void {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── fetch stub ───────────────────────────────────────────
const originalFetch = globalThis.fetch;
interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: unknown;
  form: URLSearchParams | null;
}
let calls: CapturedCall[] = [];
let tokenResponse: { status: number; body: unknown } = {
  status: 200,
  body: { access_token: "TOKEN-123", expires_in: 3600, token_type: "Bearer" },
};
let sendMailResponse: { status: number; body: unknown } = { status: 202, body: null };

function installFetchStub(): void {
  calls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")) as string;
    const headers: Record<string, string> = {};
    const h = init?.headers ?? {};
    if (typeof h === "object" && h !== null) {
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    }
    const bodyText = init?.body ? String(init.body) : "";
    let form: URLSearchParams | null = null;
    if ((headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
      form = new URLSearchParams(bodyText);
    }
    calls.push({ url, method, headers, bodyText, bodyJson: null, form });
    if (url.includes("/oauth2/v2.0/token")) {
      const { status, body } = tokenResponse;
      return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/sendMail")) {
      const call = calls[calls.length - 1];
      try { call.bodyJson = JSON.parse(bodyText); } catch { /* keep null */ }
      const { status, body } = sendMailResponse;
      return new Response(status === 204 || body === null ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`[harness] Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ── DB row tracking / cleanup ────────────────────────────
function maxId(table: string): number {
  const row = getDb().query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number };
  return row.m;
}
function deleteRowsAfter(table: string, id: number): void {
  getDb().query(`DELETE FROM ${table} WHERE id > $id`).run({ $id: id });
}

// ── Result tracking ──────────────────────────────────────
type Status = "PASS" | "FAIL";
const results: { check: number; name: string; status: Status; detail: string }[] = [];
let exitCode = 0;
function record(check: number, name: string, ok: boolean, detail: string): void {
  results.push({ check, name, status: ok ? "PASS" : "FAIL", detail });
  if (!ok) exitCode = 1;
}
function eq(got: unknown, want: unknown): boolean {
  return JSON.stringify(got) === JSON.stringify(want);
}
function check(cond: boolean, label: string, got: unknown, want: unknown): boolean {
  if (!cond) {
    console.error(`    ✗ ${label}\n      got : ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
  return cond;
}

const TEST_SUFFIX = Date.now();
const SUBJECT = `Graph harness ${TEST_SUFFIX}`;
const BODY = `<p>Hello from the graph-mail harness ${TEST_SUFFIX}</p>`;
const ATTACHMENT = {
  filename: "ClearToPay_Acme_123.pdf",
  contentType: "application/pdf",
  contentBase64: "JVBERi0xLg==",
};

// ── Check 1: delivery-path ordering ──────────────────────
async function check1(): Promise<void> {
  console.log("── Check 1: sendEmail() delivery-path ordering ──");
  resetGraphTokenCache();
  clearEnv(["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET", "ClearToPaySMTP"]);
  record(1, "no M365, no SMTP → queue", getDeliveryPath() === "queue",
    `getDeliveryPath()=${getDeliveryPath()} (want queue)`);

  clearEnv(["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET"]);
  setEnv({ ClearToPaySMTP: "app-password" });
  record(1, "SMTP only → smtp", getDeliveryPath() === "smtp",
    `getDeliveryPath()=${getDeliveryPath()} (want smtp)`);

  setEnv(M365);
  clearEnv(["ClearToPaySMTP"]);
  record(1, "M365 only → graph", getDeliveryPath() === "graph",
    `getDeliveryPath()=${getDeliveryPath()} (want graph)`);

  setEnv({ ClearToPaySMTP: "app-password" });
  record(1, "M365 + SMTP → graph (primary wins)", getDeliveryPath() === "graph",
    `getDeliveryPath()=${getDeliveryPath()} (want graph)`);
  clearEnv(["ClearToPaySMTP"]);
}

// ── Check 2: buildGraphSendPayload shape ─────────────────
function check2(): void {
  console.log("── Check 2: buildGraphSendPayload JSON shape ──");
  const payload = buildGraphSendPayload({
    subject: SUBJECT,
    htmlBody: BODY,
    to: ["ceo@acme.test", "cf@acme.test"],
    cc: [CC],
    attachments: [ATTACHMENT],
  });
  const ok =
    check(payload.message.subject === SUBJECT, "message.subject", payload.message.subject, SUBJECT) &&
    check(payload.message.body.contentType === "HTML", "body.contentType", payload.message.body.contentType, "HTML") &&
    check(payload.message.body.content === BODY, "body.content", payload.message.body.content, BODY) &&
    check(eq(payload.message.toRecipients, [{ emailAddress: { address: "ceo@acme.test" } }, { emailAddress: { address: "cf@acme.test" } }]),
      "toRecipients", payload.message.toRecipients, [{ emailAddress: { address: "ceo@acme.test" } }, { emailAddress: { address: "cf@acme.test" } }]) &&
    check(eq(payload.message.ccRecipients, [{ emailAddress: { address: CC } }]), "ccRecipients", payload.message.ccRecipients, [CC]) &&
    check(payload.message.attachments[0]?.["@odata.type"] === "#microsoft.graph.fileAttachment",
      "attachment @odata.type", payload.message.attachments[0]?.["@odata.type"], "#microsoft.graph.fileAttachment") &&
    check(payload.message.attachments[0]?.name === ATTACHMENT.filename, "attachment name", payload.message.attachments[0]?.name, ATTACHMENT.filename) &&
    check(payload.message.attachments[0]?.contentType === "application/pdf", "attachment contentType", payload.message.attachments[0]?.contentType, "application/pdf") &&
    check(payload.message.attachments[0]?.contentBytes === ATTACHMENT.contentBase64, "attachment contentBytes (base64)", payload.message.attachments[0]?.contentBytes, ATTACHMENT.contentBase64) &&
    check(payload.saveToSentItems === true, "saveToSentItems", payload.saveToSentItems, true);
  record(2, "Graph sendMail payload shape", ok, ok ? "all fields verified" : "see failures above");
}

// ── Check 3: token request shape + cache ─────────────────
async function check3(): Promise<void> {
  console.log("── Check 3: OAuth token request shape + cache ──");
  setEnv(M365);
  resetGraphTokenCache();
  installFetchStub();
  try {
    const t1 = await getGraphAccessToken();
    const tok = calls[0];
    const wantUrl = `${GRAPH_TOKEN_URL_BASE}/${M365.M365_TENANT_ID}/oauth2/v2.0/token`;
    const okShape =
      check(t1 === "TOKEN-123", "returns access_token", t1, "TOKEN-123") &&
      check(tok?.url === wantUrl, "token URL", tok?.url, wantUrl) &&
      check(tok?.method === "POST", "token method", tok?.method, "POST") &&
      check(tok?.headers["content-type"] === "application/x-www-form-urlencoded", "token content-type", tok?.headers["content-type"], "application/x-www-form-urlencoded") &&
      check(tok?.form?.get("grant_type") === "client_credentials", "grant_type", tok?.form?.get("grant_type"), "client_credentials") &&
      check(tok?.form?.get("scope") === GRAPH_DEFAULT_SCOPE, "scope", tok?.form?.get("scope"), GRAPH_DEFAULT_SCOPE) &&
      check(tok?.form?.get("client_id") === M365.M365_CLIENT_ID, "client_id", tok?.form?.get("client_id"), M365.M365_CLIENT_ID) &&
      check(tok?.form?.get("client_secret") === M365.M365_CLIENT_SECRET, "client_secret", tok?.form?.get("client_secret"), M365.M365_CLIENT_SECRET);
    record(3, "token request shape", okShape, okShape ? "URL + form fields verified" : "see failures above");

    const t2 = await getGraphAccessToken();
    record(3, "token cache: fresh token reused (no refetch)",
      t2 === "TOKEN-123" && calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length === 1,
      `token fetches=${calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length} (want 1)`);

    // Simulate clock advance: push expiresAt inside the 5-min refresh skew.
    const cache = getGraphTokenCache();
    if (cache) cache.expiresAt = Date.now() + 60_000; // 1 min left < 5 min skew
    tokenResponse = { status: 200, body: { access_token: "TOKEN-456", expires_in: 3600 } };
    const t3 = await getGraphAccessToken();
    record(3, "token cache: refreshes inside 5-min skew window",
      t3 === "TOKEN-456" && calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length === 2,
      `token=${t3}, token fetches=${calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length} (want 2)`);

    resetGraphTokenCache();
    const t4 = await getGraphAccessToken();
    record(3, "token cache: reset forces refetch",
      t4 === "TOKEN-456" && calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length === 3,
      `token=${t4}, token fetches=${calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length} (want 3)`);
  } finally {
    restoreFetch();
    tokenResponse = { status: 200, body: { access_token: "TOKEN-123", expires_in: 3600, token_type: "Bearer" } };
  }
}

// ── Check 4: sendViaGraphMail request shape ──────────────
async function check4(): Promise<void> {
  console.log("── Check 4: sendViaGraphMail request shape ──");
  setEnv(M365);
  resetGraphTokenCache();
  installFetchStub();
  try {
    const res = await sendViaGraphMail({
      fromAddress: FROM,
      to: ["ceo@acme.test"],
      cc: [CC],
      subject: SUBJECT,
      htmlBody: BODY,
      bodyContentType: "HTML",
      attachments: [{ ...ATTACHMENT }],
    });
    const sendCall = calls.find((c) => c.url.endsWith("/sendMail"));
    const wantUrl = `${GRAPH_API_BASE}/users/${FROM}/sendMail`;
    const wantPayload = {
      message: {
        subject: SUBJECT,
        body: { contentType: "HTML", content: BODY },
        toRecipients: [{ emailAddress: { address: "ceo@acme.test" } }],
        ccRecipients: [{ emailAddress: { address: CC } }],
        attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: ATTACHMENT.filename, contentType: "application/pdf", contentBytes: ATTACHMENT.contentBase64 }],
      },
      saveToSentItems: true,
    };
    const ok =
      check(res.ok === true && res.serverResponse === "202 Accepted", "result", res, "ok:true, 202 Accepted") &&
      check(sendCall?.url === wantUrl, "sendMail URL", sendCall?.url, wantUrl) &&
      check(sendCall?.method === "POST", "sendMail method", sendCall?.method, "POST") &&
      check(sendCall?.headers["authorization"] === "Bearer TOKEN-123", "Authorization header", sendCall?.headers["authorization"], "Bearer TOKEN-123") &&
      check(sendCall?.headers["content-type"] === "application/json", "content-type", sendCall?.headers["content-type"], "application/json") &&
      check(eq(sendCall?.bodyJson, wantPayload), "JSON body (incl. attachments + CC + saveToSentItems)", sendCall?.bodyJson, wantPayload);
    const tokenFetches = calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length;
    const sendFetches = calls.filter((c) => c.url.endsWith("/sendMail")).length;
    const okCounts = tokenFetches === 1 && sendFetches === 1;
    if (!okCounts) console.error(`    ✗ fetch counts: token=${tokenFetches} (want 1), sendMail=${sendFetches} (want 1)`);
    record(4, "Graph sendMail request shape", ok && okCounts,
      ok && okCounts ? "endpoint + Authorization + JSON body verified" : "see failures above");
  } finally {
    restoreFetch();
  }
}

// ── Check 5: sendEmail() Graph path success ──────────────
async function check5(): Promise<void> {
  console.log("── Check 5: sendEmail() Graph path — success + no queue row ──");
  setEnv(M365);
  resetGraphTokenCache();
  installFetchStub();
  const db = getDb();
  const logBefore = maxId("email_log");
  const queueBefore = maxId("outgoing_email_queue");
  try {
    await sendEmail(["ceo@acme.test"], SUBJECT, BODY, undefined, undefined, "weekly_report");
    const logRows = db.query(
      "SELECT recipient_email, subject, status FROM email_log WHERE id > $id AND subject = $subject",
    ).all({ $id: logBefore, $subject: SUBJECT }) as Array<{ recipient_email: string; subject: string; status: string }>;
    const queueAfter = maxId("outgoing_email_queue");
    const okLog = logRows.length === 1 && logRows[0].recipient_email === "ceo@acme.test" && logRows[0].status === "sent";
    const okNoQueue = queueAfter === queueBefore;
    if (!okLog) console.error(`    ✗ email_log rows=${JSON.stringify(logRows)} (want 1 'sent' row)`);
    if (!okNoQueue) console.error(`    ✗ queue grew ${queueBefore} → ${queueAfter} (want unchanged)`);
    record(5, "email_log 'sent' + no queue row", okLog && okNoQueue,
      okLog && okNoQueue ? "1 sent row, queue untouched" : "see failures above");

    // CC dedupe: recipient IS documents@ → no CC on the message.
    calls = [];
    await sendEmail([CC], `${SUBJECT} dedupe`, BODY, undefined, undefined, "weekly_report");
    const dedupeCall = calls.find((c) => c.url.endsWith("/sendMail"));
    const body = dedupeCall?.bodyJson as any;
    const okDedupe = body?.message?.ccRecipients?.length === 0 && body?.message?.toRecipients?.[0]?.emailAddress?.address === CC;
    if (!okDedupe) console.error(`    ✗ dedupe call body=${JSON.stringify(body)} (want ccRecipients: [])`);
    record(5, "CC dedupe when recipient IS documents@", okDedupe, okDedupe ? "ccRecipients []" : "see failure above");
  } finally {
    deleteRowsAfter("email_log", logBefore);
    restoreFetch();
  }
}

// ── Check 6: sendEmail() Graph path failure ──────────────
async function check6(): Promise<void> {
  console.log("── Check 6: sendEmail() Graph path — HTTP error → email_log 'error' ──");
  setEnv(M365);
  resetGraphTokenCache();
  installFetchStub();
  sendMailResponse = {
    status: 400,
    body: { error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } },
  };
  const db = getDb();
  const logBefore = maxId("email_log");
  try {
    await sendEmail(["ceo@acme.test"], SUBJECT, BODY, undefined, undefined, "weekly_report");
    const logRows = db.query(
      "SELECT status, error_message FROM email_log WHERE id > $id AND subject = $subject",
    ).all({ $id: logBefore, $subject: SUBJECT }) as Array<{ status: string; error_message: string | null }>;
    const ok = logRows.length === 1 && logRows[0].status === "error" &&
      (logRows[0].error_message ?? "").includes("[graph-mail]") && (logRows[0].error_message ?? "").includes("400");
    if (!ok) console.error(`    ✗ email_log rows=${JSON.stringify(logRows)} (want 1 'error' row with [graph-mail] HTTP 400)`);
    record(6, "email_log 'error' with Graph error body surfaced", ok, ok ? "error recorded" : "see failure above");
  } finally {
    deleteRowsAfter("email_log", logBefore);
    restoreFetch();
    sendMailResponse = { status: 202, body: null };
  }
}

// ── Check 7: queue fallback ──────────────────────────────
async function check7(): Promise<void> {
  console.log("── Check 7: queue fallback (no M365 / no SMTP env) ──");
  clearEnv(["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET", "ClearToPaySMTP"]);
  resetGraphTokenCache();
  const db = getDb();
  const logBefore = maxId("email_log");
  const queueBefore = maxId("outgoing_email_queue");
  const qSubject = `Queue fallback ${TEST_SUFFIX}`;
  try {
    await sendEmail(["fallback-test@cleartopay.test"], qSubject, "<p>queue fallback</p>", undefined, undefined, "weekly_report");
    const queueRows = db.query(
      "SELECT from_address, recipient_email, subject, status, email_type FROM outgoing_email_queue WHERE id > $id AND subject = $subject",
    ).all({ $id: queueBefore, $subject: qSubject }) as Array<{ from_address: string; recipient_email: string; subject: string; status: string; email_type: string }>;
    const logRows = db.query(
      "SELECT recipient_email, status FROM email_log WHERE id > $id AND subject = $subject",
    ).all({ $id: logBefore, $subject: qSubject }) as Array<{ recipient_email: string; status: string }>;
    const ok = queueRows.length === 1 &&
      queueRows[0].from_address === FROM &&
      queueRows[0].recipient_email === "fallback-test@cleartopay.test" &&
      queueRows[0].status === "queued" &&
      queueRows[0].email_type === "weekly_report" &&
      logRows.length === 1 && logRows[0].status === "queued";
    if (!ok) {
      console.error(`    ✗ queue rows=${JSON.stringify(queueRows)}`);
      console.error(`    ✗ email_log rows=${JSON.stringify(logRows)} (want 1 'queued' row)`);
    }
    record(7, "queue fallback intact (outgoing_email_queue + email_log 'queued')", ok,
      ok ? "queue row + 'queued' log verified" : "see failures above");
  } finally {
    deleteRowsAfter("outgoing_email_queue", queueBefore);
    deleteRowsAfter("email_log", logBefore);
  }
}

// ── main ─────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════");
  console.log("graph-mail harness — NO real credentials, fetch is stubbed");
  console.log(`graphMailConfigured() at start: ${graphMailConfigured()} (must be false — secrets not deployed yet)`);
  if (graphMailConfigured()) {
    console.error("REFUSING TO RUN: M365_* env vars are already present. This harness only");
    console.error("runs against stubbed fetch; unset M365_TENANT_ID/M365_CLIENT_ID/M365_CLIENT_SECRET and retry.");
    process.exit(2);
  }
  try {
    await check1();
    check2();
    await check3();
    await check4();
    await check5();
    await check6();
    await check7();
  } catch (err) {
    console.error(`[harness] UNEXPECTED ERROR: ${err instanceof Error ? err.stack : String(err)}`);
    exitCode = 1;
  } finally {
    restoreFetch();
    resetEnv();
  }
  console.log("");
  console.log("── Results ───────────────────────────────────────────");
  for (const r of results) console.log(`  Check ${r.check}  ${r.status.padEnd(4)}  ${r.name}`);
  const fails = results.filter((r) => r.status === "FAIL");
  if (fails.length > 0) {
    console.log(`\n${fails.length} FAILED — see ✗ lines above`);
  } else {
    console.log(`\nAll ${results.length} checks PASSED (${new Set(results.map((r) => r.check)).size} check groups)`);
  }
  process.exit(exitCode);
}

main();
