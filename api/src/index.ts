import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb } from "./db";
import { extractDocumentInfo } from "./extract";
import {
  calculateVendorCompliance,
  calculateClientCompliance,
  calculateAllCompliance,
  calculatePaymentWeek,
} from "./compliance";
import { gatherReportData, generatePdfReport, generateExcelReport } from "./reports";
import { generateAuditPackage } from "./audit";
import {
  sendEmail,
  buildWeeklyReportEmail,
  buildRenewalReminderEmail,
  buildPasswordResetEmail,
  parseRecipients,
  hasReminderBeenSent,
  markReminderSent,
} from "./email";
import { startScheduler } from "./scheduler";
import { mapCOIToEntities } from "./mapping";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { QUEUE_SECRET } from "./secrets";

const app = new Hono();

// Global JSON error handler — ensures all errors return JSON, not plaintext
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: err.message || "Internal server error" }, 500);
});

// Global 404 handler — returns JSON instead of Hono's plaintext default
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

app.use("/*", cors());

// All tenant-owned data endpoints require both authentication and a tenant.
// Keeping this as a path middleware prevents a newly-added data route from
// accidentally becoming a cross-tenant data leak.
const TENANT_DATA_PATHS = [
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
function isQueueRoute(c: any): boolean {
  const path = c.req.path;
  return path === "/api/emails/process-queue" || path === "/api/emails/mark-sent" || path === "/api/emails/mark-failed";
}
function requireQueueSecret(c: any): Response | null {
  if (c.req.header("X-Queue-Secret") !== QUEUE_SECRET) {
    return c.json({ error: "Invalid queue secret" }, 401);
  }
  return null;
}

// (registered after middleware definitions below)

// ── Auth Token Helpers ──────────────────────────────────

const TOKEN_SECRET = process.env.TOKEN_SECRET || "cleartopay-secret-" + crypto.randomUUID();
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function createAuthToken(payload: Record<string, unknown>): Promise<string> {
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

async function verifyAuthToken(token: string): Promise<{ user_id: number; email: string; full_name: string } | null> {
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
async function requireAuth(c: any, next: any) {
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

interface TenantRow {
  id: number;
  name: string;
  owner_user_id: number;
  subscription_status: string;
  subscription_period_start: string | null;
  subscription_period_end: string | null;
  payment_week_start_day: string;
  admin_email: string | null;
  created_at: string;
  updated_at: string;
}

interface WizardRow {
  id: number;
  tenant_id: number;
  status: string;
  current_step: string;
  company_name: string | null;
  company_address: string | null;
  payment_week_start_day: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function findTenantForUser(db: ReturnType<typeof getDb>, userId: number): TenantRow | undefined {
  return db.query(
    "SELECT * FROM tenants WHERE owner_user_id = $uid ORDER BY id LIMIT 1"
  ).get({ $uid: userId }) as TenantRow | undefined;
}

function findWizard(db: ReturnType<typeof getDb>, tenantId: number): WizardRow | undefined {
  return db.query(
    "SELECT * FROM setup_wizard WHERE tenant_id = $tid"
  ).get({ $tid: tenantId }) as WizardRow | undefined;
}

function createTenantForUser(
  db: ReturnType<typeof getDb>,
  userId: number,
  opts?: { name?: string; subscription_status?: string; periodStart?: string; periodEnd?: string }
): TenantRow {
  const name = opts?.name || "My Company";
  const status = opts?.subscription_status || "TRIAL";
  const result = db.query(`
    INSERT INTO tenants (name, owner_user_id, subscription_status, subscription_period_start, subscription_period_end)
    VALUES ($name, $uid, $status, $start, $end)
  `).run({
    $name: name,
    $uid: userId,
    $status: status,
    $start: opts?.periodStart ?? null,
    $end: opts?.periodEnd ?? null,
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
async function requireTenant(c: any, next: any) {
  const user = c.get("user") as { user_id: number } | undefined;
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = getDb();
  const tenant = findTenantForUser(db, user.user_id);
  if (!tenant) {
    return c.json({ error: "No tenant found for this user. Please contact support." }, 403);
  }
  c.set("tenant_id", tenant.id);
  return next();
}

// Register tenant guard only after both middleware functions are initialized.
// Queue worker routes use their shared secret instead of tenant JWT auth.
for (const pattern of TENANT_DATA_PATHS) {
  app.use(pattern, async (c, next) => {
    if (isQueueRoute(c)) return next();
    return requireAuth(c, () => requireTenant(c, next));
  });
}

// ── Support Messages ─────────────────────────────────────
app.post("/api/support/ask", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "Message is required" }, 400);
  const db = getDb();
  const result = db.query(`INSERT INTO support_messages (tenant_id, user_id, message, context) VALUES ($tid, $uid, $message, $context)`).run({ $tid: c.get("tenant_id"), $uid: c.get("user").user_id, $message: message, $context: typeof body.context === "string" ? body.context.slice(0, 120) : null });
  const row = db.query("SELECT id, message, status, created_at FROM support_messages WHERE id = $id").get({ $id: Number(result.lastInsertRowid) });
  return c.json(row, 201);
});

app.get("/api/support/messages", (c) => {
  const rows = getDb().query("SELECT id, message, context, status, created_at, reply_text, replied_at, replied_by FROM support_messages WHERE tenant_id = $tid ORDER BY created_at DESC, id DESC").all({ $tid: c.get("tenant_id") });
  return c.json(rows);
});

app.post("/api/support/reply", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = Number(body.message_id);
  const reply = typeof body.reply_text === "string" ? body.reply_text.trim() : "";
  const by = typeof body.replied_by === "string" ? body.replied_by.trim() : "";
  if (!Number.isInteger(id) || !reply || !by) return c.json({ error: "message_id, reply_text, and replied_by are required" }, 400);
  const db = getDb();
  const result = db.query("UPDATE support_messages SET reply_text = $reply, status = 'closed', replied_at = datetime('now'), replied_by = $by WHERE id = $id AND tenant_id = $tid").run({ $reply: reply, $by: by, $id: id, $tid: c.get("tenant_id") });
  if (!result.changes) return c.json({ error: "Message not found" }, 404);
  return c.json({ success: true });
});

// ── Stripe Webhook ──────────────────────────────────────

// Manual Stripe webhook signature verification (HMAC-SHA256), so we don't need
// the `stripe` npm package. Stripe sends: t=<timestamp>,v1=<signature>.
function verifyStripeSignature(rawBody: string, sigHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret) {
    console.warn("[stripe] STRIPE_WEBHOOK_SECRET not set — skipping signature verification (dev mode)");
    return true;
  }
  if (!sigHeader) return false;
  const parts = sigHeader.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest();

  return signatures.some((sig) => {
    let actual: Buffer;
    try {
      actual = Buffer.from(sig, "hex");
    } catch {
      return false;
    }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

// Provision a tenant from a completed Stripe checkout:
// find-or-create user by email → find-or-create tenant → activate subscription → setup wizard
function provisionTenantFromCheckout(email: string, session: any) {
  const db = getDb();
  const normEmail = email.trim().toLowerCase();
  const customerName = typeof session?.customer_details?.name === "string" && session.customer_details.name.trim()
    ? session.customer_details.name.trim()
    : "New User";

  let user = db.query(
    "SELECT id, full_name, company_name, email FROM users WHERE email = $email"
  ).get({ $email: normEmail }) as { id: number; full_name: string; company_name: string; email: string } | undefined;

  if (!user) {
    // No password set yet — user must be onboarded (invite/password reset flow comes later).
    const placeholderHash = "webhook_placeholder";
    const result = db.query(`
      INSERT INTO users (full_name, company_name, email, password_hash)
      VALUES ($full_name, $company_name, $email, $password_hash)
    `).run({
      $full_name: customerName,
      $company_name: "My Company",
      $email: normEmail,
      $password_hash: placeholderHash,
    });
    const userId = Number(result.lastInsertRowid);
    logAudit(db, "user", userId, "user_created", { email: normEmail, source: "stripe_webhook", full_name: customerName });
    user = { id: userId, full_name: customerName, company_name: "My Company", email: normEmail };
  }

  const periodStart = new Date().toISOString().slice(0, 10);
  const periodEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let tenant = findTenantForUser(db, user.id);
  if (!tenant) {
    tenant = createTenantForUser(db, user.id, {
      name: user.company_name || "My Company",
      subscription_status: "ACTIVE",
      periodStart,
      periodEnd,
    });
    logAudit(db, "tenant", tenant.id, "tenant_created", { name: tenant.name, owner_user_id: user.id, source: "stripe_webhook" });
    logAudit(db, "tenant", tenant.id, "subscription_activated", { email: normEmail, period_start: periodStart, period_end: periodEnd });
  } else {
    db.query(`
      UPDATE tenants
      SET subscription_status = 'ACTIVE',
          subscription_period_start = $start,
          subscription_period_end = $end,
          admin_email = $email,
          updated_at = datetime('now')
      WHERE id = $id
    `).run({ $start: periodStart, $end: periodEnd, $email: normEmail, $id: tenant.id });
    logAudit(db, "tenant", tenant.id, "subscription_activated", { email: normEmail, period_start: periodStart, period_end: periodEnd });
    tenant = findTenantForUser(db, user.id)!;
  }

  const wizard = findWizard(db, tenant.id);
  return {
    user_id: user.id,
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    subscription_status: tenant.subscription_status,
    wizard_status: wizard?.status || "NOT_STARTED",
  };
}

// ── Auth Routes ─────────────────────────────────────────

app.post("/api/auth/register", async (c) => {
  try {
    const body = await c.req.json();
    const { full_name, company_name, email, password } = body;

    if (!full_name || typeof full_name !== "string" || full_name.trim().length === 0) {
      return c.json({ error: "Full name is required" }, 400);
    }
    if (!company_name || typeof company_name !== "string" || company_name.trim().length === 0) {
      return c.json({ error: "Company name is required" }, 400);
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return c.json({ error: "Valid email is required" }, 400);
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    const db = getDb();

    // Check if user already exists
    const existing = db.query("SELECT id FROM users WHERE email = $email").get({
      $email: email.trim().toLowerCase(),
    });
    if (existing) {
      return c.json({ error: "A user with this email already exists" }, 409);
    }

    const passwordHash = await Bun.password.hash(password);

    const result = db.query(`
      INSERT INTO users (full_name, company_name, email, password_hash)
      VALUES ($full_name, $company_name, $email, $password_hash)
    `).run({
      $full_name: full_name.trim(),
      $company_name: company_name.trim(),
      $email: email.trim().toLowerCase(),
      $password_hash: passwordHash,
    });

    const userId = Number(result.lastInsertRowid);
    const token = await createAuthToken({
      user_id: userId,
      email: email.trim().toLowerCase(),
      full_name: full_name.trim(),
    });

    // Auto-create tenant + setup wizard for the new user
    const tenant = createTenantForUser(db, userId, {
      name: company_name.trim(),
      subscription_status: "TRIAL",
    });
    logAudit(db, "tenant", tenant.id, "tenant_created", {
      name: tenant.name,
      owner_user_id: userId,
      source: "register",
    });
    const wizard = findWizard(db, tenant.id);

    return c.json({
      token,
      user: {
        id: userId,
        full_name: full_name.trim(),
        company_name: company_name.trim(),
        email: email.trim().toLowerCase(),
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        payment_week_start_day: tenant.payment_week_start_day,
        wizard_status: wizard?.status || "NOT_STARTED",
      },
    }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/login", async (c) => {
  try {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    const db = getDb();
    const user = db.query(
      "SELECT id, full_name, company_name, email, password_hash FROM users WHERE email = $email"
    ).get({
      $email: email.trim().toLowerCase(),
    }) as { id: number; full_name: string; company_name: string; email: string; password_hash: string } | undefined;

    if (!user) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    const valid = await Bun.password.verify(password, user.password_hash).catch(() => false);
    if (!valid) {
      if (user.password_hash === "webhook_placeholder") {
        return c.json({ error: "Account needs password setup", needs_password: true, email: user.email }, 401);
      }
      return c.json({ error: "Invalid email or password" }, 401);
    }

    const token = await createAuthToken({
      user_id: user.id,
      email: user.email,
      full_name: user.full_name,
    });

    const tenant = findTenantForUser(db, user.id);
    const wizard = tenant ? findWizard(db, tenant.id) : undefined;

    return c.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        company_name: user.company_name,
        email: user.email,
      },
      tenant: tenant ? {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        payment_week_start_day: tenant.payment_week_start_day,
        wizard_status: wizard?.status || "NOT_STARTED",
      } : null,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/set-password", async (c) => {
  try {
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    if (!email || !email.includes("@") || newPassword.length < 6) {
      return c.json({ error: "Valid email and a password of at least 6 characters are required" }, 400);
    }
    const db = getDb();
    const user = db.query("SELECT id FROM users WHERE email = $email").get({ $email: email }) as { id: number } | undefined;
    if (!user) return c.json({ error: "User not found" }, 404);
    const passwordHash = await Bun.password.hash(newPassword);
    db.query("UPDATE users SET password_hash = $password_hash WHERE id = $id").run({ $password_hash: passwordHash, $id: user.id });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/send-setup-link", async (c) => {
  try {
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return c.json({ error: "Email is required" }, 400);
    const db = getDb();
    const user = db.query("SELECT password_hash FROM users WHERE email = $email").get({ $email: email }) as { password_hash: string } | undefined;
    if (!user) return c.json({ needs_password: false });
    return c.json({ needs_password: user.password_hash === "webhook_placeholder" });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/forgot-password", async (c) => {
  try {
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return c.json({ error: "Email is required" }, 400);
    const db = getDb();
    const user = db.query("SELECT id, full_name FROM users WHERE email = $email").get({ $email: email }) as { id: number; full_name: string } | undefined;

    if (user) {
      // Generate a reset token: base64url random bytes, valid for 1 hour.
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const token = Buffer.from(bytes).toString("base64url");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.query("UPDATE users SET reset_token = $token, reset_token_expires = $expires WHERE id = $id").run({
        $token: token,
        $expires: expiresAt,
        $id: user.id,
      });
      const resetLink = `https://cleartopay.ctonew.app/app/reset-password?token=${encodeURIComponent(token)}`;
      sendEmail([email], "Reset your ClearToPay password", buildPasswordResetEmail(user.full_name, resetLink), undefined, undefined, "password_reset");
    }

    // Always return success — never reveal whether the email exists.
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
app.post("/api/auth/reset-password", async (c) => {
  try {
    const body = await c.req.json();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    if (!token || newPassword.length < 6) {
      return c.json({ error: "A valid token and a password of at least 6 characters are required" }, 400);
    }
    const db = getDb();
    const user = db.query(
      "SELECT id FROM users WHERE reset_token = $token AND reset_token_expires > $now"
    ).get({ $token: token, $now: new Date().toISOString() }) as { id: number } | undefined;
    if (!user) {
      return c.json({ error: "Invalid or expired reset link" }, 400);
    }
    const passwordHash = await Bun.password.hash(newPassword);
    db.query("UPDATE users SET password_hash = $password_hash, reset_token = NULL, reset_token_expires = NULL WHERE id = $id").run({
      $password_hash: passwordHash,
      $id: user.id,
    });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
app.post("/api/auth/logout", (c) => {
  // JWT is stateless — just return success
  return c.json({ success: true });
});

app.get("/api/auth/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = authHeader.slice(7);
  const user = await verifyAuthToken(token);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = getDb();
  const dbUser = db.query(
    "SELECT id, full_name, company_name, email, created_at FROM users WHERE id = $id"
  ).get({ $id: user.user_id }) as { id: number; full_name: string; company_name: string; email: string; created_at: string } | undefined;

  if (!dbUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const tenant = findTenantForUser(db, user.user_id);
  const wizard = tenant ? findWizard(db, tenant.id) : undefined;

  return c.json({
    id: dbUser.id,
    full_name: dbUser.full_name,
    company_name: dbUser.company_name,
    email: dbUser.email,
    created_at: dbUser.created_at,
    tenant_id: tenant?.id ?? null,
    tenant_name: tenant?.name ?? null,
    subscription_status: tenant?.subscription_status ?? null,
    payment_week_start_day: tenant?.payment_week_start_day ?? "monday",
    wizard_status: wizard?.status ?? null,
  });
});

// ── Stripe Webhook ──────────────────────────────────────

// POST /api/webhooks/stripe — receives Stripe events (raw body required for signature verification)
app.post("/api/webhooks/stripe", async (c) => {
  try {
    const rawBody = await c.req.text();
    const sigHeader = c.req.header("stripe-signature");
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
      console.warn("[stripe] Webhook signature verification failed");
      return c.json({ error: "Invalid signature" }, 400);
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (event?.type === "checkout.session.completed") {
      const session = event.data?.object ?? {};
      const email = session.customer_details?.email;
      if (!email || typeof email !== "string") {
        console.warn("[stripe] checkout.session.completed without customer_details.email");
        return c.json({ error: "Missing customer_details.email in checkout session" }, 400);
      }
      const result = provisionTenantFromCheckout(email, session);
      return c.json({ success: true, event_type: event.type, ...result });
    }

    // Acknowledge all other event types
    return c.json({ received: true, event_type: event?.type ?? "unknown" });
  } catch (err) {
    console.error("[stripe] Webhook error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// ── Setup Wizard ────────────────────────────────────────

const PAYMENT_WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// GET /api/setup — current setup wizard state for the authenticated user's tenant
app.get("/api/setup", requireAuth, requireTenant, (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const tenant = db.query("SELECT * FROM tenants WHERE id = $id").get({ $id: tenantId }) as TenantRow;
    const wizard = findWizard(db, tenantId);

    return c.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        payment_week_start_day: tenant.payment_week_start_day,
      },
      wizard: wizard
        ? {
            status: wizard.status,
            current_step: wizard.current_step,
            company_name: wizard.company_name,
            company_address: wizard.company_address,
            payment_week_start_day: wizard.payment_week_start_day,
            completed_at: wizard.completed_at,
          }
        : null,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/setup — saves setup wizard data; completes the wizard when all required fields are filled
app.post("/api/setup", requireAuth, requireTenant, async (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const body = await c.req.json();

    const company_name = typeof body.company_name === "string" ? body.company_name.trim() : "";
    const company_address = typeof body.company_address === "string" ? body.company_address.trim() : "";
    let payment_week_start_day = typeof body.payment_week_start_day === "string"
      ? body.payment_week_start_day.trim().toLowerCase()
      : "monday";
    if (!PAYMENT_WEEK_DAYS.includes(payment_week_start_day)) {
      return c.json({ error: `payment_week_start_day must be one of: ${PAYMENT_WEEK_DAYS.join(", ")}` }, 400);
    }

    let wizard = findWizard(db, tenantId);
    if (!wizard) {
      db.query("INSERT INTO setup_wizard (tenant_id) VALUES ($tid)").run({ $tid: tenantId });
      wizard = findWizard(db, tenantId)!;
    }

    // Save wizard data (only overwrite non-empty values)
    db.query(`
      UPDATE setup_wizard
      SET company_name = COALESCE($company_name, company_name),
          company_address = COALESCE($company_address, company_address),
          payment_week_start_day = $day,
          current_step = 'confirmation',
          updated_at = datetime('now')
      WHERE tenant_id = $tid
    `).run({
      $company_name: company_name || null,
      $company_address: company_address || null,
      $day: payment_week_start_day,
      $tid: tenantId,
    });

    // Update tenant name to company_name (if provided) + payment week start day
    if (company_name) {
      db.query(`
        UPDATE tenants SET name = $name, payment_week_start_day = $day, updated_at = datetime('now')
        WHERE id = $id
      `).run({ $name: company_name, $day: payment_week_start_day, $id: tenantId });
    } else {
      db.query(`
        UPDATE tenants SET payment_week_start_day = $day, updated_at = datetime('now')
        WHERE id = $id
      `).run({ $day: payment_week_start_day, $id: tenantId });
    }

    wizard = findWizard(db, tenantId)!;
    const allFilled = !!(wizard.company_name && wizard.company_address && wizard.payment_week_start_day);

    if (allFilled) {
      db.query(`
        UPDATE setup_wizard
        SET status = 'COMPLETED', current_step = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE tenant_id = $tid
      `).run({ $tid: tenantId });
      logAudit(db, "tenant", tenantId, "setup_completed", {
        company_name: wizard.company_name,
        company_address: wizard.company_address,
        payment_week_start_day: wizard.payment_week_start_day,
      });
    } else {
      db.query(`
        UPDATE setup_wizard SET status = 'IN_PROGRESS', updated_at = datetime('now')
        WHERE tenant_id = $tid
      `).run({ $tid: tenantId });
    }

    wizard = findWizard(db, tenantId)!;
    const tenant = db.query("SELECT * FROM tenants WHERE id = $id").get({ $id: tenantId }) as TenantRow;

    return c.json({
      success: true,
      completed: allFilled,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        payment_week_start_day: tenant.payment_week_start_day,
      },
      wizard: {
        status: wizard.status,
        current_step: wizard.current_step,
        company_name: wizard.company_name,
        company_address: wizard.company_address,
        payment_week_start_day: wizard.payment_week_start_day,
        completed_at: wizard.completed_at,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Health ──────────────────────────────────────────────

app.get("/api/health", (c) => {
  try {
    const db = getDb();
    // Verify DB is alive with a simple query
    db.query("SELECT 1").get();
    return c.json({ status: "ok", db: "connected" });
  } catch (err) {
    return c.json({ status: "error", db: "disconnected", error: String(err) }, 500);
  }
});

// ── Dashboard Stats ───────────────────────────────────

app.get("/api/dashboard/stats", (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;

    const totalClients = (db.query("SELECT COUNT(*) as count FROM clients WHERE tenant_id = $tenant_id").get({ $tenant_id: tenantId }) as { count: number }).count;
    const totalVendors = (db.query("SELECT COUNT(*) as count FROM vendors WHERE tenant_id = $tenant_id").get({ $tenant_id: tenantId }) as { count: number }).count;

    // Use compliance_status table for accurate payment status counts
    const vendorsApproved = (db.query(
      "SELECT COUNT(*) as count FROM compliance_status WHERE payment_status = 'approved' AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $tenant_id: tenantId }) as { count: number }).count;
    const vendorsReview = (db.query(
      "SELECT COUNT(*) as count FROM compliance_status WHERE payment_status = 'review' AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $tenant_id: tenantId }) as { count: number }).count;
    const vendorsHold = (db.query(
      "SELECT COUNT(*) as count FROM compliance_status WHERE payment_status = 'hold' AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $tenant_id: tenantId }) as { count: number }).count;

    // Vendors on hold = review + hold (anything not approved)
    const vendorsOnHold = vendorsReview + vendorsHold;

    // Documents expiring this week (Mon-Sun)
    const { sunday } = calculatePaymentWeek();
    const today = new Date().toISOString().slice(0, 10);
    const expiringThisWeek = (db.query(`
      SELECT COUNT(*) as count FROM document_extractions
      WHERE expiration_date IS NOT NULL
        AND expiration_date >= $today
        AND expiration_date <= $sunday
        AND is_reviewed = 1 AND document_id IN (SELECT id FROM documents WHERE tenant_id = $tenant_id)
    `).get({ $today: today, $sunday: sunday, $tenant_id: tenantId }) as { count: number }).count;

    // Needs review: items where is_reviewed = 0
    const needsReview = (db.query(`
      SELECT COUNT(*) as count
      FROM document_extractions de
      JOIN documents d ON de.document_id = d.id
      WHERE de.is_reviewed = 0 AND d.tenant_id = $tenant_id
    `).get({ $tenant_id: tenantId }) as { count: number }).count;

    return c.json({
      total_clients: totalClients,
      total_vendors: totalVendors,
      vendors_approved: vendorsApproved,
      vendors_review: vendorsReview,
      vendors_hold: vendorsHold,
      vendors_on_hold: vendorsOnHold,
      expiring_this_week: expiringThisWeek,
      needs_review: needsReview,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Clear-to-Pay Dashboard ─────────────────────────────

app.get("/api/dashboard/clear-to-pay", (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const rows = db.query(`
      SELECT v.id AS vendor_id, v.name AS vendor_name,
             cl.id AS client_id, cl.name AS client_name,
             cs.status, cs.payment_status
      FROM compliance_status cs
      JOIN vendors v ON v.id = cs.vendor_id
      JOIN clients cl ON cl.id = cs.client_id
      WHERE cs.payment_status IN ('approved', 'review', 'hold')
        AND v.tenant_id = $tenant_id AND cl.tenant_id = $tenant_id
      ORDER BY cs.payment_status, v.name COLLATE NOCASE
    `).all({ $tenant_id: tenantId }) as Array<{
      vendor_id: number; vendor_name: string; client_id: number; client_name: string;
      status: string; payment_status: string;
    }>;

    const vendors = rows.map((row) => {
      const required = db.query(
        "SELECT document_type FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
      ).all({ $client_id: row.client_id }) as Array<{ document_type: string }>;
      const present = db.query(`
        SELECT DISTINCT d.document_type
        FROM documents d
        WHERE d.vendor_id = $vendor_id AND d.tenant_id = $tenant_id
      `).all({ $vendor_id: row.vendor_id, $tenant_id: tenantId }) as Array<{ document_type: string }>;
      const presentTypes = new Set(present.map((doc) => doc.document_type));
      const missingDocuments = required.map((doc) => doc.document_type).filter((type) => !presentTypes.has(type));
      const expiring = db.query(`
        SELECT de.expiration_date, COALESCE(de.document_type, d.document_type) AS document_type
        FROM document_extractions de
        JOIN documents d ON d.id = de.document_id
        WHERE d.vendor_id = $vendor_id AND d.tenant_id = $tenant_id
          AND de.expiration_date IS NOT NULL
        ORDER BY de.expiration_date ASC LIMIT 1
      `).get({ $vendor_id: row.vendor_id, $tenant_id: tenantId }) as { expiration_date: string; document_type: string } | null;

      return {
        vendor_id: row.vendor_id,
        vendor_name: row.vendor_name,
        client_id: row.client_id,
        client_name: row.client_name,
        compliance_status: missingDocuments.length > 0 ? "missing" : row.status,
        payment_status: row.payment_status,
        missing_documents: missingDocuments,
        earliest_expiring_date: expiring?.expiration_date ?? null,
        earliest_expiring_type: expiring?.document_type ?? null,
      };
    });

    return c.json({ vendors });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Helper: Audit Log ─────────────────────────────────

function logAudit(db: ReturnType<typeof getDb>, entityType: string, entityId: number, action: string, changes: Record<string, unknown> | null = null) {
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

// ── CSV Imports ────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(field.trim()); field = ""; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows;
}

async function importCsv(c: any, kind: "clients" | "vendors") {
  const form = await c.req.parseBody();
  const uploaded = form.file;
  if (!(uploaded instanceof File)) return c.json({ error: "CSV file is required" }, 400);
  const rows = parseCsv(await uploaded.text());
  if (rows.length < 1) return c.json({ imported: 0, errors: [{ row: 1, error: "CSV is empty" }] });
  const expected = kind === "clients"
    ? ["name", "contact_email", "contact_phone", "address"]
    : ["name", "contact_name", "contact_email", "contact_phone"];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const indexes = expected.map((h) => headers.indexOf(h));
  if (indexes[0] < 0) return c.json({ imported: 0, errors: [{ row: 1, error: "Missing name column" }] }, 400);
  const errors: Array<{ row: number; error: string }> = [];
  const valid: string[][] = [];
  for (let n = 1; n < rows.length; n++) {
    const values = expected.map((_, i) => indexes[i] >= 0 ? (rows[n][indexes[i]] || "").trim() : "");
    if (!values[0]) errors.push({ row: n + 1, error: "Missing name" });
    else valid.push(values);
  }
  const db = getDb();
  const tenantId = c.get("tenant_id") as number;
  let imported = 0;
  try {
    const transaction = db.transaction(() => {
      if (kind === "vendors") {
        const clientId = Number(form.client_id);
        if (!clientId || !db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: tenantId })) throw new Error("Client not found");
        const insert = db.query("INSERT INTO vendors (tenant_id, client_id, name, contact_name, contact_email, contact_phone) VALUES ($tenant_id, $client_id, $name, $contact_name, $contact_email, $contact_phone)");
        const status = db.query("INSERT INTO compliance_status (vendor_id, client_id, status, payment_status) VALUES ($vendor_id, $client_id, 'needs_review', 'hold')");
        for (const v of valid) {
          const result = insert.run({ $tenant_id: tenantId, $client_id: clientId, $name: v[0], $contact_name: v[1] || null, $contact_email: v[2] || null, $contact_phone: v[3] || null });
          status.run({ $vendor_id: Number(result.lastInsertRowid), $client_id: clientId }); imported++;
        }
      } else {
        const insert = db.query("INSERT INTO clients (tenant_id, name, contact_email, contact_phone, address) VALUES ($tenant_id, $name, $contact_email, $contact_phone, $address)");
        for (const v of valid) { insert.run({ $tenant_id: tenantId, $name: v[0], $contact_email: v[1] || null, $contact_phone: v[2] || null, $address: v[3] || null }); imported++; }
      }
    });
    transaction();
  } catch (err) { return c.json({ imported: 0, errors: [{ row: 1, error: err instanceof Error ? err.message : "Import failed" }] }, 400); }
  return c.json({ imported, errors });
}

for (const kind of ["clients", "vendors"] as const) {
  app.get(`/api/import/${kind}-template`, (c) => {
    const headers = kind === "clients" ? "name,contact_email,contact_phone,address" : "name,contact_name,contact_email,contact_phone";
    return new Response(headers + "\\n", { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=${kind}-template.csv` } });
  });
  app.post(`/api/import/${kind}`, (c) => importCsv(c, kind));
}

// ── Clients ────────────────────────────────────────────

// GET /api/clients — list all clients with their required document types
app.get("/api/clients", (c) => {
  try {
    const db = getDb();

    const clients = db.query(`
      SELECT c.id, c.name, c.contact_email, c.contact_phone, c.address, c.created_at, c.updated_at
      FROM clients c
      WHERE c.tenant_id = $tenant_id
      ORDER BY c.name ASC
    `).all({ $tenant_id: c.get("tenant_id") as number }) as Array<{
      id: number; name: string; contact_email: string | null;
      contact_phone: string | null; address: string | null;
      created_at: string; updated_at: string;
    }>;

    // Fetch required document types for each client
    const result = clients.map((client) => {
      const docs = db.query(
        "SELECT document_type FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
      ).all({ $client_id: client.id }) as Array<{ document_type: string }>;
      return {
        ...client,
        required_documents: docs.map((d) => d.document_type),
      };
    });

    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/clients/:id — single client with their required document types
app.get("/api/clients/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const client = db.query(
      "SELECT id, name, contact_email, contact_phone, address, created_at, updated_at FROM clients WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as {
      id: number; name: string; contact_email: string | null;
      contact_phone: string | null; address: string | null;
      created_at: string; updated_at: string;
    } | undefined;

    if (!client) {
      return c.json({ error: "Client not found" }, 404);
    }

    const docs = db.query(
      "SELECT document_type FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: id }) as Array<{ document_type: string }>;

    return c.json({
      ...client,
      required_documents: docs.map((d) => d.document_type),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/clients — create a client
app.post("/api/clients", async (c) => {
  try {
    const db = getDb();
    const body = await c.req.json();
    const { name, contact_email, contact_phone, address } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "Name is required" }, 400);
    }

    const result = db.query(`
      INSERT INTO clients (tenant_id, name, contact_email, contact_phone, address)
      VALUES ($tenant_id, $name, $contact_email, $contact_phone, $address)
    `).run({
      $tenant_id: c.get("tenant_id") as number,
      $name: name.trim(),
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
      $address: address?.trim() || null,
    });

    const newId = Number(result.lastInsertRowid);

    logAudit(db, "client", newId, "created", { name: name.trim(), contact_email, contact_phone, address });

    const client = db.query("SELECT id, name, contact_email, contact_phone, address, created_at, updated_at FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: newId, $tenant_id: c.get("tenant_id") as number }) as any;

    return c.json({ ...client, required_documents: [] }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// PUT /api/clients/:id — update a client
app.put("/api/clients/:id", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const body = await c.req.json();
    const { name, contact_email, contact_phone, address } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "Name is required" }, 400);
    }

    db.query(`
      UPDATE clients
      SET name = $name, contact_email = $contact_email, contact_phone = $contact_phone, address = $address, updated_at = datetime('now')
      WHERE id = $id
    `).run({
      $id: id,
      $tenant_id: c.get("tenant_id") as number,
      $name: name.trim(),
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
      $address: address?.trim() || null,
    });

    logAudit(db, "client", id, "updated", { name: name.trim(), contact_email, contact_phone, address });

    const client = db.query("SELECT id, name, contact_email, contact_phone, address, created_at, updated_at FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as any;

    const docs = db.query(
      "SELECT document_type FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: id }) as Array<{ document_type: string }>;

    return c.json({ ...client, required_documents: docs.map((d) => d.document_type) });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /api/clients/:id — delete a client
app.delete("/api/clients/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string } | undefined;
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    logAudit(db, "client", id, "deleted", { name: existing.name });

    db.query("DELETE FROM clients WHERE id = $id AND tenant_id = $tenant_id").run({ $id: id, $tenant_id: c.get("tenant_id") as number });

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/clients/:id/documents-required — get required document types
app.get("/api/clients/:id/documents-required", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const docs = db.query(
      "SELECT id, client_id, document_type, created_at FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: id });

    return c.json(docs);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/clients/:id/documents-required — set required document types
app.post("/api/clients/:id/documents-required", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const body = await c.req.json();
    const { document_types } = body as { document_types: string[] };

    if (!Array.isArray(document_types)) {
      return c.json({ error: "document_types must be an array" }, 400);
    }

    // Remove existing entries
    db.query("DELETE FROM client_required_documents WHERE client_id = $client_id").run({ $client_id: id });

    // Insert new entries
    const insertStmt = db.query(
      "INSERT INTO client_required_documents (client_id, document_type) VALUES ($client_id, $document_type)"
    );

    for (const dt of document_types) {
      if (typeof dt === "string" && dt.trim().length > 0) {
        insertStmt.run({ $client_id: id, $document_type: dt.trim() });
      }
    }

    logAudit(db, "client", id, "set_required_documents", { document_types });

    const docs = db.query(
      "SELECT id, client_id, document_type, created_at FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
    ).all({ $client_id: id });

    return c.json(docs);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Vendors ────────────────────────────────────────────

// GET /api/vendors — list all vendors with client name, compliance/payment status
app.get("/api/vendors", (c) => {
  try {
    const db = getDb();
    const clientId = c.req.query("client_id");

    let sql = `
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        COALESCE(cs.status, 'needs_review') AS compliance_status,
        COALESCE(cs.payment_status, 'hold') AS payment_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
    `;

    const params: Record<string, unknown> = { $tenant_id: c.get("tenant_id") as number };
    sql += " WHERE v.tenant_id = $tenant_id";

    if (clientId) {
      sql += " AND v.client_id = $client_id";
      params.$client_id = Number(clientId);
    }

    sql += " ORDER BY v.name ASC";

    const vendors = db.query(sql).all(params);
    return c.json(vendors);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/vendors/:id — single vendor with client info, compliance, document summary
app.get("/api/vendors/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const vendor = db.query(`
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        COALESCE(cs.status, 'needs_review') AS compliance_status,
        COALESCE(cs.payment_status, 'hold') AS payment_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
      WHERE v.id = $id AND v.tenant_id = $tenant_id
    `).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as Record<string, unknown> | undefined;

    if (!vendor) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    // Document summary
    const docCount = (db.query(
      "SELECT COUNT(*) as count FROM documents WHERE vendor_id = $vendor_id AND tenant_id = $tenant_id"
    ).get({ $vendor_id: id, $tenant_id: c.get("tenant_id") as number }) as { count: number }).count;

    const latestExtraction = db.query(`
      SELECT MAX(de.extracted_at) AS latest_date
      FROM document_extractions de
      JOIN documents d ON de.document_id = d.id
      WHERE d.vendor_id = $vendor_id AND d.tenant_id = $tenant_id
    `).get({ $vendor_id: id, $tenant_id: c.get("tenant_id") as number }) as { latest_date: string | null };

    return c.json({
      ...vendor,
      document_count: docCount,
      latest_extraction_date: latestExtraction?.latest_date ?? null,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/vendors — create a vendor
app.post("/api/vendors", async (c) => {
  try {
    const db = getDb();
    const body = await c.req.json();
    const { client_id, name, contact_name, contact_email, contact_phone } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "Vendor name is required" }, 400);
    }

    if (!client_id || typeof client_id !== "number") {
      return c.json({ error: "client_id is required and must be a number" }, 400);
    }

    // Verify client exists
    const clientExists = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: client_id, $tenant_id: c.get("tenant_id") as number });
    if (!clientExists) {
      return c.json({ error: "Client not found" }, 404);
    }

    const result = db.query(`
      INSERT INTO vendors (tenant_id, client_id, name, contact_name, contact_email, contact_phone)
      VALUES ($tenant_id, $client_id, $name, $contact_name, $contact_email, $contact_phone)
    `).run({
      $tenant_id: c.get("tenant_id") as number,
      $client_id: client_id,
      $name: name.trim(),
      $contact_name: contact_name?.trim() || null,
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
    });

    const newId = Number(result.lastInsertRowid);

    // Create initial compliance status
    db.query(`
      INSERT INTO compliance_status (vendor_id, client_id, status, payment_status)
      VALUES ($vendor_id, $client_id, 'needs_review', 'hold')
    `).run({ $vendor_id: newId, $client_id: client_id });

    logAudit(db, "vendor", newId, "created", { client_id, name: name.trim(), contact_name, contact_email, contact_phone });

    // Return the new vendor with client name
    const vendor = db.query(`
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        'needs_review' AS compliance_status,
        'hold' AS payment_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      WHERE v.id = $id AND v.tenant_id = $tenant_id
    `).get({ $id: newId, $tenant_id: c.get("tenant_id") as number });

    return c.json(vendor, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// PUT /api/vendors/:id — update a vendor
app.put("/api/vendors/:id", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id FROM vendors WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    const body = await c.req.json();
    const { client_id, name, contact_name, contact_email, contact_phone } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "Vendor name is required" }, 400);
    }

    if (!client_id || typeof client_id !== "number") {
      return c.json({ error: "client_id is required and must be a number" }, 400);
    }

    // Verify client exists
    const clientExists = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: client_id, $tenant_id: c.get("tenant_id") as number });
    if (!clientExists) {
      return c.json({ error: "Client not found" }, 404);
    }

    db.query(`
      UPDATE vendors
      SET client_id = $client_id, name = $name, contact_name = $contact_name,
          contact_email = $contact_email, contact_phone = $contact_phone,
          updated_at = datetime('now')
      WHERE id = $id
    `).run({
      $id: id,
      $tenant_id: c.get("tenant_id") as number,
      $client_id: client_id,
      $name: name.trim(),
      $contact_name: contact_name?.trim() || null,
      $contact_email: contact_email?.trim() || null,
      $contact_phone: contact_phone?.trim() || null,
    });

    logAudit(db, "vendor", id, "updated", { client_id, name: name.trim(), contact_name, contact_email, contact_phone });

    // Return updated vendor
    const vendor = db.query(`
      SELECT v.id, v.client_id, c.name AS client_name,
        v.name, v.contact_name, v.contact_email, v.contact_phone,
        COALESCE(cs.status, 'needs_review') AS compliance_status,
        COALESCE(cs.payment_status, 'hold') AS payment_status,
        v.created_at, v.updated_at
      FROM vendors v
      JOIN clients c ON v.client_id = c.id
      LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
      WHERE v.id = $id
    `).get({ $id: id, $tenant_id: c.get("tenant_id") as number });

    return c.json(vendor);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /api/vendors/:id — delete a vendor (cascade deletes their documents, extractions, compliance)
app.delete("/api/vendors/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const existing = db.query("SELECT id, name FROM vendors WHERE id = $id AND tenant_id = $tenant_id").get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string } | undefined;
    if (!existing) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    logAudit(db, "vendor", id, "deleted", { name: existing.name });

    db.query("DELETE FROM vendors WHERE id = $id AND tenant_id = $tenant_id").run({ $id: id, $tenant_id: c.get("tenant_id") as number });

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Documents ──────────────────────────────────────────
const DOCS_DIR = path.join(import.meta.dir, "..", "data", "uploads");
const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

async function ingestDocumentAttachment(opts: {
  db: ReturnType<typeof getDb>;
  tenantId: number;
  filename: string;
  content: Uint8Array;
  contentType: string;
  senderName?: string | null;
  senderEmail?: string | null;
  clientId?: number | null;
  vendorId?: number | null;
}) {
  const { db, tenantId } = opts;
  if (!ALLOWED_TYPES.includes(opts.contentType)) throw new Error("Unsupported file type. Allowed: PDF, JPG, PNG");
  if (opts.content.length > MAX_UPLOAD_SIZE) throw new Error("File too large. Maximum size is 10MB");
  const originalFilename = path.basename(opts.filename).replace(/[\\/]/g, "_") || "attachment";
  const clientId = opts.clientId ?? null;
  const vendorId = opts.vendorId ?? null;
  if (clientId !== null && !db.query("SELECT id FROM clients WHERE id=$id AND tenant_id=$tid").get({$id:clientId,$tid:tenantId})) throw new Error("Client not found");
  if (vendorId !== null && !db.query("SELECT id FROM vendors WHERE id=$id AND tenant_id=$tid").get({$id:vendorId,$tid:tenantId})) throw new Error("Vendor not found");
  if (clientId !== null && vendorId !== null && !db.query("SELECT id FROM vendors WHERE id=$id AND client_id=$cid AND tenant_id=$tid").get({$id:vendorId,$cid:clientId,$tid:tenantId})) throw new Error("Vendor does not belong to client");
  const dir = path.join(DOCS_DIR, String(tenantId)); mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${originalFilename}`);
  await Bun.write(filePath, opts.content);
  const relPath = `data/uploads/${tenantId}/${path.basename(filePath)}`;
  const result = db.query(`INSERT INTO documents (vendor_id,client_id,document_type,file_path,original_filename,content_type,file_size,sender_name,sender_email,tenant_id) VALUES ($vid,$cid,'Other',$path,$name,$type,$size,$sender,$email,$tid)`).run({$vid:vendorId,$cid:clientId,$path:relPath,$name:originalFilename,$type:opts.contentType,$size:opts.content.length,$sender:opts.senderName || null,$email:opts.senderEmail || null,$tid:tenantId});
  const documentId = Number(result.lastInsertRowid);
  db.query("INSERT INTO ingestion_events (document_id,status) VALUES ($id,'uploaded')").run({$id:documentId});
  logAudit(db,"document",documentId,"uploaded",{filename:originalFilename,file_size:opts.content.length,content_type:opts.contentType,tenant_id:tenantId});
  db.query("UPDATE ingestion_events SET status='processing',updated_at=datetime('now') WHERE document_id=$id").run({$id:documentId});
  extractDocumentInfo(filePath, originalFilename).then((extraction) => {
    db.query(`INSERT OR REPLACE INTO document_extractions (document_id,vendor_name,insurance_carrier,policy_number,effective_date,expiration_date,certificate_holder,certificate_holder_address,certificate_holder_name_confidence,insured_address,w9_form_date,document_type,ai_confidence_score) VALUES ($id,$vendor,$carrier,$policy,$effective,$expiration,$holder,$holder_address,$holder_confidence,$insured_address,$w9_date,$type,$confidence)`).run({$id:documentId,$vendor:extraction.vendor_name,$carrier:extraction.insurance_carrier,$policy:extraction.policy_number,$effective:extraction.effective_date,$expiration:extraction.expiration_date,$holder:extraction.certificate_holder,$holder_address:extraction.certificate_holder_address,$holder_confidence:extraction.certificate_holder_name_confidence,$insured_address:extraction.insured_address,$w9_date:extraction.form_date,$type:extraction.document_type,$confidence:extraction.ai_confidence_score});
    db.query("UPDATE documents SET document_type=$type WHERE id=$id AND tenant_id=$tid").run({$type:extraction.document_type||"Other",$id:documentId,$tid:tenantId});
    if (extraction.document_type === "COI" && extraction.certificate_holder_name_confidence >= 0.8) { const mapped = mapCOIToEntities(db, tenantId, extraction, documentId); if (mapped) { db.query("UPDATE documents SET client_id=$cid, vendor_id=$vid WHERE id=$id AND tenant_id=$tid").run({$cid:mapped.clientId,$vid:mapped.vendorId,$id:documentId,$tid:tenantId}); calculateVendorCompliance(mapped.vendorId, mapped.clientId, tenantId); } }
    else if (vendorId !== null && clientId !== null) calculateVendorCompliance(vendorId,clientId,tenantId);
    db.query("UPDATE ingestion_events SET status='ready',updated_at=datetime('now') WHERE document_id=$id").run({$id:documentId});
  }).catch((err) => { db.query("UPDATE ingestion_events SET status='error',error_message=$error,updated_at=datetime('now') WHERE document_id=$id").run({$error:String(err),$id:documentId}); });
  return { id: documentId, original_filename: originalFilename, content_type: opts.contentType, file_size: opts.content.length };
}

// POST /api/documents/upload — persist immediately, extract asynchronously
app.post("/api/documents/upload", async (c) => {
  try {
    const form = await c.req.formData(); const file = form.get("file");
    if (!file || !(file instanceof File)) return c.json({ error: "File is required" }, 400);
    const clientRaw = form.get("client_id"); const vendorRaw = form.get("vendor_id");
    const clientId = clientRaw ? Number(clientRaw) : null; const vendorId = vendorRaw ? Number(vendorRaw) : null;
    if (clientRaw && !Number.isInteger(clientId)) return c.json({ error: "Invalid client_id" }, 400);
    if (vendorRaw && !Number.isInteger(vendorId)) return c.json({ error: "Invalid vendor_id" }, 400);
    const document = await ingestDocumentAttachment({db:getDb(),tenantId:c.get("tenant_id") as number,filename:file.name,content:new Uint8Array(await file.arrayBuffer()),contentType:file.type,senderName:form.get("sender_name")?.toString(),senderEmail:form.get("sender_email")?.toString(),clientId,vendorId});
    return c.json({document,ingestion_status:"processing"},201);
  } catch (err) { console.error("[upload]",err); return c.json({error:String(err)},500); }
});

// POST /api/inbox/ingest — receive attachments from an email-ingestion worker.
app.post("/api/inbox/ingest", async (c) => {
  try {
    const body = await c.req.json();
    if (!Array.isArray(body?.attachments) || body.attachments.length === 0) return c.json({error:"attachments must be a non-empty array"},400);
    const tenantId = c.get("tenant_id") as number, db = getDb();
    const clientId = body.client_id == null ? null : Number(body.client_id), vendorId = body.vendor_id == null ? null : Number(body.vendor_id);
    if (clientId !== null && !Number.isInteger(clientId) || vendorId !== null && !Number.isInteger(vendorId)) return c.json({error:"Invalid client_id or vendor_id"},400);
    const documents = [];
    for (const a of body.attachments) {
      if (!a || typeof a.filename !== "string" || typeof a.content_base64 !== "string" || typeof a.content_type !== "string") return c.json({error:"Each attachment requires filename, content_base64, and content_type"},400);
      let content: Uint8Array; try { content = Uint8Array.from(atob(a.content_base64.replace(/^data:[^;]+;base64,/, "")), ch => ch.charCodeAt(0)); } catch { return c.json({error:`Invalid base64 for ${a.filename}`},400); }
      documents.push(await ingestDocumentAttachment({db,tenantId,filename:a.filename,content,contentType:a.content_type,senderName:body.sender_name,senderEmail:body.sender_email,clientId,vendorId}));
    }
    return c.json({documents,ingested_count:documents.length},201);
  } catch (err) { console.error("[inbox/ingest]",err); return c.json({error:String(err)},400); }
});

// POST /api/inbox/relay — multipart receiver for future email webhook providers.
app.post("/api/inbox/relay", async (c) => {
  try {
    const form = await c.req.formData(), files = Array.from(form.values()).filter((v): v is File => v instanceof File && v.size > 0);
    if (!files.length) return c.json({error:"At least one attachment is required"},400);
    const clientRaw=form.get("client_id"), vendorRaw=form.get("vendor_id"), clientId=clientRaw?Number(clientRaw):null, vendorId=vendorRaw?Number(vendorRaw):null;
    const documents=[]; for (const file of files) documents.push(await ingestDocumentAttachment({db:getDb(),tenantId:c.get("tenant_id") as number,filename:file.name,content:new Uint8Array(await file.arrayBuffer()),contentType:file.type,senderName:form.get("sender_name")?.toString() || form.get("from_name")?.toString(),senderEmail:form.get("sender_email")?.toString() || form.get("from")?.toString(),clientId,vendorId}));
    return c.json({documents,ingested_count:documents.length},201);
  } catch (err) { console.error("[inbox/relay]",err); return c.json({error:String(err)},400); }
});
// GET /api/documents — list documents with filters
app.get("/api/documents", (c) => {
  try {
    const db = getDb();
    const clientId = c.req.query("client_id");
    const vendorId = c.req.query("vendor_id");
    const needsReview = c.req.query("needs_review");

    let sql = `
      SELECT
        d.id, d.vendor_id, d.client_id,
        v.name AS vendor_name,
        c.name AS client_name,
        d.document_type, d.file_path, d.original_filename,
        d.sender_name, d.sender_email,
        d.received_date, d.created_at, ie.status AS ingestion_status, d.content_type, d.file_size,
        de.ai_confidence_score,
        de.is_reviewed,
        de.insurance_carrier,
        de.policy_number,
        de.effective_date,
        de.expiration_date,
        de.certificate_holder,
        de.certificate_holder_address,
        de.certificate_holder_name_confidence,
        de.insured_address,
        de.w9_form_date,
        de.document_type AS extracted_document_type
      FROM documents d
      LEFT JOIN clients c ON d.client_id = c.id
      LEFT JOIN vendors v ON d.vendor_id = v.id
      LEFT JOIN document_extractions de ON de.document_id = d.id
      LEFT JOIN ingestion_events ie ON ie.document_id = d.id
      WHERE d.tenant_id = $tenant_id
    `;

    const params: Record<string, unknown> = { $tenant_id: c.get("tenant_id") as number };

    if (clientId) {
      sql += " AND d.client_id = $client_id";
      params.$client_id = Number(clientId);
    }

    if (vendorId) {
      sql += " AND d.vendor_id = $vendor_id";
      params.$vendor_id = Number(vendorId);
    }

    if (needsReview === "true") {
      sql += " AND de.is_reviewed = 0";
    }

    sql += " ORDER BY d.created_at DESC";

    const rows = db.query(sql).all(params) as any[];
    const result = rows.map((r) => ({
      ...r,
      is_reviewed: !!r.is_reviewed,
    }));

    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/documents/:id — single document with all extractions
app.get("/api/documents/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const doc = db.query(`
      SELECT
        d.id, d.vendor_id, d.client_id,
        v.name AS vendor_name,
        c.name AS client_name,
        d.document_type, d.file_path, d.original_filename,
        d.sender_name, d.sender_email,
        d.received_date, d.created_at, ie.status AS ingestion_status, d.content_type, d.file_size,
        de.ai_confidence_score,
        de.is_reviewed,
        de.insurance_carrier,
        de.policy_number,
        de.effective_date,
        de.expiration_date,
        de.certificate_holder,
        de.certificate_holder_address,
        de.certificate_holder_name_confidence,
        de.insured_address,
        de.w9_form_date,
        de.document_type AS extracted_document_type
      FROM documents d
      LEFT JOIN clients c ON d.client_id = c.id
      LEFT JOIN vendors v ON d.vendor_id = v.id
      LEFT JOIN document_extractions de ON de.document_id = d.id
      LEFT JOIN ingestion_events ie ON ie.document_id = d.id
      WHERE d.id = $id AND d.tenant_id = $tenant_id
    `).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as any | undefined;

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    // Get all extraction history
    const extractions = db.query(`
      SELECT id, document_id, vendor_name, insurance_carrier, policy_number,
             effective_date, expiration_date, certificate_holder, document_type,
             ai_confidence_score, certificate_holder_address, certificate_holder_name_confidence, insured_address, w9_form_date, is_reviewed, extracted_at
      FROM document_extractions
      WHERE document_id = $document_id
      ORDER BY extracted_at DESC
    `).all({ $document_id: id, $tenant_id: c.get("tenant_id") as number }) as any[];

    return c.json({
      ...doc,
      is_reviewed: !!doc.is_reviewed,
      extractions: extractions.map((e) => ({ ...e, is_reviewed: !!e.is_reviewed })),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/documents/:id/file — serve the document file
app.get("/api/documents/:id/file", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const doc = db.query(
      "SELECT file_path, original_filename FROM documents WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { file_path: string; original_filename: string } | undefined;

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    const fullPath = path.join(import.meta.dir, "..", doc.file_path);

    if (!existsSync(fullPath)) {
      return c.json({ error: "File not found on disk" }, 404);
    }

    const file = Bun.file(fullPath);
    return new Response(file, {
      headers: {
        "Content-Disposition": `inline; filename="${doc.original_filename}"`,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// PUT /api/documents/:id/extraction — manually update extraction
app.put("/api/documents/:id/extraction", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const tenantId = c.get("tenant_id");
    const existing = db.query(
      `SELECT de.id, de.document_id FROM document_extractions de
       JOIN documents d ON d.id = de.document_id
       WHERE de.document_id = $document_id AND d.tenant_id = $tenant_id
       ORDER BY de.extracted_at DESC LIMIT 1`
    ).get({ $document_id: id, $tenant_id: tenantId }) as { id: number; document_id: number } | undefined;

    if (!existing) {
      return c.json({ error: "No extraction found for this document" }, 404);
    }

    const body = await c.req.json();
    const {
      vendor_name,
      insurance_carrier,
      policy_number,
      effective_date,
      expiration_date,
      certificate_holder,
      document_type,
      is_reviewed,
    } = body;

    // Build dynamic update
    const updates: string[] = [];
    const params: Record<string, unknown> = { $extraction_id: existing.id, $document_id: id };

    if (vendor_name !== undefined) {
      updates.push("vendor_name = $vendor_name");
      params.$vendor_name = vendor_name?.trim() || null;
    }
    if (insurance_carrier !== undefined) {
      updates.push("insurance_carrier = $insurance_carrier");
      params.$insurance_carrier = insurance_carrier?.trim() || null;
    }
    if (policy_number !== undefined) {
      updates.push("policy_number = $policy_number");
      params.$policy_number = policy_number?.trim() || null;
    }
    if (effective_date !== undefined) {
      updates.push("effective_date = $effective_date");
      params.$effective_date = effective_date?.trim() || null;
    }
    if (expiration_date !== undefined) {
      updates.push("expiration_date = $expiration_date");
      params.$expiration_date = expiration_date?.trim() || null;
    }
    if (certificate_holder !== undefined) {
      updates.push("certificate_holder = $certificate_holder");
      params.$certificate_holder = certificate_holder?.trim() || null;
    }
    if (document_type !== undefined) {
      updates.push("document_type = $document_type");
      params.$document_type = document_type?.trim() || null;
    }
    if (is_reviewed !== undefined) {
      updates.push("is_reviewed = $is_reviewed");
      params.$is_reviewed = is_reviewed ? 1 : 0;
    }

    // Always update document_type on the parent document if it changed
    if (document_type !== undefined && document_type) {
      db.query("UPDATE documents SET document_type = $document_type WHERE id = $id AND tenant_id = $tenant_id")
        .run({ $document_type: document_type.trim(), $id: id, $tenant_id: tenantId });
    }

    if (updates.length > 0) {
      updates.push("extracted_at = datetime('now')");
      db.query(
        `UPDATE document_extractions SET ${updates.join(", ")} WHERE id = $extraction_id`
      ).run(params);
    }

    // Recalculate compliance status for the vendor using the engine
    const doc = db.query(
      "SELECT vendor_id, client_id FROM documents WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { vendor_id: number; client_id: number } | undefined;

    if (doc) {
      calculateVendorCompliance(doc.vendor_id, doc.client_id, c.get("tenant_id") as number);
    }

    logAudit(db, "document", id, "extraction_updated", { ...body, is_reviewed });

    // Return updated extraction
    const updated = db.query(
      "SELECT id, document_id, vendor_name, insurance_carrier, policy_number, effective_date, expiration_date, certificate_holder, document_type, ai_confidence_score, is_reviewed, extracted_at FROM document_extractions WHERE id = $id"
    ).get({ $id: existing.id }) as any;

    return c.json({ ...updated, is_reviewed: !!updated.is_reviewed });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/needs-review — documents needing review
app.get("/api/needs-review", (c) => {
  try {
    const db = getDb();

    const rows = db.query(`
      SELECT
        d.id, d.vendor_id, d.client_id,
        v.name AS vendor_name,
        c.name AS client_name,
        d.document_type, d.file_path, d.original_filename,
        d.sender_name, d.sender_email,
        d.received_date, d.created_at,
        de.ai_confidence_score,
        de.is_reviewed,
        de.insurance_carrier,
        de.policy_number,
        de.effective_date,
        de.expiration_date,
        de.certificate_holder,
        de.certificate_holder_address,
        de.certificate_holder_name_confidence,
        de.insured_address,
        de.w9_form_date,
        de.document_type AS extracted_document_type,
        de.id AS extraction_id,
        de.vendor_name AS extracted_vendor_name
      FROM documents d
      LEFT JOIN clients c ON d.client_id = c.id
      LEFT JOIN vendors v ON d.vendor_id = v.id
      JOIN document_extractions de ON de.document_id = d.id
      WHERE de.is_reviewed = 0 AND d.tenant_id = $tenant_id
      ORDER BY de.ai_confidence_score ASC, d.created_at DESC
    `).all({ $tenant_id: c.get("tenant_id") as number }) as any[];

    const result = rows.map((r) => ({
      ...r,
      is_reviewed: false,
    }));

    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Compliance Recalculation ───────────────────────────

// POST /api/compliance/recalculate — recalculate compliance for all, one client, or one vendor
app.post("/api/compliance/recalculate", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const clientId = body.client_id ? Number(body.client_id) : undefined;
    const vendorId = body.vendor_id ? Number(body.vendor_id) : undefined;
    const clientIdRaw = body.client_id ? Number(body.client_id) : undefined;

    let summary: { vendor_count: number; approved: number; review: number; hold: number };

    if (vendorId && clientIdRaw) {
      // Single vendor
      const result = calculateVendorCompliance(vendorId, clientIdRaw, c.get("tenant_id") as number);
      summary = {
        vendor_count: 1,
        approved: result.payment_status === "approved" ? 1 : 0,
        review: result.payment_status === "review" ? 1 : 0,
        hold: result.payment_status === "hold" ? 1 : 0,
      };
    } else if (clientId) {
      summary = calculateClientCompliance(clientId, c.get("tenant_id") as number);
    } else {
      summary = calculateAllCompliance(c.get("tenant_id") as number);
    }

    return c.json(summary);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/vendors/:id/compliance-detail — detailed per-doc-type compliance breakdown
app.get("/api/vendors/:id/compliance-detail", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const vendor = db.query(
      "SELECT id, client_id, name FROM vendors WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { id: number; client_id: number; name: string } | undefined;

    if (!vendor) {
      return c.json({ error: "Vendor not found" }, 404);
    }

    const client = db.query(
      "SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: vendor.client_id }) as { id: number; name: string } | undefined;

    // Recalculate fresh compliance for this vendor
    const result = calculateVendorCompliance(vendor.id, vendor.client_id, c.get("tenant_id") as number);

    return c.json({
      vendor_id: vendor.id,
      client_id: vendor.client_id,
      vendor_name: vendor.name,
      client_name: client?.name ?? "Unknown",
      status: result.status,
      payment_status: result.payment_status,
      details: result.details,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Reports ─────────────────────────────────────────────

// POST /api/reports/clear-to-pay — generate Clear-to-Pay report
app.post("/api/reports/clear-to-pay", async (c) => {
  try {
    const body = await c.req.json();
    const clientId = body.client_id ? Number(body.client_id) : undefined;
    const format = body.format || "both"; // "pdf" | "excel" | "csv" | "both"

    if (!clientId || isNaN(clientId)) {
      return c.json({ error: "Valid client_id is required" }, 400);
    }

    // Verify client exists
    const db = getDb();
    const client = db
      .query("SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id")
      .get({ $id: clientId, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string } | undefined;

    if (!client) {
      return c.json({ error: "Client not found" }, 404);
    }

    // Gather report data (recalculates compliance first)
    const reportData = gatherReportData(clientId);

    const timestamp = Date.now();
    const clientSlug = client.name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);
    const reportsDir = path.join(import.meta.dir, "..", "data", "reports");
    if (!existsSync(reportsDir)) {
      mkdirSync(reportsDir, { recursive: true });
    }

    if (format === "pdf") {
      const pdfFilename = `ClearToPay_${clientSlug}_${timestamp}.pdf`;
      const pdfPath = path.join(reportsDir, pdfFilename);

      const doc = generatePdfReport(reportData);
      const buffers: Buffer[] = [];
      for await (const chunk of doc) {
        buffers.push(Buffer.from(chunk));
      }
      const pdfBuffer = Buffer.concat(buffers);
      Bun.write(pdfPath, pdfBuffer);

      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${pdfFilename}"`,
        },
      });
    }

    if (format === "csv") {
      const csvFilename = `ClearToPay_${clientSlug}_${timestamp}.csv`;
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows: string[] = ["Section,Vendor,Contact,Status,Reason,Document,Expiration,Missing Documents"];
      const addVendor = (section: string, v: any) => rows.push([section, v.vendor_name, v.contact_email || v.contact_name || "", v.payment_status, v.reason || "", "", "", ""].map(esc).join(","));
      reportData.approved.forEach(v => addVendor("Approved", v));
      reportData.review.forEach(v => addVendor("Review", v));
      reportData.hold.forEach(v => addVendor("Hold", v));
      reportData.expiring_during_week.forEach(e => rows.push(["Expiring", e.vendor_name, "", "", "", e.document_type, e.expiration_date, ""].map(esc).join(",")));
      reportData.missing_docs.forEach(m => rows.push(["Missing", m.vendor_name, "", "", "", "", "", m.missing_types.join("; ")].map(esc).join(",")));
      const csv = Buffer.from(rows.join("\r\n") + "\r\n", "utf8");
      Bun.write(path.join(reportsDir, csvFilename), csv);
      return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${csvFilename}"` } });
    }

    if (format === "excel") {
      const xlsxFilename = `ClearToPay_${clientSlug}_${timestamp}.xlsx`;
      const xlsxPath = path.join(reportsDir, xlsxFilename);

      const xlsxBuffer = await generateExcelReport(reportData);
      Bun.write(xlsxPath, xlsxBuffer);

      return new Response(xlsxBuffer, {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${xlsxFilename}"`,
        },
      });
    }

    // "both" — generate both, but we can only return one. Return a summary JSON
    // with download URLs for both files.
    const pdfFilename = `ClearToPay_${clientSlug}_${timestamp}.pdf`;
    const pdfPath = path.join(reportsDir, pdfFilename);

    const doc = generatePdfReport(reportData);
    const pdfBuffers: Buffer[] = [];
    for await (const chunk of doc) {
      pdfBuffers.push(Buffer.from(chunk));
    }
    Bun.write(pdfPath, Buffer.concat(pdfBuffers));

    const xlsxFilename = `ClearToPay_${clientSlug}_${timestamp}.xlsx`;
    const xlsxPath = path.join(reportsDir, xlsxFilename);
    const xlsxBuffer = await generateExcelReport(reportData);
    Bun.write(xlsxPath, xlsxBuffer);

    // Return summary with download URLs
    return c.json({
      pdf_url: `/api/reports/download/${encodeURIComponent(pdfFilename)}`,
      excel_url: `/api/reports/download/${encodeURIComponent(xlsxFilename)}`,
      summary: {
        client_name: reportData.client_name,
        report_date: reportData.report_date,
        payment_week: reportData.payment_week,
        approved_count: reportData.approved.length,
        review_count: reportData.review.length,
        hold_count: reportData.hold.length,
        expiring_count: reportData.expiring_during_week.length,
        missing_count: reportData.missing_docs.length,
      },
    });
  } catch (err) {
    console.error("[reports] Error generating report:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/reports/download/:filename — download a generated report file
app.get("/api/reports/download/:filename", (c) => {
  try {
    const filename = decodeURIComponent(c.req.param("filename"));
    const reportsDir = path.join(import.meta.dir, "..", "data", "reports");
    const filePath = path.join(reportsDir, filename);

    // Security: prevent directory traversal
    if (!filePath.startsWith(reportsDir)) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    if (!existsSync(filePath)) {
      return c.json({ error: "Report file not found" }, 404);
    }

    const ext = path.extname(filename).toLowerCase();
    let contentType = "application/octet-stream";
    if (ext === ".pdf") contentType = "application/pdf";
    else if (ext === ".xlsx")
      contentType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Audit Package ──────────────────────────────────────

// POST /api/audit/generate — generate an audit ZIP package
app.post("/api/audit/generate", async (c) => {
  try {
    const body = await c.req.json();
    const { client_id, vendor_id, document_type, date_from, date_to } = body;

    if (!client_id || typeof client_id !== "number" || isNaN(client_id)) {
      return c.json({ error: "Valid client_id is required" }, 400);
    }

    const result = generateAuditPackage({
      client_id,
      vendor_id: vendor_id && typeof vendor_id === "number" ? vendor_id : undefined,
      document_type: document_type && typeof document_type === "string" ? document_type : undefined,
      date_from: date_from && typeof date_from === "string" ? date_from : undefined,
      date_to: date_to && typeof date_to === "string" ? date_to : undefined,
    });

    return c.json(result);
  } catch (err) {
    console.error("[audit] Error generating audit package:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/audit/download/:filename — download a generated audit ZIP
app.get("/api/audit/download/:filename", (c) => {
  try {
    const filename = decodeURIComponent(c.req.param("filename"));
    const auditsDir = path.join(import.meta.dir, "..", "data", "audits");
    const filePath = path.join(auditsDir, filename);

    // Security: prevent directory traversal
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(auditsDir);
    if (!resolved.startsWith(resolvedDir)) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    if (!existsSync(filePath)) {
      return c.json({ error: "Audit file not found" }, 404);
    }

    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Email Queue Processing ─────────────────────────────────

// POST /api/emails/process-queue — claim/read queued messages for the delivery worker.
app.post("/api/emails/process-queue", (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    const db = getDb();
    const rows = db.query(`
      SELECT id, from_address, from_name, reply_to, recipient_email, subject,
             html_body, client_id, vendor_id, email_type
      FROM outgoing_email_queue
      WHERE status = 'queued'
      ORDER BY id ASC
    `).all();
    return c.json(rows);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/emails/mark-sent — acknowledge successful delivery of queue IDs.
app.post("/api/emails/mark-sent", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    const body = await c.req.json() as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.some((id) => !Number.isInteger(id) || (id as number) < 1)) {
      return c.json({ error: "ids must be an array of positive integers" }, 400);
    }
    const db = getDb();
    const update = db.query("UPDATE outgoing_email_queue SET status = 'sent', sent_at = datetime('now') WHERE id = $id");
    const updateLogs = db.query(`
      UPDATE email_log SET status = 'sent', sent_at = datetime('now')
      WHERE status IN ('queued', 'error')
        AND recipient_email = $recipient AND subject = $subject
        AND (client_id IS $client_id OR client_id = $client_id)
    `);
    let updated = 0;
    for (const rawId of body.ids as number[]) {
      const id = Number(rawId);
      const row = db.query("SELECT client_id, vendor_id, recipient_email, subject FROM outgoing_email_queue WHERE id = $id").get({ $id: id }) as any;
      if (!row) continue;
      update.run({ $id: id });
      updateLogs.run({ $recipient: row.recipient_email, $subject: row.subject, $client_id: row.client_id });
      updated++;
    }
    return c.json({ success: true, updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/emails/mark-failed — record a delivery failure.
app.post("/api/emails/mark-failed", async (c) => {
  const denied = requireQueueSecret(c);
  if (denied) return denied;
  try {
    const body = await c.req.json() as { id?: unknown; error?: unknown };
    if (!Number.isInteger(body.id) || (body.id as number) < 1 || typeof body.error !== "string") {
      return c.json({ error: "id and error are required" }, 400);
    }
    const db = getDb();
    const result = db.query("UPDATE outgoing_email_queue SET status = 'failed', error_message = $error WHERE id = $id").run({ $id: body.id as number, $error: body.error });
    return c.json({ success: true, updated: result.changes });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Email Configuration ──────────────────────────────────

// GET /api/emails/config/:client_id — get email config
app.get("/api/emails/config/:client_id", (c) => {
  try {
    const db = getDb();
    const clientId = Number(c.req.param("client_id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    let config = db.query(
      "SELECT id, client_id, weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled, created_at, updated_at FROM client_email_config WHERE client_id = $client_id AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $client_id: clientId, $tenant_id: c.get("tenant_id") as number }) as Record<string, unknown> | undefined;

    if (!config) {
      // Return defaults — config gets created on first save
      return c.json({
        client_id: clientId,
        weekly_report_recipients: null,
        monthly_report_recipients: null,
        renewal_reminders_enabled: 1,
      });
    }

    return c.json(config);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// PUT /api/emails/config/:client_id — update email recipients
app.put("/api/emails/config/:client_id", async (c) => {
  try {
    const db = getDb();
    const clientId = Number(c.req.param("client_id"));

    const existing = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: c.get("tenant_id") as number });
    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const body = await c.req.json();
    const { weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled } = body;

    // Upsert: try insert, then update on conflict
    db.query(`
      INSERT INTO client_email_config (client_id, weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled, updated_at)
      VALUES ($client_id, $weekly, $monthly, $renewal, datetime('now'))
      ON CONFLICT(client_id) DO UPDATE SET
        weekly_report_recipients = COALESCE($weekly, weekly_report_recipients),
        monthly_report_recipients = COALESCE($monthly, monthly_report_recipients),
        renewal_reminders_enabled = COALESCE($renewal, renewal_reminders_enabled),
        updated_at = datetime('now')
    `).run({
      $client_id: clientId,
      $weekly: weekly_report_recipients !== undefined ? (typeof weekly_report_recipients === "string" ? weekly_report_recipients.trim() || null : null) : null,
      $monthly: monthly_report_recipients !== undefined ? (typeof monthly_report_recipients === "string" ? monthly_report_recipients.trim() || null : null) : null,
      $renewal: renewal_reminders_enabled !== undefined ? (renewal_reminders_enabled ? 1 : 0) : null,
    });

    const config = db.query(
      "SELECT id, client_id, weekly_report_recipients, monthly_report_recipients, renewal_reminders_enabled, created_at, updated_at FROM client_email_config WHERE client_id = $client_id AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $client_id: clientId, $tenant_id: c.get("tenant_id") as number });

    return c.json(config);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/emails/log — list recent emails, supports ?client_id=
app.get("/api/emails/log", (c) => {
  try {
    const db = getDb();
    const clientId = c.req.query("client_id");
    const limit = Math.min(Number(c.req.query("limit")) || 100, 500);

    let sql = `
      SELECT el.id, el.client_id, el.vendor_id, el.email_type, el.recipient_email,
             el.subject, el.sent_at, el.status, el.error_message,
             cl.name as client_name,
             v.name as vendor_name
      FROM email_log el
      JOIN clients scope_client ON scope_client.id = el.client_id AND scope_client.tenant_id = $tenant_id
      LEFT JOIN clients cl ON cl.id = el.client_id
      LEFT JOIN vendors v ON v.id = el.vendor_id
    `;

    const params: Record<string, unknown> = { $limit: limit, $tenant_id: c.get("tenant_id") as number };

    if (clientId) {
      sql += " WHERE el.client_id = $client_id";
      params.$client_id = Number(clientId);
    }

    sql += " ORDER BY el.sent_at DESC LIMIT $limit";

    const rows = db.query(sql).all(params);
    return c.json(rows);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/emails/test-weekly/:client_id — manually send a test weekly report
app.post("/api/emails/test-weekly/:client_id", async (c) => {
  try {
    const db = getDb();
    const clientId = Number(c.req.param("client_id"));

    const client = db.query("SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id").get({ $id: clientId, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string } | undefined;
    if (!client) {
      return c.json({ error: "Client not found" }, 404);
    }

    // Get email config to know recipients
    const config = db.query(
      "SELECT weekly_report_recipients FROM client_email_config WHERE client_id = $client_id AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)"
    ).get({ $client_id: clientId }) as { weekly_report_recipients: string | null } | undefined;

    if (!config?.weekly_report_recipients) {
      return c.json({ error: "No weekly report recipients configured. Set them up first." }, 400);
    }

    const recipients = parseRecipients(config.weekly_report_recipients);

    // Gather report data
    const reportData = gatherReportData(clientId);

    // Build email
    const emailBody = buildWeeklyReportEmail(client.name, {
      approved_count: reportData.approved.length,
      review_count: reportData.review.length,
      hold_count: reportData.hold.length,
      expiring_count: reportData.expiring_during_week.length,
      missing_count: reportData.missing_docs.length,
      payment_week: reportData.payment_week,
      report_date: reportData.report_date,
    });

    const subject = `[TEST] Clear-to-Pay Weekly Report — ${reportData.payment_week.monday} to ${reportData.payment_week.sunday}`;

    sendEmail(recipients, subject, emailBody, clientId, undefined, "weekly_report");

    return c.json({
      success: true,
      recipients,
      subject,
      summary: {
        approved_count: reportData.approved.length,
        review_count: reportData.review.length,
        hold_count: reportData.hold.length,
        expiring_count: reportData.expiring_during_week.length,
        missing_count: reportData.missing_docs.length,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/emails/test-renewal/:document_id — manually send a renewal reminder
app.post("/api/emails/test-renewal/:document_id", async (c) => {
  try {
    const db = getDb();
    const docId = Number(c.req.param("document_id"));

    const doc = db.query(`
      SELECT d.id, d.vendor_id, d.client_id, d.document_type, d.sender_email,
             de.expiration_date, v.name as vendor_name
      FROM documents d
      JOIN document_extractions de ON de.document_id = d.id
      JOIN vendors v ON v.id = d.vendor_id
      WHERE d.id = $id AND de.is_reviewed = 1 AND d.tenant_id = $tenant_id
    `).get({ $id: docId, $tenant_id: c.get("tenant_id") }) as {
      id: number; vendor_id: number; client_id: number; document_type: string;
      sender_email: string | null; expiration_date: string | null; vendor_name: string;
    } | undefined;

    if (!doc) {
      return c.json({ error: "Document not found or not reviewed" }, 404);
    }

    if (!doc.sender_email) {
      return c.json({ error: "No sender email on this document" }, 400);
    }

    if (!doc.expiration_date) {
      return c.json({ error: "No expiration date on this document" }, 400);
    }

    const expDate = new Date(doc.expiration_date + "T00:00:00Z");
    const diffMs = expDate.getTime() - Date.now();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    const emailBody = buildRenewalReminderEmail(
      doc.vendor_name,
      doc.document_type,
      doc.expiration_date,
      Math.max(0, diffDays),
    );

    const subject = `[TEST] Reminder: ${doc.document_type} for ${doc.vendor_name} expires ${diffDays <= 0 ? "today" : `in ${diffDays} days`}`;

    sendEmail([doc.sender_email], subject, emailBody, doc.client_id, doc.vendor_id, "renewal_reminder");

    return c.json({
      success: true,
      recipient: doc.sender_email,
      subject,
      vendor_name: doc.vendor_name,
      document_type: doc.document_type,
      expiration_date: doc.expiration_date,
      days_until_expiry: diffDays,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Initialize DB on startup
getDb();

// Start the email scheduler
startScheduler();

export default {
  port: 3001,
  fetch: app.fetch,
};
