import { Database } from "bun:sqlite";
import path from "node:path";
// NOTE: relative import — the API process (bun run) has no node_modules symlink
// for the "@clear-to-pay/shared" workspace package (only the web app does), so
// package-name imports only work for type-only usage (stripped at runtime).
import { DEFAULT_REQUIRED_DOCUMENTS } from "../../shared/types";

const DB_DIR = path.join(import.meta.dir, "..", "data");
const DB_PATH = path.join(DB_DIR, "cleartopay.db");

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    // Ensure directory exists
    const dir = path.dirname(DB_PATH);
    Bun.spawnSync(["mkdir", "-p", dir]);

    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
  }
  return db;
}

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_email TEXT,
      contact_phone TEXT,
      address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_required_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      document_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      document_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      sender_name TEXT,
      sender_email TEXT,
      received_date TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS document_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL UNIQUE,
      vendor_name TEXT,
      insurance_carrier TEXT,
      policy_number TEXT,
      effective_date TEXT,
      expiration_date TEXT,
      certificate_holder TEXT,
      document_type TEXT,
      ai_confidence_score INTEGER NOT NULL DEFAULT 0 CHECK (ai_confidence_score >= 0 AND ai_confidence_score <= 100),
      is_reviewed INTEGER NOT NULL DEFAULT 0,
      extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS compliance_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'needs_review'
        CHECK (status IN ('compliant', 'expiring_soon', 'expired', 'needs_review')),
      payment_status TEXT NOT NULL DEFAULT 'hold'
        CHECK (payment_status IN ('approved', 'review', 'hold')),
      calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      changes TEXT,
      performed_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_vendors_client_id ON vendors(client_id);
    CREATE INDEX IF NOT EXISTS idx_documents_vendor_id ON documents(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_documents_client_id ON documents(client_id);
    CREATE INDEX IF NOT EXISTS idx_document_extractions_document_id ON document_extractions(document_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_status_vendor_id ON compliance_status(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_status_client_id ON compliance_status(client_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_status_status ON compliance_status(status);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type_id ON audit_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_client_required_documents_client_id ON client_required_documents(client_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_status_vendor_id_unique ON compliance_status(vendor_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_required_docs_unique ON client_required_documents(client_id, document_type);

    CREATE TABLE IF NOT EXISTS client_email_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL UNIQUE,
      weekly_report_recipients TEXT,
      monthly_report_recipients TEXT,
      renewal_reminders_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      vendor_id INTEGER,
      email_type TEXT NOT NULL CHECK (email_type IN ('weekly_report', 'monthly_report', 'renewal_reminder')),
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'error')),
      error_message TEXT,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_email_log_client_id ON email_log(client_id);
    CREATE INDEX IF NOT EXISTS idx_email_log_email_type ON email_log(email_type);
    CREATE INDEX IF NOT EXISTS idx_email_log_sent_at ON email_log(sent_at);

    CREATE TABLE IF NOT EXISTS renewal_reminders_sent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      reminder_days INTEGER NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      UNIQUE(document_id, reminder_days)
    );

    CREATE INDEX IF NOT EXISTS idx_renewal_reminders_document_id ON renewal_reminders_sent(document_id);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      company_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      subscription_status TEXT DEFAULT 'TRIAL',
      subscription_period_start TEXT,
      subscription_period_end TEXT,
      payment_week_start_day TEXT DEFAULT 'monday',
      admin_email TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS setup_wizard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL UNIQUE,
      status TEXT DEFAULT 'NOT_STARTED',
      current_step TEXT DEFAULT 'company_info',
      company_name TEXT,
      company_address TEXT,
      payment_week_start_day TEXT DEFAULT 'monday',
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );

    CREATE TABLE IF NOT EXISTS weekly_email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      payment_week_start TEXT NOT NULL,
      payment_week_end TEXT NOT NULL,
      approved_count INTEGER DEFAULT 0,
      hold_count INTEGER DEFAULT 0,
      review_count INTEGER DEFAULT 0,
      sent_to TEXT,
      sent_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'sent',
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );

    CREATE TABLE IF NOT EXISTS outgoing_email_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_address TEXT NOT NULL,
      from_name TEXT NOT NULL,
      reply_to TEXT,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      html_body TEXT NOT NULL,
      attachments TEXT,
      client_id INTEGER,
      vendor_id INTEGER,
      email_type TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outgoing_email_queue_status ON outgoing_email_queue(status);

    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      message TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      reply_text TEXT,
      replied_at TEXT,
      replied_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_support_messages_tenant_id ON support_messages(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_support_messages_status ON support_messages(status);
  `);

  // ── Partner Program (referral / commission system) ────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS partners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      company_name TEXT,
      email TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      website TEXT,
      states_served TEXT,
      partner_type TEXT NOT NULL,
      tax_info_status TEXT DEFAULT 'not_submitted',
      preferred_payout_method TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','suspended','rejected','terminated')),
      referral_code TEXT UNIQUE,
      commission_percentage REAL DEFAULT 25.0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_partners_user_id ON partners(user_id);
    CREATE INDEX IF NOT EXISTS idx_partners_referral_code ON partners(referral_code);
    CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);

    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partner_id INTEGER NOT NULL REFERENCES partners(id),
      partner_code TEXT NOT NULL,
      referred_company TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      referral_date TEXT DEFAULT (datetime('now')),
      signup_date TEXT,
      subscription_start_date TEXT,
      subscription_plan TEXT,
      subscription_amount REAL,
      customer_status TEXT DEFAULT 'lead' CHECK(customer_status IN ('lead','trial','active','past_due','cancelled','refunded')),
      tenant_id INTEGER REFERENCES tenants(id),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_partner_id ON referrals(partner_id);
    CREATE INDEX IF NOT EXISTS idx_referrals_partner_code ON referrals(partner_code);
    CREATE INDEX IF NOT EXISTS idx_referrals_tenant_id ON referrals(tenant_id);

    CREATE TABLE IF NOT EXISTS commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partner_id INTEGER NOT NULL REFERENCES partners(id),
      referral_id INTEGER REFERENCES referrals(id),
      tenant_id INTEGER REFERENCES tenants(id),
      billing_period TEXT,
      eligible_revenue REAL NOT NULL,
      commission_percentage REAL NOT NULL,
      commission_amount REAL NOT NULL,
      earned_date TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','scheduled','paid','reversed','disputed')),
      payout_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_commissions_partner_id ON commissions(partner_id);
    CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status);
    CREATE INDEX IF NOT EXISTS idx_commissions_payout_id ON commissions(payout_id);
    -- Idempotency key for the automated commission job: one commission per
    -- (partner_id, tenant_id, billing_period). Created as a UNIQUE index
    -- (not a table constraint) because the table already exists; NULL
    -- tenant_id/billing_period rows (manual/legacy) are not constrained.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_commissions_partner_tenant_period ON commissions(partner_id, tenant_id, billing_period);

    CREATE TABLE IF NOT EXISTS payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partner_id INTEGER NOT NULL REFERENCES partners(id),
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled')),
      payment_date TEXT,
      payment_method TEXT,
      transaction_ref TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payouts_partner_id ON payouts(partner_id);

    CREATE TABLE IF NOT EXISTS partner_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partner_id INTEGER NOT NULL REFERENCES partners(id),
      action TEXT NOT NULL,
      changes TEXT,
      reason TEXT,
      performed_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_partner_audit_log_partner_id ON partner_audit_log(partner_id);
  `);

  // ── Stripe Connect (delegation B) ──────────────────────────
  // Partner payout rails: stripe_account_id + onboarding fields (fed by the
  // account.updated webhook), and tenant subscription fields (fed by
  // customer.subscription.* webhooks).
  ensureColumn(db, "partners", "stripe_account_id TEXT", "stripe_account_id");
  ensureColumn(db, "partners", "stripe_details_submitted INTEGER NOT NULL DEFAULT 0", "stripe_details_submitted");
  ensureColumn(db, "partners", "stripe_currently_due TEXT", "stripe_currently_due");
  ensureColumn(db, "partners", "stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0", "stripe_payouts_enabled");
  ensureColumn(db, "partners", "stripe_charges_enabled INTEGER NOT NULL DEFAULT 0", "stripe_charges_enabled");
  ensureColumn(db, "partners", "stripe_disconnected_at TEXT", "stripe_disconnected_at");
  ensureColumn(db, "tenants", "stripe_customer_id TEXT", "stripe_customer_id");
  ensureColumn(db, "tenants", "stripe_subscription_id TEXT", "stripe_subscription_id");
  // payouts.status must accept 'failed' (Stripe Connect transfer failures).
  // SQLite can't ALTER a CHECK constraint, so rebuild the table (same pattern
  // as the email_log rebuild above). Nothing references payouts (commissions
  // .payout_id is a plain column, no FK), so the DROP is safe.
  const payoutsDdl = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payouts'").get() as { sql: string } | undefined;
  if (payoutsDdl && !payoutsDdl.sql.includes("'failed'")) {
    db.exec(`
      CREATE TABLE payouts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        partner_id INTEGER NOT NULL REFERENCES partners(id),
        amount REAL NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','cancelled')),
        payment_date TEXT,
        payment_method TEXT,
        transaction_ref TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.exec(`INSERT INTO payouts_new (id, partner_id, amount, status, payment_date, payment_method, transaction_ref, notes, created_at) SELECT id, partner_id, amount, status, payment_date, payment_method, transaction_ref, notes, created_at FROM payouts`);
    db.exec("DROP TABLE payouts");
    db.exec("ALTER TABLE payouts_new RENAME TO payouts");
    db.exec("CREATE INDEX IF NOT EXISTS idx_payouts_partner_id ON payouts(partner_id)");
    console.log("[db] Rebuilt payouts table — status CHECK now includes 'failed'");
  }

  ensureColumn(db, "documents", "tenant_id INTEGER REFERENCES tenants(id)", "tenant_id");
  ensureColumn(db, "tenants", "inbox_slug TEXT", "inbox_slug");
  ensureColumn(db, "tenants", "subscription_plan TEXT DEFAULT NULL", "subscription_plan");
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, raw_email_json TEXT NOT NULL, processed BOOLEAN NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`) ;
  ensureColumn(db, "inbox_queue", "error TEXT", "error");
  ensureColumn(db, "inbox_queue", "processed_at TEXT", "processed_at");
  // Populate inbox slugs for tenants created before this migration.
  const missingSlugs = db.query("SELECT id, name FROM tenants WHERE inbox_slug IS NULL OR inbox_slug = ''").all() as Array<{id:number;name:string}>;
  for (const t of missingSlugs) { let base=(t.name||"company").toLowerCase().replace(/[\s_-]+/g,"-").replace(/[^a-z0-9-]/g,"").replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,40)||"company"; let slug=base, n=2; while (db.query("SELECT id FROM tenants WHERE inbox_slug = $slug AND id != $id").get({$slug:slug,$id:t.id})) slug=`${base.slice(0, Math.max(1,40-(String(n).length+1)))}-${n++}`; db.query("UPDATE tenants SET inbox_slug=$slug WHERE id=$id").run({$slug:slug,$id:t.id}); }
  // MVP document uploads may be unassigned until a client/vendor is selected.
  const docCols = db.query("PRAGMA table_info(documents)").all() as Array<{ name: string; notnull: number }>;
  if (docCols.some(c => (c.name === "vendor_id" || c.name === "client_id") && c.notnull === 1)) {
    db.exec(`CREATE TABLE documents_new (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER, client_id INTEGER, document_type TEXT, file_path TEXT NOT NULL, original_filename TEXT NOT NULL, content_type TEXT, file_size INTEGER, sender_name TEXT, sender_email TEXT, received_date TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')), tenant_id INTEGER, FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE, FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE)`);
    db.exec(`INSERT INTO documents_new (id,vendor_id,client_id,document_type,file_path,original_filename,sender_name,sender_email,received_date,created_at,tenant_id) SELECT id,vendor_id,client_id,document_type,file_path,original_filename,sender_name,sender_email,received_date,created_at,tenant_id FROM documents`);
    db.exec("DROP TABLE documents");
    db.exec("ALTER TABLE documents_new RENAME TO documents");
  }
  ensureColumn(db, "documents", "content_type TEXT", "content_type");
  ensureColumn(db, "documents", "file_size INTEGER", "file_size");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_vendor_id ON documents(vendor_id); CREATE INDEX IF NOT EXISTS idx_documents_client_id ON documents(client_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS ingestion_events (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','processing','ready','error')), error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_ingestion_events_document_id ON ingestion_events(document_id); CREATE INDEX IF NOT EXISTS idx_ingestion_events_status ON ingestion_events(status);");

  // tenant_id columns on existing tables (SQLite lacks ADD COLUMN IF NOT EXISTS,
  // so check PRAGMA table_info first — this is the "IF NOT EXISTS" pattern)
  ensureColumn(db, "users", "tenant_id INTEGER REFERENCES tenants(id)", "tenant_id");
  ensureColumn(db, "clients", "tenant_id INTEGER REFERENCES tenants(id)", "tenant_id");
  ensureColumn(db, "vendors", "tenant_id INTEGER REFERENCES tenants(id)", "tenant_id");
  ensureColumn(db, "documents", "tenant_id INTEGER REFERENCES tenants(id)", "tenant_id");
  ensureColumn(db, "document_extractions", "certificate_holder_address TEXT", "certificate_holder_address");
  ensureColumn(db, "document_extractions", "certificate_holder_name_confidence REAL NOT NULL DEFAULT 0.0", "certificate_holder_name_confidence");
  ensureColumn(db, "document_extractions", "insured_address TEXT", "insured_address");
  ensureColumn(db, "document_extractions", "w9_form_date TEXT", "w9_form_date");
  // Extraction provenance: 'ai' (real vision-model extraction) vs 'filename'
  // (honest filename-only fallback). Never fabricate fields on the fallback.
  ensureColumn(db, "document_extractions", "extraction_method TEXT DEFAULT 'filename'", "extraction_method");
  // ── Remediation for the heuristic-fabrication bug ─────────────────────
  // The deleted random-value fallback is the ONLY thing that ever wrote an
  // ai_confidence_score > 1.0 (real AI stores 0.0–1.0, and the manual-edit
  // endpoint never touches ai_confidence_score). Seed fixtures live under
  // data/documents/, so restricting to data/uploads/ isolates uploaded docs.
  // 1) Tag legacy real-AI rows (original score 0.0–1.0) as 'ai' FIRST, while
  //    their original scores are still intact. Rows with score exactly 0 are
  //    excluded: the remediation below zeroes scores, so this keeps the
  //    migration idempotent across restarts.
  db.exec(`
    UPDATE document_extractions
    SET extraction_method = 'ai'
    WHERE extraction_method = 'filename'
      AND ai_confidence_score > 0.0
      AND ai_confidence_score <= 1.0
  `);
  // 2) Then clear every invented field from the heuristic-fabricated rows and
  //    send them back to Needs Review so no compliance status keeps depending
  //    on fake dates.
  db.exec(`
    UPDATE document_extractions
    SET extraction_method = 'filename',
        is_reviewed = 0,
        insurance_carrier = NULL,
        policy_number = NULL,
        effective_date = NULL,
        expiration_date = NULL,
        certificate_holder = NULL,
        certificate_holder_address = NULL,
        insured_address = NULL,
        w9_form_date = NULL,
        certificate_holder_name_confidence = 0,
        ai_confidence_score = 0
    WHERE ai_confidence_score > 1.0
      AND document_id IN (SELECT id FROM documents WHERE file_path LIKE 'data/uploads/%')
  `);
  ensureColumn(db, "vendors", "address TEXT", "address");
  ensureColumn(db, "vendors", "normalized_key TEXT", "normalized_key");
  ensureColumn(db, "clients", "normalized_key TEXT", "normalized_key");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_tenant_normalized ON clients(tenant_id, normalized_key) WHERE normalized_key IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_client_normalized ON vendors(client_id, normalized_key) WHERE normalized_key IS NOT NULL;");

  // Password reset tokens (forgot-password flow). SQLite lacks ALTER TABLE ...
  // ADD COLUMN IF NOT EXISTS, so ensureColumn checks PRAGMA table_info first.
  ensureColumn(db, "users", "reset_token TEXT", "reset_token");
  ensureColumn(db, "users", "reset_token_expires TEXT", "reset_token_expires");

  // Role-based access: 'user' (default), 'partner', 'admin'
  ensureColumn(db, "users", "role TEXT DEFAULT 'user'", "role");

  // Extend email_log.email_type CHECK to include 'partner_payout' (in addition
  // to 'password_reset'). SQLite can't ALTER a CHECK constraint, so rebuild the
  // table (same pattern as the documents table rebuild above). Nothing
  // references email_log, so the DROP is safe even with foreign_keys = ON.
  const emailLogDdl = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_log'").get() as { sql: string } | undefined;
  if (emailLogDdl && !emailLogDdl.sql.includes("'partner_payout'")) {
    db.exec(`
      CREATE TABLE email_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        vendor_id INTEGER,
        email_type TEXT NOT NULL CHECK (email_type IN ('weekly_report', 'monthly_report', 'renewal_reminder', 'password_reset', 'partner_payout')),
        recipient_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'error')),
        error_message TEXT,
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL
      );
    `);
    db.exec(`INSERT INTO email_log_new (id, client_id, vendor_id, email_type, recipient_email, subject, sent_at, status, error_message) SELECT id, client_id, vendor_id, email_type, recipient_email, subject, sent_at, status, error_message FROM email_log`);
    db.exec("DROP TABLE email_log");
    db.exec("ALTER TABLE email_log_new RENAME TO email_log");
    db.exec("CREATE INDEX IF NOT EXISTS idx_email_log_client_id ON email_log(client_id); CREATE INDEX IF NOT EXISTS idx_email_log_email_type ON email_log(email_type); CREATE INDEX IF NOT EXISTS idx_email_log_sent_at ON email_log(sent_at);");
    console.log("[db] Extended email_log.email_type CHECK to include partner_payout");
  }

  // Email attachments: JSON array of { filename, contentType, storageKey } on
  // outgoing_email_queue rows. The delivery worker resolves the bytes from
  // storage when it claims the row (process-queue), so no payload is stored in
  // the DB itself.
  ensureColumn(db, "outgoing_email_queue", "attachments TEXT", "attachments");

  // Backfill legacy/test users so every authenticated user has an isolated tenant.
  const legacyUsers = db.query("SELECT id, company_name FROM users WHERE tenant_id IS NULL").all() as Array<{ id: number; company_name: string }>;
  for (const user of legacyUsers) {
    const tenantResult = db.query(`INSERT INTO tenants (name, owner_user_id, subscription_status) VALUES ($name, $uid, 'TRIAL')`).run({ $name: user.company_name || "My Company", $uid: user.id });
    const tenantId = Number(tenantResult.lastInsertRowid);
    db.query("INSERT INTO setup_wizard (tenant_id, status, current_step, company_name, completed_at) VALUES ($tid, 'COMPLETED', 'completed', $name, datetime('now'))").run({ $tid: tenantId, $name: user.company_name || "My Company" });
    db.query("UPDATE users SET tenant_id = $tid WHERE id = $uid").run({ $tid: tenantId, $uid: user.id });
    // Existing rows predate tenant columns; assign them to the legacy user's tenant
    // only when there is exactly one legacy user, avoiding ambiguous data moves.
    if (legacyUsers.length === 1) {
      db.query("UPDATE clients SET tenant_id = $tid WHERE tenant_id IS NULL").run({ $tid: tenantId });
      db.query("UPDATE vendors SET tenant_id = $tid WHERE tenant_id IS NULL").run({ $tid: tenantId });
      db.query("UPDATE documents SET tenant_id = $tid WHERE tenant_id IS NULL").run({ $tid: tenantId });
    }
  }

  // Required-docs coverage amounts: client_required_documents.coverage_requirement
  // (TEXT, nullable) — the coverage amount a client needs for each document type.
  ensureColumn(db, "client_required_documents", "coverage_requirement TEXT", "coverage_requirement");
  // Wizard resume marker: the tenant's own client row the wizard attaches its
  // Compliance Requirements step to (null until that step is saved).
  ensureColumn(db, "setup_wizard", "compliance_client_id INTEGER", "compliance_client_id");
  // Backfill the owner-set default requirement list into clients that have zero
  // configured rows (existing config is never overwritten).
  const zeroConfigClients = db.query(
    "SELECT c.id FROM clients c WHERE NOT EXISTS (SELECT 1 FROM client_required_documents r WHERE r.client_id = c.id)"
  ).all() as Array<{ id: number }>;
  let backfilled = 0;
  for (const client of zeroConfigClients) {
    backfilled += applyDefaultRequiredDocs(db, client.id);
  }
  if (backfilled > 0) console.log(`[db] Backfilled default required documents for ${zeroConfigClients.length} client(s) (${backfilled} rows)`);
  console.log("[db] Migrations complete — all tables ready");
}

function ensureColumn(db: Database, table: string, columnDef: string, columnName: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    console.log(`[db] Added column "${columnName}" to ${table}`);
  }
}
// Insert the standard default required-documents set for a client, but ONLY when
// the client has zero configured rows — never overwrite existing customization.
// Returns the number of rows inserted (0 when the client already had config).
export function applyDefaultRequiredDocs(db: Database, clientId: number): number {
  const existing = db.query(
    "SELECT COUNT(*) AS c FROM client_required_documents WHERE client_id = $id"
  ).get({ $id: clientId }) as { c: number };
  if (existing.c > 0) return 0;
  const insert = db.query(
    "INSERT INTO client_required_documents (client_id, document_type, coverage_requirement) VALUES ($cid, $dt, $cov)"
  );
  for (const d of DEFAULT_REQUIRED_DOCUMENTS) {
    insert.run({ $cid: clientId, $dt: d.document_type, $cov: d.coverage_requirement });
  }
  return DEFAULT_REQUIRED_DOCUMENTS.length;
}
