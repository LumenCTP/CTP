import { Database } from "bun:sqlite";
import path from "node:path";

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
      status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'error')),
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
  `);

  ensureColumn(db, "documents", "tenant_id INTEGER REFERENCES tenants(id)", "tenant_id");
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
  ensureColumn(db, "vendors", "address TEXT", "address");
  ensureColumn(db, "vendors", "normalized_key TEXT", "normalized_key");
  ensureColumn(db, "clients", "normalized_key TEXT", "normalized_key");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_tenant_normalized ON clients(tenant_id, normalized_key) WHERE normalized_key IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_client_normalized ON vendors(client_id, normalized_key) WHERE normalized_key IS NOT NULL;");

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

  console.log("[db] Migrations complete — all tables ready");
}

function ensureColumn(db: Database, table: string, columnDef: string, columnName: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    console.log(`[db] Added column "${columnName}" to ${table}`);
  }
}
