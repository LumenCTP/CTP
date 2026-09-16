/**
 * Demo showcase accounts — creates a fully isolated demo CLIENT (role 'user')
 * and a demo PARTNER (role 'partner') for owner demos. NEVER creates an admin.
 *
 * Run from the api/ directory:  bun run scripts/demo-seed-accounts.ts
 *
 * The temporary passwords are GENERATED AT RUNTIME and only printed to stdout —
 * they are never written to a file or to this script.
 *
 * Isolation: only touches rows it creates (demo tenant slugs / demo emails).
 * The owner's real tenant 17 (admin), 84 (test client) and 97 (partner) are
 * never read or written beyond an existence check.
 */
import { Database } from "bun:sqlite";
import PDFDocument from "pdfkit";
import { storagePut, storageList, storageDelete } from "../src/storage.ts";

const DB_PATH = "data/cleartopay.db";
const CLIENT_EMAIL = "demo@cleartopaydemo.com";
const PARTNER_EMAIL = "demopartner@cleartopaydemo.com";
const PARTNER_USERNAME = "demopartner";
const CLIENT_INBOX_SLUG = "demo-construction-co";
const PARTNER_INBOX_SLUG = "demo-partner-showcase";
const CLIENT_TENANT_NAME = "Demo Construction Co";
const PARTNER_TENANT_NAME = "Demo Partner Showcase";
const REFERRAL_CODE = "DEMOPART";
const PROTECTED_TENANTS = [17, 84, 97];

const db = new Database(DB_PATH);
db.exec("PRAGMA busy_timeout=15000");
// OFF during cleanup so demo-tenants can be removed without FK-order games;
// turned back ON before inserts so the new rows are FK-validated.
db.exec("PRAGMA foreign_keys=OFF");

