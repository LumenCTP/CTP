/**
 * Smoke test for POST /api/vendors/:id/request-docs (client-initiated "Request
 * updated docs" vendor email).
 *
 * HOW IT STAYS SAFE: it runs the REAL route module in-process (Hono app, same
 * auth/tenant middleware as index.ts) with the M365 Graph + M365 SMTP
 * credentials DELETED from the environment, so every send takes the platform
 * queue branch (outgoing_email_queue + email_log 'queued'). No live email is
 * ever delivered, and the queue rows it creates are deleted at the end.
 *
 * It seeds throwaway tenants/clients/vendors in the API's SQLite DB, asserts
 * every branch, then removes every row it created.
 *
 * Usage:  cd api && bun run scripts/request-docs-smoke.ts
 */

// Strip delivery credentials BEFORE the email/route modules are imported so the
// process is pinned to the queue delivery path.
delete process.env.M365_TENANT_ID;
delete process.env.M365_CLIENT_ID;
delete process.env.M365_CLIENT_SECRET;
delete process.env.ClearToPaySMTP;

const { Hono } = await import("hono");
const { TENANT_DATA_PATHS, requireAuth, requireTenant, isQueueRoute, createAuthToken } = await import("../src/middleware");
const { getDb } = await import("../src/db");
const { getDeliveryPath } = await import("../src/email");
const { calculateVendorCompliance } = await import("../src/compliance");
const vendorsRoutes = (await import("../src/routes/vendors")).default;

const INBOX = "documents@cleartopayconstruction.com";
const DISCLAIMER = "ClearToPay does not verify coverage or make payment decisions";

const db = getDb();
const stamp = Date.now();
const slug = `RQSmoke${stamp}`;

// ── The app under test: the same middleware wiring index.ts uses ────────────
const app = new Hono();
for (const pattern of TENANT_DATA_PATHS) {
  app.use(pattern, async (c, next) => {
    if (isQueueRoute(c)) return next();
    return requireAuth(c, () => requireTenant(c, next));
  });
}
app.route("/", vendorsRoutes);

// ── Assertion bookkeeping ──────────────────────────────────────────────────
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); failures++; }
}

// ── Baseline ids so cleanup can remove exactly what this run added ──────────
const maxQueueId = (db.query("SELECT COALESCE(MAX(id),0) AS m FROM outgoing_email_queue").get() as { m: number }).m;
const maxLogId = (db.query("SELECT COALESCE(MAX(id),0) AS m FROM email_log").get() as { m: number }).m;
const maxAuditId = (db.query("SELECT COALESCE(MAX(id),0) AS m FROM audit_logs").get() as { m: number }).m;

const created = { users: [] as number[], tenants: [] as number[], clients: [] as number[], vendors: [] as number[] };

function seedTenant(roleEmail: string) {
  const email = `${roleEmail}-${stamp}@example.com`;
  const u = db.query("INSERT INTO users (full_name, company_name, email, password_hash) VALUES ('RQ Smoke','RQ Smoke',$email,'x')").run({ $email: email });
  const userId = Number(u.lastInsertRowid);
  const t = db.query("INSERT INTO tenants (name, owner_user_id, inbox_slug, subscription_status) VALUES ($name,$uid,$slug,'TRIAL')").run({ $name: slug, $uid: userId, $slug: slug });
  const tenantId = Number(t.lastInsertRowid);
  db.query("UPDATE users SET tenant_id = $tid WHERE id = $uid").run({ $tid: tenantId, $uid: userId });
  created.users.push(userId); created.tenants.push(tenantId);
  return { userId, tenantId, email };
}

function seedClient(tenantId: number, name: string, required: Array<{ type: string; requirement: string | null }>) {
  const c = db.query("INSERT INTO clients (name, tenant_id) VALUES ($name,$tid)").run({ $name: name, $tid: tenantId });
  const clientId = Number(c.lastInsertRowid);
  created.clients.push(clientId);
  for (const r of required) {
    db.query("INSERT INTO client_required_documents (client_id, document_type, coverage_requirement) VALUES ($cid,$dt,$req)").run({ $cid: clientId, $dt: r.type, $req: r.requirement });
  }
  return clientId;
}

function seedVendor(tenantId: number, clientId: number, name: string, contactEmail: string | null, agentEmail: string | null, contactName: string | null = null) {
  const v = db.query("INSERT INTO vendors (tenant_id, client_id, name, contact_email, insurance_agent_email, contact_name) VALUES ($tid,$cid,$name,$ce,$ae,$cn)").run({ $tid: tenantId, $cid: clientId, $name: name, $ce: contactEmail, $ae: agentEmail, $cn: contactName });
  const vendorId = Number(v.lastInsertRowid);
  created.vendors.push(vendorId);
  db.query("INSERT INTO compliance_status (vendor_id, client_id, status, payment_status) VALUES ($vid,$cid,'needs_review','hold')").run({ $vid: vendorId, $cid: clientId });
  return vendorId;
}

