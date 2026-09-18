import { Database } from "bun:sqlite";
import path from "node:path";
import { companyNameToSlug } from "./lib/inbox";
import { entityKey } from "./entities";
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
    -- Tenant-scoped access patterns (every tenant data query filters by tenant_id)
    CREATE INDEX IF NOT EXISTS idx_documents_tenant_id ON documents(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_vendors_tenant_id ON vendors(tenant_id);
    -- Compliance engine: per-type document lookups + expiring-during-week scans
    CREATE INDEX IF NOT EXISTS idx_documents_vendor_doctype ON documents(vendor_id, document_type);
    CREATE INDEX IF NOT EXISTS idx_document_extractions_expiration_date ON document_extractions(expiration_date);
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
      email_type TEXT NOT NULL CHECK (email_type IN ('weekly_report', 'monthly_report', 'renewal_reminder', 'password_reset', 'partner_payout', 'inbox_rejection', 'internal_alert', 'partner_application_notify', 'daily_review_trigger', 'vendor_request')),
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
      subscription_status TEXT DEFAULT 'PENDING',
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

    -- Scheduler reliability (2026-08-15): persisted last-run markers so an API
    -- restart can never re-fire the weekly/monthly/daily batches (double-send).
    -- Also holds watchdog/backup rate-limit markers. Values are short TEXT.
    CREATE TABLE IF NOT EXISTS scheduler_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Nightly offsite backup audit trail (2026-08-15): one row per backup run
    -- (success or failure), mirrored to console output. R2 object lives under
    -- the backups/ prefix of the storage bucket.
    CREATE TABLE IF NOT EXISTS backup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backup_key TEXT,
      size_bytes INTEGER,
      status TEXT NOT NULL CHECK (status IN ('success','error')),
      error_message TEXT,
      retention_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_backup_log_created_at ON backup_log(created_at);

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
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','cancelled')),
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
  // W-9 (tax form) — REQUIRED before a partner may refer. The document is
  // stored in object storage under partners/<id>/w9-<ts>.<ext>; only the file
  // key/filename/upload-time live in the DB (admin-only surface).
  ensureColumn(db, "partners", "w9_file_key TEXT", "w9_file_key");
  ensureColumn(db, "partners", "w9_filename TEXT", "w9_filename");
  ensureColumn(db, "partners", "w9_uploaded_at TEXT", "w9_uploaded_at");
  ensureColumn(db, "tenants", "stripe_customer_id TEXT", "stripe_customer_id");
  ensureColumn(db, "tenants", "stripe_subscription_id TEXT", "stripe_subscription_id");
  // Trial end date (Unix epoch stored as TEXT) — set when a trialing
  // subscription is created via checkout (trial_period_days), cleared once the
  // trial converts to a real paid subscription.
  ensureColumn(db, "tenants", "subscription_trial_end TEXT", "subscription_trial_end");
  ensureColumn(db, "tenants", "cancel_at_period_end INTEGER NOT NULL DEFAULT 0", "cancel_at_period_end");
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

  // ── Coverage enforcement: compliance_status.status must accept 'below_limit' ──
  // SQLite can't ALTER a CHECK constraint, so rebuild the table (same pattern as
  // the payouts rebuild above). compliance_status is a leaf table (nothing
  // references it), so the DROP is safe. The unique index on vendor_id is
  // recreated after the rename.
  const csDdl = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compliance_status'").get() as { sql: string } | undefined;
  if (csDdl && !csDdl.sql.includes("'below_limit'")) {
    db.exec(`
      CREATE TABLE compliance_status_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_id INTEGER NOT NULL,
        client_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'needs_review'
          CHECK (status IN ('compliant', 'expiring_soon', 'expired', 'needs_review', 'below_limit')),
        payment_status TEXT NOT NULL DEFAULT 'hold'
          CHECK (payment_status IN ('approved', 'review', 'hold')),
        calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      );
    `);
    db.exec(`INSERT INTO compliance_status_new (id, vendor_id, client_id, status, payment_status, calculated_at) SELECT id, vendor_id, client_id, status, payment_status, calculated_at FROM compliance_status`);
    db.exec("DROP TABLE compliance_status");
    db.exec("ALTER TABLE compliance_status_new RENAME TO compliance_status");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_status_vendor_id_unique ON compliance_status(vendor_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_compliance_status_vendor_id ON compliance_status(vendor_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_compliance_status_client_id ON compliance_status(client_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_compliance_status_status ON compliance_status(status)");
    console.log("[db] Rebuilt compliance_status table — status CHECK now includes 'below_limit'");
  }

  // Per-tenant company logo (TopBar branding): object-storage key under
  // logos/tenant-<id>.<ext>; NULL until the tenant uploads one.
  ensureColumn(db, "tenants", "logo_key TEXT", "logo_key");
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, raw_email_json TEXT NOT NULL, processed BOOLEAN NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`) ;
  ensureColumn(db, "inbox_queue", "error TEXT", "error");
  ensureColumn(db, "inbox_queue", "processed_at TEXT", "processed_at");
  // P1 inbox tolerance: rejected_attachments holds the JSON [{filename, reason}]
  // list for a partially-rejected email (auditable record of what was NOT
  // ingested and why); dedup_key is a SHA-256 of the poller payload so a
  // retried email is acknowledged without re-ingesting its attachments.
  ensureColumn(db, "inbox_queue", "rejected_attachments TEXT", "rejected_attachments");
  ensureColumn(db, "inbox_queue", "dedup_key TEXT", "dedup_key");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_queue_dedup_key ON inbox_queue(dedup_key)");
  // Populate/re-derive inbox slugs in the owner's per-company format: company
  // name with all non-alphanumeric characters removed, case preserved
  // ("ABC Company" → "ABCCompany"). Tenants with a legacy lowercase-dash slug
  // (created before this format) are re-derived on next startup; slugs that are
  // already alphanumeric-only are left alone. Collisions are suffixed
  // numerically ("ABCCompany2") and compared case-insensitively (email local
  // parts are case-insensitive in practice).
  const missingOrLegacy = db.query(
    "SELECT id, name FROM tenants WHERE inbox_slug IS NULL OR inbox_slug = '' OR inbox_slug GLOB '*[^A-Za-z0-9]*'"
  ).all() as Array<{ id: number; name: string }>;
  for (const t of missingOrLegacy) {
    const base = companyNameToSlug(t.name);
    let slug = base, n = 2;
    while (db.query("SELECT id FROM tenants WHERE inbox_slug = $slug COLLATE NOCASE AND id != $id").get({ $slug: slug, $id: t.id })) slug = `${base.slice(0, Math.max(1, 60 - String(n).length))}${n++}`;
    db.query("UPDATE tenants SET inbox_slug=$slug WHERE id=$id").run({ $slug: slug, $id: t.id });
  }
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
  // Producer block (ACORD COI top-right: agency/agent that issued the cert).
  // Only populated for COI-type documents; null otherwise. producer_email is
  // the preferred renewal-reminder recipient for COIs.
  ensureColumn(db, "document_extractions", "producer_name TEXT", "producer_name");
  ensureColumn(db, "document_extractions", "producer_contact TEXT", "producer_contact");
  ensureColumn(db, "document_extractions", "producer_email TEXT", "producer_email");
  ensureColumn(db, "document_extractions", "producer_phone TEXT", "producer_phone");
  // ── Coverage enforcement (2026-08-15, owner "Simple") ────────────────────
  // One dollar limit per insurance doc type, extracted by AI from the printed
  // certificate (whole dollars). NULL = not read/unreadable → the engine holds
  // the type in needs_review (never auto-Hold on a parse miss). Existing rows
  // stay NULL, which is the safe "needs review" default.
  ensureColumn(db, "document_extractions", "coverage_gl_occurrence INTEGER", "coverage_gl_occurrence");
  ensureColumn(db, "document_extractions", "coverage_gl_aggregate INTEGER", "coverage_gl_aggregate");
  ensureColumn(db, "document_extractions", "coverage_wc_employers INTEGER", "coverage_wc_employers");
  ensureColumn(db, "document_extractions", "coverage_auto_csl INTEGER", "coverage_auto_csl");
  ensureColumn(db, "document_extractions", "coverage_umbrella INTEGER", "coverage_umbrella");
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
  // Branded-inbox sender routing (owner directive 2026-09-10): inbound mail is
  // routed to a tenant by the sender's address, matched against every vendor
  // email column. insurance_agent_email lets a vendor's agent send COIs from
  // their own address and still land on the right tenant.
  ensureColumn(db, "vendors", "insurance_agent_email TEXT", "insurance_agent_email");
  ensureColumn(db, "clients", "normalized_key TEXT", "normalized_key");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_tenant_normalized ON clients(tenant_id, normalized_key) WHERE normalized_key IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_client_normalized ON vendors(client_id, normalized_key) WHERE normalized_key IS NOT NULL;");

  // ── Backfill normalized_key for rows created before the dedup columns were
  // written on every creation path (CSV import / manual add used to skip it).
  // Idempotent: only touches rows that still have NULL, and uses UPDATE OR
  // IGNORE so a true duplicate (same name, no address, same client) keeps only
  // its first row — the second stays NULL and is flagged rather than crashing
  // the unique index. Runs on every startup; with no NULL rows it's a no-op.
  const vendorNulls = db.query("SELECT id, name, address FROM vendors WHERE normalized_key IS NULL").all() as Array<{ id: number; name: string; address: string | null }>;
  for (const v of vendorNulls) {
    const key = entityKey(v.name, v.address);
    if (!key) continue;
    const r = db.query("UPDATE OR IGNORE vendors SET normalized_key = $key WHERE id = $id").run({ $key: key, $id: v.id });
    if (r.changes === 0) console.warn(`[db] backfill: vendor ${v.id} ("${v.name}") has an identical normalized_key to another vendor under the same client — left NULL for manual resolution`);
  }
  const clientNulls = db.query("SELECT id, name, address FROM clients WHERE normalized_key IS NULL").all() as Array<{ id: number; name: string; address: string | null }>;
  for (const cl of clientNulls) {
    const key = entityKey(cl.name, cl.address);
    if (!key) continue;
    const r = db.query("UPDATE OR IGNORE clients SET normalized_key = $key WHERE id = $id").run({ $key: key, $id: cl.id });
    if (r.changes === 0) console.warn(`[db] backfill: client ${cl.id} ("${cl.name}") has an identical normalized_key to another client under the same tenant — left NULL for manual resolution`);
  }

  // Password reset tokens (forgot-password flow). SQLite lacks ALTER TABLE ...
  // ADD COLUMN IF NOT EXISTS, so ensureColumn checks PRAGMA table_info first.
  ensureColumn(db, "users", "reset_token TEXT", "reset_token");
  ensureColumn(db, "users", "reset_token_expires TEXT", "reset_token_expires");

  // Role-based access: 'user' (default), 'partner', 'admin'
  ensureColumn(db, "users", "role TEXT DEFAULT 'user'", "role");
  // Partner login usernames: each partner chooses a username when they set
  // their password; they sign in with username + password (email is
  // notification-only). SQLite unique indexes allow multiple NULLs, so client
  // users (username NULL) are unaffected while partner usernames are unique.
  ensureColumn(db, "users", "username TEXT", "username");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");
  // How the partner heard about the program (dropdown on the application form:
  // Flyer / Social Media / Other Agency). Nullable; never whitelisted server-side.
  ensureColumn(db, "partners", "hear_about_us TEXT", "hear_about_us");

  // Extend email_log.email_type CHECK to include 'partner_payout',
  // 'inbox_rejection' and 'internal_alert'. SQLite can't ALTER a CHECK
  // constraint, so rebuild the table (same pattern as the documents table
  // rebuild above). Nothing references email_log, so the DROP is safe even with
  // foreign_keys = ON.
  const emailLogDdl = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_log'").get() as { sql: string } | undefined;
  if (emailLogDdl && !emailLogDdl.sql.includes("'internal_alert'")) {
    db.exec(`
      CREATE TABLE email_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        vendor_id INTEGER,
        email_type TEXT NOT NULL CHECK (email_type IN ('weekly_report', 'monthly_report', 'renewal_reminder', 'password_reset', 'partner_payout', 'inbox_rejection', 'internal_alert')),
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
    console.log("[db] Extended email_log.email_type CHECK to include partner_payout + inbox_rejection + internal_alert");
  }
  // Extend email_log.email_type CHECK to include 'partner_application_notify'
  // (owner notification on every new partner application). Same rebuild
  // pattern as above — SQLite can't ALTER a CHECK constraint. Guarded on the
  // new value so it is a no-op once applied.
  const emailLogDdl2 = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_log'").get() as { sql: string } | undefined;
  if (emailLogDdl2 && !emailLogDdl2.sql.includes("'partner_application_notify'")) {
    db.exec(`
      CREATE TABLE email_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        vendor_id INTEGER,
        email_type TEXT NOT NULL CHECK (email_type IN ('weekly_report', 'monthly_report', 'renewal_reminder', 'password_reset', 'partner_payout', 'inbox_rejection', 'internal_alert', 'partner_application_notify')),
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
    console.log("[db] Extended email_log.email_type CHECK to include partner_application_notify");
  }
  // Extend email_log.email_type CHECK to include 'daily_review_trigger' (the
  // internal once-per-day improvement-review prompt email). Same rebuild
  // pattern as above — SQLite can't ALTER a CHECK constraint. The new table's
  // allowed list includes BOTH partner_application_notify and
  // daily_review_trigger so the migration is a superset of every prior one.
  // Guarded on the new value so it is a no-op once applied.
  const emailLogDdl3 = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_log'").get() as { sql: string } | undefined;
  if (emailLogDdl3 && !emailLogDdl3.sql.includes("'daily_review_trigger'")) {
    db.exec(`
      CREATE TABLE email_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        vendor_id INTEGER,
        email_type TEXT NOT NULL CHECK (email_type IN ('weekly_report', 'monthly_report', 'renewal_reminder', 'password_reset', 'partner_payout', 'inbox_rejection', 'internal_alert', 'partner_application_notify', 'daily_review_trigger')),
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
    console.log("[db] Extended email_log.email_type CHECK to include daily_review_trigger");
  }
  // Extend email_log.email_type CHECK to include 'vendor_request' (the
  // client-initiated "Request updated docs" vendor outreach). Same rebuild
  // pattern as above — SQLite can't ALTER a CHECK constraint. The new table's
  // allowed list includes EVERY earlier value plus vendor_request, so this
  // migration is a superset of the prior ones. Guarded on the new value, so it
  // is a no-op once applied.
  const emailLogDdl4 = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_log'").get() as { sql: string } | undefined;
  if (emailLogDdl4 && !emailLogDdl4.sql.includes("'vendor_request'")) {
    db.exec(`
      CREATE TABLE email_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        vendor_id INTEGER,
        email_type TEXT NOT NULL CHECK (email_type IN ('weekly_report', 'monthly_report', 'renewal_reminder', 'password_reset', 'partner_payout', 'inbox_rejection', 'internal_alert', 'partner_application_notify', 'daily_review_trigger', 'vendor_request')),
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
    console.log("[db] Extended email_log.email_type CHECK to include vendor_request");
  }

  // Email attachments: JSON array of { filename, contentType, storageKey } on
  // outgoing_email_queue rows. The delivery worker resolves the bytes from
  // storage when it claims the row (process-queue), so no payload is stored in
  // the DB itself.
  ensureColumn(db, "outgoing_email_queue", "attachments TEXT", "attachments");

  // Backfill legacy/test users so every authenticated user has an isolated tenant.
  // Partner accounts are NOT a paywalled tier: they get their own portal and must
  // never be gated on a client subscription status, so their tenant is created
  // ACTIVE. Client tenants keep the PENDING paywall status (they flip to TRIAL /
  // ACTIVE through Stripe checkout).
  const legacyUsers = db.query("SELECT id, company_name, role FROM users WHERE tenant_id IS NULL").all() as Array<{ id: number; company_name: string; role: string | null }>;
  for (const user of legacyUsers) {
    const backfillStatus = user.role === "partner" ? "ACTIVE" : "PENDING";
    const tenantResult = db.query(`INSERT INTO tenants (name, owner_user_id, subscription_status) VALUES ($name, $uid, $status)`).run({ $name: user.company_name || "My Company", $uid: user.id, $status: backfillStatus });
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

  // Repair partner tenants that were created earlier on the client paywall
  // status. Partners use their own portal and are never gated on a client
  // subscription status, so a partner-owned tenant must not sit on PENDING
  // (which 402s every tenant data route through requireTenant). Idempotent.
  const repairedPartnerTenants = db.query(`
    UPDATE tenants SET subscription_status = 'ACTIVE', updated_at = datetime('now')
    WHERE UPPER(COALESCE(subscription_status, '')) = 'PENDING'
      AND owner_user_id IN (SELECT id FROM users WHERE role = 'partner')
  `).run();
  if (repairedPartnerTenants.changes > 0) {
    console.log(`[db] Activated ${repairedPartnerTenants.changes} partner tenant(s) — partners are not a paywalled tier`);
  }

  // Required-docs coverage amounts: client_required_documents.coverage_requirement
  // (TEXT, nullable) — the coverage amount a client needs for each document type.
  ensureColumn(db, "client_required_documents", "coverage_requirement TEXT", "coverage_requirement");
  // Wizard resume marker: the tenant's own client row the wizard attaches its
  // Compliance Requirements step to (null until that step is saved).
  ensureColumn(db, "setup_wizard", "compliance_client_id INTEGER", "compliance_client_id");
  // Server-side record of the setup wizard's liability acknowledgment (the
  // confirmation step's checkbox). Completion is rejected unless acknowledged
  // is truthy, so the acknowledgment is enforceable, not just client-side UI.
  ensureColumn(db, "setup_wizard", "acknowledged INTEGER NOT NULL DEFAULT 0", "acknowledged");
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

  // ── In-App AI Chat Assistant (v1) ─────────────────────────
  // Tenant-scoped chat_messages: one row per user/assistant exchange with
  // per-exchange LLM usage so cost stays visible. status_cards holds the
  // JSON {payment_status, vendor_name} verdict (JSON-in-TEXT, same pattern as
  // outgoing_email_queue.attachments).
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      message TEXT NOT NULL,
      status_cards TEXT,
      escalate INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      cost_estimate REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant_session ON chat_messages(tenant_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant_created ON chat_messages(tenant_id, created_at);
  `);
  console.log("[db] chat_messages table ready");
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