function rand(n: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// ── 0. Safety: refuse to run if a protected tenant is about to be touched ──
for (const t of PROTECTED_TENANTS) {
  const row = db.query("SELECT id, name FROM tenants WHERE id = $id").get({ $id: t }) as
    | { id: number; name: string }
    | undefined;
  if (!row) throw new Error(`Protected tenant ${t} is missing — aborting (unexpected DB state)`);
}
console.log("protected tenants present:", PROTECTED_TENANTS.join(","));

// ── 1. Idempotent cleanup of any prior demo attempt ────────────────────────
const priorTenants = db
  .query("SELECT id, name FROM tenants WHERE name IN ($a, $b)")
  .all({ $a: CLIENT_TENANT_NAME, $b: PARTNER_TENANT_NAME }) as Array<{ id: number; name: string }>;
const priorUsers = db
  .query("SELECT id, email FROM users WHERE email IN ($a, $b) OR username = $u")
  .all({ $a: CLIENT_EMAIL, $b: PARTNER_EMAIL, $u: PARTNER_USERNAME }) as Array<{ id: number; email: string }>;

for (const t of priorTenants) {
  if (PROTECTED_TENANTS.includes(t.id)) throw new Error(`Refusing to delete protected tenant ${t.id}`);
  const clientIds = (db.query("SELECT id FROM clients WHERE tenant_id = $t").all({ $t: t.id }) as Array<{ id: number }>).map((r) => r.id);
  const vendorIds = (db.query("SELECT id FROM vendors WHERE tenant_id = $t").all({ $t: t.id }) as Array<{ id: number }>).map((r) => r.id);
  // R2 objects for this demo tenant
  try {
    const keys = await storageList(`documents/${t.id}/`);
    for (const k of keys) await storageDelete(k);
    console.log(`prior demo cleanup: removed ${keys.length} object(s) under documents/${t.id}/`);
  } catch (err) {
    console.warn(`prior demo cleanup: storage list failed (${String(err)})`);
  }
  for (const cid of clientIds) {
    db.query("DELETE FROM compliance_status WHERE client_id = $c").run({ $c: cid });
    db.query("DELETE FROM client_required_documents WHERE client_id = $c").run({ $c: cid });
    db.query("DELETE FROM client_email_config WHERE client_id = $c").run({ $c: cid });
  }
  for (const vid of vendorIds) db.query("DELETE FROM compliance_status WHERE vendor_id = $v").run({ $v: vid });
  db.query("DELETE FROM documents WHERE tenant_id = $t").run({ $t: t.id });
  db.query("DELETE FROM vendors WHERE tenant_id = $t").run({ $t: t.id });
  db.query("DELETE FROM clients WHERE tenant_id = $t").run({ $t: t.id });
  db.query("DELETE FROM setup_wizard WHERE tenant_id = $t").run({ $t: t.id });
  db.query("DELETE FROM weekly_email_log WHERE tenant_id = $t").run({ $t: t.id });
  db.query("DELETE FROM tenants WHERE id = $t").run({ $t: t.id });
  console.log(`prior demo cleanup: tenant ${t.id} (${t.name}) removed`);
}
// Partner-side demo rows first (children before parents).
const priorPartners = db
  .query("SELECT id FROM partners WHERE email = $e OR user_id IN (SELECT id FROM users WHERE email = $e)")
  .all({ $e: PARTNER_EMAIL }) as Array<{ id: number }>;
for (const p of priorPartners) {
  db.query("DELETE FROM commissions WHERE partner_id = $p").run({ $p: p.id });
  db.query("DELETE FROM payouts WHERE partner_id = $p").run({ $p: p.id });
  db.query("DELETE FROM partner_audit_log WHERE partner_id = $p").run({ $p: p.id });
  db.query("DELETE FROM partners WHERE id = $p").run({ $p: p.id });
  console.log(`prior demo cleanup: partner ${p.id} removed`);
}
db.query("DELETE FROM referrals WHERE partner_code = $c OR referred_company LIKE 'Demo Referral %'").run({ $c: REFERRAL_CODE });

for (const u of priorUsers) {
  if ([17, 85, 114].includes(u.id)) throw new Error(`Refusing to delete protected user ${u.id}`);
  db.query("DELETE FROM chat_messages WHERE user_id = $u").run({ $u: u.id });
  db.query("DELETE FROM users WHERE id = $u").run({ $u: u.id });
  console.log(`prior demo cleanup: user ${u.id} (${u.email}) removed`);
}

// ── 2. Demo CLIENT ─────────────────────────────────────────────────────────
db.exec("PRAGMA foreign_keys=ON"); // inserts below are FK-validated
const clientPassword = `Demo-${rand(10)}`;
const clientHash = await Bun.password.hash(clientPassword, { algorithm: "bcrypt", cost: 10 });

const clientUser = db
  .query("INSERT INTO users (full_name, company_name, email, password_hash, role) VALUES ($n, $c, $e, $h, 'user')")
  .run({ $n: "Dana Demoson", $c: CLIENT_TENANT_NAME, $e: CLIENT_EMAIL, $h: clientHash });
const clientUserId = Number(clientUser.lastInsertRowid);

const clientTenant = db
  .query(
    `INSERT INTO tenants (name, owner_user_id, subscription_status, payment_week_start_day, admin_email, inbox_slug, subscription_plan)
     VALUES ($name, $owner, 'TRIAL', 'monday', $email, $slug, NULL)`,
  )
  .run({ $name: CLIENT_TENANT_NAME, $owner: clientUserId, $email: CLIENT_EMAIL, $slug: CLIENT_INBOX_SLUG });
const clientTenantId = Number(clientTenant.lastInsertRowid);
db.query("UPDATE users SET tenant_id = $t WHERE id = $u").run({ $t: clientTenantId, $u: clientUserId });

const clientRow = db
  .query("INSERT INTO clients (name, contact_email, contact_phone, address, tenant_id, normalized_key) VALUES ($n, $e, $p, $a, $t, $k)")
  .run({
    $n: CLIENT_TENANT_NAME,
    $e: CLIENT_EMAIL,
    $p: "(555) 010-0000",
    $a: "100 Demo Plaza, Suite 100, Demo City, ST 00000",
    $t: clientTenantId,
    $k: "demo construction co",
  });
const clientId = Number(clientRow.lastInsertRowid);

// Required document types (the standard default set)
const requiredDocs: Array<{ type: string; coverage: string | null }> = [
  { type: "COI", coverage: null },
  { type: "W-9", coverage: null },
  { type: "General Liability", coverage: "$1,000,000 per occurrence / $2,000,000 aggregate" },
  { type: "Workers Comp", coverage: "Statutory" },
  { type: "Commercial Auto", coverage: "$1,000,000 combined single limit" },
];
for (const d of requiredDocs) {
  db.query("INSERT INTO client_required_documents (client_id, document_type, coverage_requirement) VALUES ($c, $t, $r)").run({
    $c: clientId,
    $t: d.type,
    $r: d.coverage,
  });
}

// Email config: weekly + monthly reports to the demo client address.
db.query(
  "INSERT INTO client_email_config (client_id, weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled) VALUES ($c, $w, $m, 1)",
).run({ $c: clientId, $w: CLIENT_EMAIL, $m: CLIENT_EMAIL });

// Setup wizard — completed
db.query(
  `INSERT INTO setup_wizard (tenant_id, status, current_step, company_name, company_address, payment_week_start_day, completed_at, compliance_client_id, acknowledged)
   VALUES ($t, 'COMPLETED', 'confirm', $n, $a, 'monday', datetime('now'), $c, 1)`,
).run({ $t: clientTenantId, $n: CLIENT_TENANT_NAME, $a: "100 Demo Plaza, Suite 100, Demo City, ST 00000", $c: clientId });

// ── 3. Demo documents (real PDFs in object storage) ────────────────────────
function makePdf(fields: Array<[string, string]>, docTitle: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(16).text("DEMO DOCUMENT — SAMPLE ONLY, NOT A REAL CERTIFICATE", { align: "center" });
    doc.moveDown();
    doc.fontSize(20).text(docTitle, { align: "center" });
    doc.moveDown(1.5);
    doc.fontSize(11);
    for (const [k, v] of fields) doc.text(`${k}:  ${v}`);
    doc.moveDown(2);
    doc.fontSize(9).text(
      "This file exists only to demonstrate ClearToPay's document viewer, AI extraction fields and compliance tracking. " +
        "It is not a real insurance certificate, W-9 or license and carries no legal effect.",
      { align: "left" },
    );
    doc.end();
  });
}

