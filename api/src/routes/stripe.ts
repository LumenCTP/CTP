import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "../db";
import { findTenantForUser, createTenantForUser, findWizard, logAudit } from "../middleware";

const app = new Hono();

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

export default app;
