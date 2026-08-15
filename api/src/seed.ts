import { getDb } from "./db";
import { entityKey } from "./entities";

const db = getDb();

console.log("[seed] Seeding database...");

// ── Clients ──────────────────────────────────────────

const insertClient = db.query(`
  INSERT INTO clients (name, contact_email, contact_phone, address, normalized_key)
  VALUES ($name, $email, $phone, $address, $key)
`);

const clients = [
  { name: "Summit Construction Inc.", email: "billing@summitconstruction.example.com", phone: "555-0100", address: "1200 Builder Ave, Portland, OR 97201" },
  { name: "Metro Development Group", email: "ap@metrodev.example.com", phone: "555-0200", address: "450 Commerce Dr, Suite 300, Seattle, WA 98101" },
];

for (const c of clients) {
  insertClient.run({ $name: c.name, $email: c.email, $phone: c.phone, $address: c.address, $key: entityKey(c.name, c.address) });
}
console.log("[seed] Inserted 2 clients");

// ── Required Document Types ─────────────────────────

const clientIds = db.query("SELECT id FROM clients").all() as { id: number }[];

const requiredDocTypes = ["COI", "W-9", "Workers Comp", "General Liability", "Business License"];

const insertRequired = db.query(`
  INSERT INTO client_required_documents (client_id, document_type)
  VALUES ($client_id, $document_type)
`);

for (const cid of clientIds) {
  for (const dt of requiredDocTypes) {
    insertRequired.run({ $client_id: cid.id, $document_type: dt });
  }
}
console.log("[seed] Inserted required document types for each client");

// ── Vendors ─────────────────────────────────────────

const insertVendor = db.query(`
  INSERT INTO vendors (client_id, name, contact_name, contact_email, contact_phone, normalized_key)
  VALUES ($client_id, $name, $contact_name, $contact_email, $contact_phone, $key)
`);

const vendors = [
  { client_id: 1, name: "Apex Electrical Services", contact_name: "Maria Gonzalez", contact_email: "maria@apex-electric.example.com", contact_phone: "555-1001" },
  { client_id: 1, name: "Pacific HVAC Solutions", contact_name: "James Chen", contact_email: "jchen@pacifichvac.example.com", contact_phone: "555-1002" },
  { client_id: 2, name: "Cascade Plumbing Co.", contact_name: "Robert Taylor", contact_email: "rtaylor@cascade-plumbing.example.com", contact_phone: "555-2001" },
];

for (const v of vendors) {
  insertVendor.run({ $client_id: v.client_id, $name: v.name, $contact_name: v.contact_name, $contact_email: v.contact_email, $contact_phone: v.contact_phone, $key: entityKey(v.name, null) });
}
console.log("[seed] Inserted 3 vendors");

// ── Sample Documents ────────────────────────────────

const insertDoc = db.query(`
  INSERT INTO documents (vendor_id, client_id, document_type, file_path, original_filename, sender_name, sender_email, received_date)
  VALUES ($vendor_id, $client_id, $document_type, $file_path, $original_filename, $sender_name, $sender_email, datetime('now'))
`);

// Create placeholder files
const docDir = Bun.fileURLToPath(new URL("../data/documents", import.meta.url));
await Bun.spawn(["mkdir", "-p", docDir]).exited;

const sampleDocs = [
  { vendor_id: 1, client_id: 1, document_type: "COI", filename: "apex_coi_2026.pdf", sender_name: "Maria Gonzalez", sender_email: "maria@apex-electric.example.com" },
  { vendor_id: 1, client_id: 1, document_type: "W-9", filename: "apex_w9_2026.pdf", sender_name: "Maria Gonzalez", sender_email: "maria@apex-electric.example.com" },
  { vendor_id: 2, client_id: 1, document_type: "COI", filename: "pacific_coi_2026.pdf", sender_name: "James Chen", sender_email: "jchen@pacifichvac.example.com" },
  { vendor_id: 3, client_id: 2, document_type: "Workers Comp", filename: "cascade_wc_2026.pdf", sender_name: "Robert Taylor", sender_email: "rtaylor@cascade-plumbing.example.com" },
];