type DocSpec = {
  vendorKey: string;
  type: string;
  filename: string;
  expiry: string | null;
  isReviewed: 0 | 1;
  confidence: number;
  carrier?: string;
  policy?: string;
  glOcc?: number;
  glAgg?: number;
  wcEmp?: number;
  autoCsl?: number;
  agentEmail?: string;
};

// Vendors: name + contact + the documents that exist (missing types = on hold)
type VendorSpec = { key: string; name: string; contact: string; email: string; agent: string };
const vendors: VendorSpec[] = [
  { key: "plumbing", name: "Demo Plumbing Co", contact: "Pat Demo", email: "plumbing@cleartopaydemo.com", agent: "Demo Mutual Insurance" },
  { key: "electric", name: "Demo Electric LLC", contact: "Sam Demo", email: "electric@cleartopaydemo.com", agent: "Demo Mutual Insurance" },
  { key: "concrete", name: "Demo Concrete Supply", contact: "Alex Demo", email: "concrete@cleartopaydemo.com", agent: "Sample Casualty Group" },
  { key: "roofing", name: "Demo Roofing Inc", contact: "Robin Demo", email: "roofing@cleartopaydemo.com", agent: "Sample Casualty Group" },
  { key: "drywall", name: "Demo Drywall Partners", contact: "Jordan Demo", email: "drywall@cleartopaydemo.com", agent: "Demo Mutual Insurance" },
  { key: "site", name: "Demo Site Services", contact: "Casey Demo", email: "siteservices@cleartopaydemo.com", agent: "Example Insurance Co" },
  { key: "steel", name: "Demo Steel Supply Inc", contact: "Morgan Demo", email: "steel@cleartopaydemo.com", agent: "Example Insurance Co" },
];

const vendorIds = new Map<string, number>();
for (const v of vendors) {
  const res = db
    .query(
      "INSERT INTO vendors (client_id, name, contact_name, contact_email, insurance_agent_email, tenant_id, normalized_key) VALUES ($c, $n, $cn, $e, $a, $t, $k)",
    )
    .run({
      $c: clientId,
      $n: v.name,
      $cn: v.contact,
      $e: v.email,
      $a: v.agent,
      $t: clientTenantId,
      $k: v.name.toLowerCase(),
    });
  vendorIds.set(v.key, Number(res.lastInsertRowid));
}

const V = { plumbing: "2027-06-30", electric: "2027-03-15", concrete: "2027-04-01", roofing: "2027-05-20", drywall: "2027-02-28", site: "2027-01-31", steel: "2027-07-15" };

