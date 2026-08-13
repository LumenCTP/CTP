import { getDb } from "./db";
import { companyNameToSlug } from "./lib/inbox";
import { QUEUE_SECRET } from "./secrets";

// All tenant-owned data endpoints require both authentication and a tenant.
// Keeping this as a path middleware prevents a newly-added data route from
// accidentally becoming a cross-tenant data leak.
export const TENANT_DATA_PATHS = [
  "/api/clients", "/api/clients/*", "/api/vendors", "/api/vendors/*",
  "/api/documents", "/api/documents/*", "/api/needs-review",
  "/api/dashboard/stats", "/api/dashboard/*", "/api/compliance/*", "/api/reports/*", "/api/audit/*",
  "/api/emails/*",
  "/api/inbox/*",
  "/api/import/*",
  "/api/support/*",
];
// Queue processor endpoints are intentionally unauthenticated JWT-wise, but protected
// by a shared secret (they are called by the internal scheduler/delivery worker).
export function isQueueRoute(c: any): boolean {
  const path = c.req.path;
  return path === "/api/emails/process-queue" || path === "/api/emails/mark-sent" || path === "/api/emails/mark-failed" || path === "/api/inbox/ingest" || path === "/api/inbox/relay" || path === "/api/inbox/receive";
}
export function requireQueueSecret(c: any): Response | null {
  if (c.req.header("X-Queue-Secret") !== QUEUE_SECRET) {
    return c.json({ error: "Invalid queue secret" }, 401);
  }
  return null;
}
// ── Auth Token Helpers ──────────────────────────────────