for (const d of sampleDocs) {
  const filePath = `data/documents/${d.vendor_id}_${d.filename}`;
  // Write a tiny placeholder file
  await Bun.write(Bun.fileURLToPath(new URL(`../${filePath}`, import.meta.url)), `PLACEHOLDER: ${d.filename} for vendor ${d.vendor_id}`);
  insertDoc.run({
    $vendor_id: d.vendor_id,
    $client_id: d.client_id,
    $document_type: d.document_type,
    $file_path: filePath,
    $original_filename: d.filename,
    $sender_name: d.sender_name,
    $sender_email: d.sender_email,
  });
}
console.log("[seed] Inserted 4 sample documents with placeholder files");

// ── Sample Extractions ──────────────────────────────

const insertExtraction = db.query(`
  INSERT INTO document_extractions (document_id, vendor_name, insurance_carrier, policy_number, effective_date, expiration_date, document_type, ai_confidence_score, is_reviewed)
  VALUES ($document_id, $vendor_name, $insurance_carrier, $policy_number, $effective_date, $expiration_date, $document_type, $ai_confidence_score, $is_reviewed)
`);

const extractions = [
  { document_id: 1, vendor_name: "Apex Electrical Services", insurance_carrier: "Travelers Insurance", policy_number: "TRV-2026-00421", effective_date: "2026-01-01", expiration_date: "2026-12-31", document_type: "COI", ai_confidence_score: 94, is_reviewed: 1 },
  { document_id: 2, vendor_name: "Apex Electrical Services", insurance_carrier: null, policy_number: null, effective_date: null, expiration_date: null, document_type: "W-9", ai_confidence_score: 88, is_reviewed: 1 },
  { document_id: 3, vendor_name: "Pacific HVAC Solutions", insurance_carrier: "Liberty Mutual", policy_number: "LM-2026-8823", effective_date: "2026-03-15", expiration_date: "2027-03-15", document_type: "COI", ai_confidence_score: 91, is_reviewed: 1 },
  { document_id: 4, vendor_name: "Cascade Plumbing Co.", insurance_carrier: "State Farm", policy_number: "SF-WC-2026-112", effective_date: "2026-02-01", expiration_date: "2026-08-01", document_type: "Workers Comp", ai_confidence_score: 72, is_reviewed: 0 },
];

for (const e of extractions) {
  insertExtraction.run({
    $document_id: e.document_id,
    $vendor_name: e.vendor_name,
    $insurance_carrier: e.insurance_carrier,
    $policy_number: e.policy_number,
    $effective_date: e.effective_date,
    $expiration_date: e.expiration_date,
    $document_type: e.document_type,
    $ai_confidence_score: e.ai_confidence_score,
    $is_reviewed: e.is_reviewed,
  });
}
console.log("[seed] Inserted 4 document extractions");

// ── Compliance Status ───────────────────────────────

const insertStatus = db.query(`
  INSERT INTO compliance_status (vendor_id, client_id, status, payment_status)
  VALUES ($vendor_id, $client_id, $status, $payment_status)
`);

const statuses = [
  { vendor_id: 1, client_id: 1, status: "compliant", payment_status: "approved" },
  { vendor_id: 2, client_id: 1, status: "compliant", payment_status: "approved" },
  { vendor_id: 3, client_id: 2, status: "needs_review", payment_status: "review" },
];

for (const s of statuses) {
  insertStatus.run({ $vendor_id: s.vendor_id, $client_id: s.client_id, $status: s.status, $payment_status: s.payment_status });
}
console.log("[seed] Inserted 3 compliance status records");

// ── Audit Logs ──────────────────────────────────────

const insertAudit = db.query(`
  INSERT INTO audit_logs (entity_type, entity_id, action, changes, performed_by)
  VALUES ($entity_type, $entity_id, $action, $changes, $performed_by)
`);

insertAudit.run({ $entity_type: "client", $entity_id: 1, $action: "created", $changes: JSON.stringify({ name: "Summit Construction Inc." }), $performed_by: "seed" });
insertAudit.run({ $entity_type: "client", $entity_id: 2, $action: "created", $changes: JSON.stringify({ name: "Metro Development Group" }), $performed_by: "seed" });
console.log("[seed] Inserted audit log entries");

console.log("[seed] Database seeded successfully!");