async function post(vendorId: number | string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.request(`http://localhost/api/vendors/${vendorId}/request-docs`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  return { status: res.status, json };
}

function queuedRowsSince() {
  return db.query("SELECT id, recipient_email, subject, html_body, email_type, client_id, vendor_id, status FROM outgoing_email_queue WHERE id > $id ORDER BY id").all({ $id: maxQueueId }) as Array<Record<string, unknown>>;
}
function logRowsSince() {
  return db.query("SELECT id, email_type, recipient_email, subject, status, client_id, vendor_id FROM email_log WHERE id > $id ORDER BY id").all({ $id: maxLogId }) as Array<Record<string, unknown>>;
}

console.log(`### request-docs smoke — delivery path in this process: ${getDeliveryPath()}`);
if (getDeliveryPath() !== "queue") {
  console.log("ABORT: this harness must run on the queue path (no M365/SMTP creds) so it never sends a live email");
  process.exit(2);
}

// ── Seed ───────────────────────────────────────────────────────────────────
console.log("### seed throwaway tenants/vendors");
const A = seedTenant("rqsmoke-a");
const B = seedTenant("rqsmoke-b");
const tokenA = await createAuthToken({ user_id: A.userId, email: A.email, full_name: "RQ Smoke" });
const tokenB = await createAuthToken({ user_id: B.userId, email: B.email, full_name: "RQ Smoke" });

const clientA = seedClient(A.tenantId, `${slug} Client A`, [
  { type: "General Liability", requirement: "1M" },
  { type: "W-9", requirement: null },
]);
const clientNoReqs = seedClient(A.tenantId, `${slug} Client NoReqs`, []);
const v1Contact = `rqsmoke-v1-${stamp}@example.com`;
const v2Agent = `rqsmoke-v2-${stamp}@example.com`;
const v1 = seedVendor(A.tenantId, clientA, `${slug} Vendor V1`, v1Contact, null, "Pat Vendor");
const v2 = seedVendor(A.tenantId, clientA, `${slug} Vendor V2`, null, v2Agent);
const v3 = seedVendor(A.tenantId, clientA, `${slug} Vendor V3`, null, null);
const v4 = seedVendor(A.tenantId, clientNoReqs, `${slug} Vendor V4`, `rqsmoke-v4-${stamp}@example.com`, null);
console.log(`tenantA=${A.tenantId} tenantB=${B.tenantId} clientA=${clientA} clientNoReqs=${clientNoReqs} v1=${v1} v2=${v2} v3=${v3} v4=${v4}`);

const derivedDocTypes = calculateVendorCompliance(v1, clientA, A.tenantId).details.map((d) => `${d.document_type}=${d.status}`);
console.log(`v1 compliance detail: ${derivedDocTypes.join(", ")}`);

// ── Case 1: derived document types, contact email, one queued email ────────
console.log("--- case 1: no body → derived doc types, contact_email recipient");
{
  const { status, json } = await post(v1, tokenA, {});
  check("HTTP 200", status === 200, `got ${status}`);
  const types = (json?.document_types as string[]) ?? [];
  check("document_types derived = [General Liability, W-9]", JSON.stringify(types) === JSON.stringify(["General Liability", "W-9"]), JSON.stringify(types));
  check("recipient = vendor contact_email", json?.recipient === v1Contact, String(json?.recipient));
  check("recipient_source = contact_email", json?.recipient_source === "contact_email", String(json?.recipient_source));
  check("email_type = vendor_request", json?.email_type === "vendor_request", String(json?.email_type));
  const subject = String(json?.subject ?? "");
  check(`subject = "Action needed: updated compliance documents for ${slug} Client A"`, subject === `Action needed: updated compliance documents for ${slug} Client A`, subject);

  const q = queuedRowsSince();
  check("exactly ONE queued email", q.length === 1, `${q.length} rows`);
  const row = q[0] ?? {};
  check("queue recipient = contact_email", row.recipient_email === v1Contact, String(row.recipient_email));
  check("queue email_type = vendor_request", row.email_type === "vendor_request", String(row.email_type));
  check("queue vendor_id set", Number(row.vendor_id) === v1, String(row.vendor_id));
  check("queue client_id set", Number(row.client_id) === clientA, String(row.client_id));
  const html = String(row.html_body ?? "");
  check("body names both requested doc types", html.includes("General Liability") && html.includes("W-9"));
  check(`body points at ${INBOX}`, html.includes(INBOX));
  check("body carries the existing disclaimer sentence", html.includes(DISCLAIMER));
  check("body leaks no platform internals", !/gpt-4o|sqlite|openai|api key|stripe|R2\b/i.test(html));
  check("body greets the vendor contact name", html.includes("Pat Vendor"));

  const logs = logRowsSince();
  check("exactly ONE email_log row", logs.length === 1, `${logs.length} rows`);
  const l = logs[0] ?? {};
  check("log email_type = vendor_request", l.email_type === "vendor_request", String(l.email_type));
  check("log recipient_email = contact_email", l.recipient_email === v1Contact, String(l.recipient_email));
  check("log vendor_id = vendor", Number(l.vendor_id) === v1, String(l.vendor_id));
  check("log client_id = client", Number(l.client_id) === clientA, String(l.client_id));
  check("log status = queued (queue path, nothing delivered)", l.status === "queued", String(l.status));
  // No alternate path may have delivered: a 'sent' row would mean a live send.
  const sent = db.query("SELECT COUNT(*) AS c FROM email_log WHERE id > $id AND status = 'sent'").get({ $id: maxLogId }) as { c: number };
  check("no email_log 'sent' row (no live delivery)", sent.c === 0, `${sent.c} sent rows`);

  // The send is recorded in the audit trail too.
  const audit = db.query("SELECT COUNT(*) AS c FROM audit_logs WHERE id > $id AND entity_type='vendor' AND action='docs_requested'").get({ $id: maxAuditId }) as { c: number };
  check("audit_logs row action=docs_requested", audit.c === 1, `${audit.c} rows`);
}

// ── Case 2: fall back to the insurance agent email ─────────────────────────
console.log("--- case 2: no contact_email → insurance_agent_email recipient");
{
  const { status, json } = await post(v2, tokenA, {});
  check("HTTP 200", status === 200, `got ${status}`);
  check("recipient = insurance_agent_email", json?.recipient === v2Agent, String(json?.recipient));
  check("recipient_source = insurance_agent_email", json?.recipient_source === "insurance_agent_email", String(json?.recipient_source));
  const q = queuedRowsSince().filter((r) => r.recipient_email === v2Agent);
  check("one queued email to the agent", q.length === 1, `${q.length} rows`);
}

// ── Case 3: neither email on file → clear 4xx, nothing sent ────────────────
console.log("--- case 3: no email on file → 400 no_email_on_file, nothing sent");
{
  const before = queuedRowsSince().length;
  const { status, json } = await post(v3, tokenA, {});
  check("HTTP 400", status === 400, `got ${status}`);
  check("code = no_email_on_file", json?.code === "no_email_on_file", String(json?.code));
  check("message tells the client to add an email", json?.error === "No email on file for this vendor — add a contact email first.", String(json?.error));
  check("no email queued", queuedRowsSince().length === before);
}

// ── Case 4: explicit document_types wins and is de-duplicated ──────────────
console.log("--- case 4: explicit document_types (deduped, trimmed)");
{
  const { status, json } = await post(v1, tokenA, { document_types: ["  Umbrella Insurance ", "umbrella insurance", "W-9"] });
  check("HTTP 200", status === 200, `got ${status}`);
  const types = (json?.document_types as string[]) ?? [];
  check("document_types = [Umbrella Insurance, W-9]", JSON.stringify(types) === JSON.stringify(["Umbrella Insurance", "W-9"]), JSON.stringify(types));
  check("email_type = vendor_request", json?.email_type === "vendor_request", String(json?.email_type));
}

// ── Case 5: malformed body is rejected ─────────────────────────────────────
console.log("--- case 5: malformed document_types → 400");
{
  const s1 = await post(v1, tokenA, { document_types: "General Liability" });
  check("string instead of array → 400", s1.status === 400, `got ${s1.status}`);
  const s2 = await post(v1, tokenA, { document_types: [42] });
  check("non-string member → 400", s2.status === 400, `got ${s2.status}`);
  const s3 = await post(v1, tokenA, { document_types: [] });
  check("empty array → 400", s3.status === 400, `got ${s3.status}`);
}

// ── Case 6: nothing to request → 400, nothing sent ─────────────────────────
console.log("--- case 6: client with no requirements → nothing to request");
{
  const before = queuedRowsSince().length;
  const { status, json } = await post(v4, tokenA, {});
  check("HTTP 400", status === 400, `got ${status}`);
  check("explains there is nothing to request", String(json?.error ?? "").includes("nothing to request"), String(json?.error));
  check("no email queued", queuedRowsSince().length === before);
}

// ── Case 7: cross-tenant is a 404 and sends nothing ────────────────────────
console.log("--- case 7: other tenant asking for this vendor → 404");
{
  const before = queuedRowsSince().length;
  const { status, json } = await post(v1, tokenB, {});
  check("HTTP 404", status === 404, `got ${status}`);
  check("error = Vendor not found", json?.error === "Vendor not found", String(json?.error));
  check("cross-tenant attempt sent nothing", queuedRowsSince().length === before);
}

// ── Case 8: auth + unknown vendor ──────────────────────────────────────────
console.log("--- case 8: auth gate + unknown vendor");
{
  const anon = await post(v1, null, {});
  check("no token → 401", anon.status === 401, `got ${anon.status}`);
  const bogus = await post(999999999, tokenA, {});
  check("unknown vendor id → 404", bogus.status === 404, `got ${bogus.status}`);
}

// ── Summary before cleanup ─────────────────────────────────────────────────
const totalQueued = queuedRowsSince().length;
const totalLogged = logRowsSince().length;
console.log(`### this run created: queue_rows=${totalQueued} email_log_rows=${totalLogged} (all vendor_request)`);

// ── Cleanup: remove every row this run created ─────────────────────────────
console.log("### cleanup");
try {
  db.query("DELETE FROM outgoing_email_queue WHERE id > $id").run({ $id: maxQueueId });
  db.query("DELETE FROM email_log WHERE id > $id").run({ $id: maxLogId });
  db.query("DELETE FROM audit_logs WHERE id > $id").run({ $id: maxAuditId });
  const vids = created.vendors.join(",");
  if (vids) db.query(`DELETE FROM compliance_status WHERE vendor_id IN (${vids})`).run({});
  if (vids) db.query(`DELETE FROM documents WHERE vendor_id IN (${vids})`).run({});
  for (const t of created.tenants) {
    db.query("DELETE FROM vendors WHERE tenant_id = $tid").run({ $tid: t });
    db.query("DELETE FROM client_required_documents WHERE client_id IN (SELECT id FROM clients WHERE tenant_id = $tid)").run({ $tid: t });
    db.query("DELETE FROM client_email_config WHERE client_id IN (SELECT id FROM clients WHERE tenant_id = $tid)").run({ $tid: t });
    db.query("DELETE FROM clients WHERE tenant_id = $tid").run({ $tid: t });
    db.query("DELETE FROM setup_wizard WHERE tenant_id = $tid").run({ $tid: t });
  }
  // users <-> tenants is a CIRCULAR FK (users.tenant_id -> tenants.id and
  // tenants.owner_user_id -> users.id): users.tenant_id must be nulled before
  // the tenant rows can go, and the tenants before the users.
  for (const u of created.users) db.query("UPDATE users SET tenant_id = NULL WHERE id = $id").run({ $id: u });
  for (const t of created.tenants) db.query("DELETE FROM tenants WHERE id = $id").run({ $id: t });
  for (const u of created.users) db.query("DELETE FROM users WHERE id = $id").run({ $id: u });
} catch (err) {
  console.log(`  FAIL cleanup threw: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
}

const leftovers = {
  tenants: created.tenants.map((t) => (db.query("SELECT COUNT(*) AS c FROM tenants WHERE id = $id").get({ $id: t }) as { c: number }).c).reduce((a, b) => a + b, 0),
  users: created.users.map((u) => (db.query("SELECT COUNT(*) AS c FROM users WHERE id = $id").get({ $id: u }) as { c: number }).c).reduce((a, b) => a + b, 0),
  clients: created.clients.map((c) => (db.query("SELECT COUNT(*) AS c FROM clients WHERE id = $id").get({ $id: c }) as { c: number }).c).reduce((a, b) => a + b, 0),
  vendors: created.vendors.map((v) => (db.query("SELECT COUNT(*) AS c FROM vendors WHERE id = $id").get({ $id: v }) as { c: number }).c).reduce((a, b) => a + b, 0),
  queue: queuedRowsSince().length,
  email_log: logRowsSince().length,
};
console.log(`leftovers: ${JSON.stringify(leftovers)}`);
if (Object.values(leftovers).some((n) => n !== 0)) { console.log("FAIL leftovers not empty"); failures++; }

console.log(`### RESULT FAIL=${failures}`);
process.exit(failures === 0 ? 0 : 1);