const docs: DocSpec[] = [];
for (const key of ["plumbing", "electric", "concrete", "roofing", "drywall", "site", "steel"]) {
  const exp = V[key as keyof typeof V];
  docs.push({ vendorKey: key, type: "COI", filename: `demo-${key}-coi.pdf`, expiry: exp, isReviewed: 1, confidence: 94, carrier: "Demo Mutual Insurance", policy: `DM-COI-${key.toUpperCase()}-01` });
  if (key !== "drywall") {
    // Demo Drywall Partners is deliberately MISSING its W-9 → Hold
    docs.push({ vendorKey: key, type: "W-9", filename: `demo-${key}-w9.pdf`, expiry: null, isReviewed: 1, confidence: 96 });
  }
  docs.push({
    vendorKey: key, type: "General Liability", filename: `demo-${key}-gl.pdf`,
    expiry: key === "roofing" ? "2026-09-22" : exp, isReviewed: 1, confidence: 92,
    carrier: "Sample Casualty Group", policy: `SC-GL-${key.toUpperCase()}-01`,
    glOcc: key === "steel" ? 500_000 : 1_000_000, glAgg: key === "steel" ? 1_000_000 : 2_000_000,
  });
  docs.push({
    vendorKey: key, type: "Workers Comp", filename: `demo-${key}-wc.pdf`,
    expiry: key === "site" ? "2027-01-31" : exp, isReviewed: 1, confidence: 91,
    carrier: "Example Insurance Co", policy: `EX-WC-${key.toUpperCase()}-01`, wcEmp: 1_000_000,
  });
  docs.push({
    vendorKey: key, type: "Commercial Auto", filename: `demo-${key}-auto.pdf`,
    expiry: key === "site" ? "2026-09-19" : exp,
    isReviewed: key === "concrete" ? 0 : 1,
    confidence: key === "concrete" ? 61 : 90,
    carrier: "Example Insurance Co", policy: `EX-AU-${key.toUpperCase()}-01`, autoCsl: 1_000_000,
  });
}
// Demo Site Services: expired COI (keeps it on Hold regardless of the auto policy window)
const siteCoi = docs.find((d) => d.vendorKey === "site" && d.type === "COI")!;
siteCoi.expiry = "2026-08-01";

let docCount = 0;
for (const spec of docs) {
  const vendorId = vendorIds.get(spec.vendorKey)!;
  const vendor = vendors.find((v) => v.key === spec.vendorKey)!;
  const pdf = await makePdf(
    [
      ["Insured / Vendor", vendor.name],
      ["Certificate Holder", CLIENT_TENANT_NAME + " (DEMO)"],
      ["Document Type", spec.type],
      ["Carrier", spec.carrier ?? "n/a"],
      ["Policy Number", spec.policy ?? "n/a"],
      ["Expiration Date", spec.expiry ?? "n/a"],
    ],
    spec.type === "W-9" ? "Form W-9 (sample)" : "Certificate of Insurance (sample)",
  );
  const stored = `${Date.now()}-${spec.filename}`;
  const key = `documents/${clientTenantId}/${stored}`;
  await storagePut(key, pdf, "application/pdf");
  const inserted = db
    .query(
      `INSERT INTO documents (vendor_id, client_id, document_type, file_path, original_filename, content_type, file_size, sender_name, sender_email, tenant_id)
       VALUES ($v, $c, $type, $path, $name, 'application/pdf', $size, $sn, $se, $t)`,
    )
    .run({
      $v: vendorId,
      $c: clientId,
      $type: spec.type,
      $path: `data/uploads/${clientTenantId}/${stored}`,
      $name: spec.filename,
      $size: pdf.length,
      $sn: vendor.contact,
      $se: vendor.email,
      $t: clientTenantId,
    });
  const documentId = Number(inserted.lastInsertRowid);
  db.query("INSERT INTO ingestion_events (document_id, status) VALUES ($d, 'ready')").run({ $d: documentId });
  db.query(
    `INSERT INTO document_extractions
      (document_id, vendor_name, insurance_carrier, policy_number, effective_date, expiration_date, certificate_holder,
       document_type, ai_confidence_score, is_reviewed, extraction_method, producer_name, producer_email,
       coverage_gl_occurrence, coverage_gl_aggregate, coverage_wc_employers, coverage_auto_csl, w9_form_date)
     VALUES ($d, $vn, $carrier, $policy, '2026-01-01', $exp, $holder, $type, $conf, $rev, 'ai', $agent, $agentEmail,
             $glOcc, $glAgg, $wcEmp, $auto, $w9)`,
  ).run({
    $d: documentId,
    $vn: vendor.name,
    $carrier: spec.carrier ?? null,
    $policy: spec.policy ?? null,
    $exp: spec.expiry,
    $holder: CLIENT_TENANT_NAME,
    $type: spec.type,
    $conf: spec.confidence,
    $rev: spec.isReviewed,
    $agent: vendor.agent,
    $agentEmail: "agent@cleartopaydemo.com",
    $glOcc: spec.glOcc ?? null,
    $glAgg: spec.glAgg ?? null,
    $wcEmp: spec.wcEmp ?? null,
    $auto: spec.autoCsl ?? null,
    $w9: spec.type === "W-9" ? "2026-01-15" : null,
  });
  docCount++;
}

// ── 4. Demo PARTNER ───────────────────────────────────────────────────────
const partnerPassword = `Demo-${rand(10)}`;
const partnerHash = await Bun.password.hash(partnerPassword, { algorithm: "bcrypt", cost: 10 });