const TOKEN_SECRET = process.env.TOKEN_SECRET || "cleartopay-secret-" + crypto.randomUUID();
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function createAuthToken(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Date.now();
  const tokenPayload = {
    ...payload,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + TOKEN_EXPIRY_MS) / 1000),
  };

  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=+$/, "");
  const payloadB64 = btoa(JSON.stringify(tokenPayload)).replace(/=+$/, "");
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signingInput}.${signatureB64}`;
}

export async function verifyAuthToken(token: string): Promise<{ user_id: number; email: string; full_name: string } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(TOKEN_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = Uint8Array.from(
      atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(signingInput));
    if (!valid) return null;

    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;

    return {
      user_id: payload.user_id as number,
      email: payload.email as string,
      full_name: payload.full_name as string,
    };
  } catch {
    return null;
  }
}

// Middleware to require auth
export async function requireAuth(c: any, next: any) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = authHeader.slice(7);
  const user = await verifyAuthToken(token);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", user);
  return next();
}
// ── Tenant Helpers ─────────────────────────────────────

export interface TenantRow {
  id: number;
  name: string;
  owner_user_id: number;
  subscription_status: string;
  subscription_plan: string | null;
  subscription_period_start: string | null;
  subscription_period_end: string | null;
  payment_week_start_day: string;
  admin_email: string | null;
  created_at: string;
  updated_at: string;
  inbox_slug: string | null;
}

export interface WizardRow {
  id: number;
  tenant_id: number;
  status: string;
  current_step: string;
  company_name: string | null;
  company_address: string | null;
  payment_week_start_day: string;
  compliance_client_id: number | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function findTenantForUser(db: ReturnType<typeof getDb>, userId: number): TenantRow | undefined {
  return db.query(
    "SELECT * FROM tenants WHERE owner_user_id = $uid ORDER BY id LIMIT 1"
  ).get({ $uid: userId }) as TenantRow | undefined;
}

export function findWizard(db: ReturnType<typeof getDb>, tenantId: number): WizardRow | undefined {
  return db.query(
    "SELECT * FROM setup_wizard WHERE tenant_id = $tid"
  ).get({ $tid: tenantId }) as WizardRow | undefined;
}

export function createTenantForUser(
  db: ReturnType<typeof getDb>,
  userId: number,
  opts?: { name?: string; subscription_status?: string; periodStart?: string; periodEnd?: string; subscription_plan?: string | null }
): TenantRow {
  const name = opts?.name || "My Company";
  // New tenants start PENDING — they must complete payment at checkout before
  // the app (and its data routes) unlock. The webhook / checkout-confirm path
  // flips the tenant to ACTIVE once payment is collected.
  const status = opts?.subscription_status || "PENDING";
  // Per-company slug: company name with all non-alphanumeric characters
  // removed, case preserved ("ABC Company" → "ABCCompany").
  const base = companyNameToSlug(name);
  let slug = base, suffix = 2;
  while (db.query("SELECT id FROM tenants WHERE inbox_slug = $slug COLLATE NOCASE").get({ $slug: slug })) slug = `${base.slice(0, Math.max(1, 60 - String(suffix).length))}${suffix++}`;
  const result = db.query(`
    INSERT INTO tenants (name, owner_user_id, subscription_status, subscription_period_start, subscription_period_end, inbox_slug, subscription_plan)
    VALUES ($name, $uid, $status, $start, $end, $slug, $plan)
  `).run({
    $name: name,
    $uid: userId,
    $status: status,
    $start: opts?.periodStart ?? null,
    $end: opts?.periodEnd ?? null,
    $slug: slug,
    $plan: opts?.subscription_plan ?? null,
  });
  const tenantId = Number(result.lastInsertRowid);

  // Create the setup wizard record for this tenant
  db.query(`
    INSERT INTO setup_wizard (tenant_id, status, current_step)
    VALUES ($tid, 'NOT_STARTED', 'company_info')
  `).run({ $tid: tenantId });

  // Link the user to the tenant
  db.query("UPDATE users SET tenant_id = $tid WHERE id = $uid").run({ $tid: tenantId, $uid: userId });

  return findTenantForUser(db, userId)!;
}

// Middleware: requires an authenticated user AND an existing tenant; sets c.tenant_id
export async function requireTenant(c: any, next: any) {
  const user = c.get("user") as { user_id: number } | undefined;
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = getDb();
  const tenant = findTenantForUser(db, user.user_id);
  if (!tenant) {
    return c.json({ error: "No tenant found for this user. Please contact support." }, 403);
  }
  // Paywall gate: only ACTIVE tenants may read/write data. PENDING (never
  // paid), TRIAL (legacy), PAST_DUE (unpaid renewal) and anything else are all
  // blocked with 402 — the SPA routes them to the paywall.
  if (tenant.subscription_status !== "ACTIVE") {
    return c.json({
      error: "subscription_required",
      message: "Complete payment to activate your account",
      checkout_url: "/checkout",
    }, 402);
  }
  c.set("tenant_id", tenant.id);
  return next();
}

// ── Role Middleware (Partner Program) ──────────────────────

// requireAdmin — must be authenticated + have role='admin'
export async function requireAdmin(c: any, next: any) {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb();
  const row = db.query("SELECT role FROM users WHERE id = ?").get(user.user_id) as { role: string } | null;
  if (!row || row.role !== 'admin') return c.json({ error: "Admin access required" }, 403);
  return next();
}

// requirePartner — must be authenticated + have role='partner', sets partner_id on context
export async function requirePartner(c: any, next: any) {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb();
  const row = db.query("SELECT p.id, p.status FROM partners p WHERE p.user_id = ?").get(user.user_id) as { id: number; status: string } | null;
  if (!row) return c.json({ error: "Partner account required" }, 403);
  if (row.status !== 'approved') return c.json({ error: "Partner account not yet approved" }, 403);
  c.set("partner_id", row.id);
  return next();
}
// ── Helper: Audit Log ─────────────────────────────────

export function logAudit(db: ReturnType<typeof getDb>, entityType: string, entityId: number, action: string, changes: Record<string, unknown> | null = null) {
  db.query(`
    INSERT INTO audit_logs (entity_type, entity_id, action, changes, performed_by)
    VALUES ($entity_type, $entity_id, $action, $changes, 'admin')
  `).run({
    $entity_type: entityType,
    $entity_id: entityId,
    $action: action,
    $changes: changes ? JSON.stringify(changes) : null,
  });
}