const partnerUser = db
  .query("INSERT INTO users (full_name, company_name, email, password_hash, role, username) VALUES ($n, $c, $e, $h, 'partner', $u)")
  .run({ $n: "Priya Demopartner", $c: PARTNER_TENANT_NAME, $e: PARTNER_EMAIL, $h: partnerHash, $u: PARTNER_USERNAME });
const partnerUserId = Number(partnerUser.lastInsertRowid);

const partnerTenant = db
  .query(
    `INSERT INTO tenants (name, owner_user_id, subscription_status, payment_week_start_day, admin_email, inbox_slug, subscription_plan)
     VALUES ($name, $owner, 'TRIAL', 'monday', $email, $slug, NULL)`,
  )
  .run({ $name: PARTNER_TENANT_NAME, $owner: partnerUserId, $email: PARTNER_EMAIL, $slug: PARTNER_INBOX_SLUG });
const partnerTenantId = Number(partnerTenant.lastInsertRowid);
db.query("UPDATE users SET tenant_id = $t WHERE id = $u").run({ $t: partnerTenantId, $u: partnerUserId });

const partnerRow = db
  .query(
    `INSERT INTO partners (user_id, first_name, last_name, company_name, email, phone, address, website, states_served, partner_type,
       tax_info_status, preferred_payout_method, status, referral_code, commission_percentage)
     VALUES ($u, 'Priya', 'Demopartner', $c, $e, '(555) 010-0001', $a, 'https://cleartopaydemo.com', 'Demo State', 'Insurance Agent',
       'submitted', 'ACH', 'approved', $code, 25.0)`,
  )
  .run({
    $u: partnerUserId,
    $c: PARTNER_TENANT_NAME,
    $e: PARTNER_EMAIL,
    $a: "200 Demo Avenue, Demo City, ST 00000",
    $code: REFERRAL_CODE,
  });
const partnerId = Number(partnerRow.lastInsertRowid);

const referralA = db
  .query(
    `INSERT INTO referrals (partner_id, partner_code, referred_company, contact_name, contact_email, contact_phone, referral_date,
       signup_date, subscription_start_date, subscription_plan, subscription_amount, customer_status, notes)
     VALUES ($p, $code, 'Demo Referral Client One LLC', 'Lee Demo', 'lee@cleartopaydemo.com', '(555) 010-0002', date('now','-40 days'),
       date('now','-32 days'), date('now','-30 days'), 'Monthly', 149, 'active', 'Sample referral for demonstration only')`,
  )
  .run({ $p: partnerId, $code: REFERRAL_CODE });
const referralAId = Number(referralA.lastInsertRowid);

db.query(
  `INSERT INTO referrals (partner_id, partner_code, referred_company, contact_name, contact_email, contact_phone, referral_date,
     customer_status, notes)
   VALUES ($p, $code, 'Demo Referral Prospect Two Inc', 'Kim Demo', 'kim@cleartopaydemo.com', '(555) 010-0003', date('now','-6 days'),
     'lead', 'Sample referral for demonstration only')`,
).run({ $p: partnerId, $code: REFERRAL_CODE });

db.query(
  `INSERT INTO commissions (partner_id, referral_id, tenant_id, billing_period, eligible_revenue, commission_percentage, commission_amount, earned_date, status)
   VALUES ($p, $r, NULL, $bp, 149, 25.0, 37.25, date('now','-32 days'), 'pending')`,
).run({ $p: partnerId, $r: referralAId, $bp: new Date(Date.now() - 32 * 86400000).toISOString().slice(0, 7) });
db.query(
  `INSERT INTO commissions (partner_id, referral_id, tenant_id, billing_period, eligible_revenue, commission_percentage, commission_amount, earned_date, status)
   VALUES ($p, $r, NULL, $bp, 149, 25.0, 37.25, date('now','-2 days'), 'approved')`,
).run({ $p: partnerId, $r: referralAId, $bp: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 7) });

db.close();

console.log(
  JSON.stringify(
    {
      client: { user_id: clientUserId, tenant_id: clientTenantId, client_id: clientId, email: CLIENT_EMAIL, password: clientPassword, inbox_slug: CLIENT_INBOX_SLUG },
      partner: { user_id: partnerUserId, tenant_id: partnerTenantId, partner_id: partnerId, email: PARTNER_EMAIL, username: PARTNER_USERNAME, password: partnerPassword, referral_code: REFERRAL_CODE },
      vendors: Object.fromEntries(vendorIds),
      documents_created: docCount,
    },
    null,
    2,
  ),
);
