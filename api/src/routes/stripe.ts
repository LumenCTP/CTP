import { Hono } from "hono";
import { serverError } from "../errors";
import { createHmac, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { getDb } from "../db";
import { findTenantForUser, createTenantForUser, findWizard, logAudit, verifyAuthToken } from "../middleware";
import { logPartnerAudit } from "./partners";
import { getStripe, getWebhookSecrets, StripeMode } from "../stripe-connect";
import { sendEmail, buildPartnerTransferPaidEmail, buildPartnerTransferFailedEmail } from "../email";

const app = new Hono();

// ── Stripe Webhook ──────────────────────────────────────

// Manual Stripe webhook signature verification (HMAC-SHA256), so we don't need
// the `stripe` npm package for verification. Stripe sends: t=<timestamp>,v1=<signature>.
function verifyStripeSignature(rawBody: string, sigHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
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

// Try the LIVE secret first, then the TEST secret — whichever matches wins.
// Returns which mode verified (for logging). With no secrets configured at
// all, falls back to dev mode (accept + warn), matching the pre-existing
// behavior of this route.
function verifyWithSecrets(rawBody: string, sigHeader: string | undefined): { ok: boolean; mode: StripeMode | "dev" | "none" } {
  const secrets = getWebhookSecrets();
  if (secrets.length === 0) {
    console.warn("[stripe] No STRIPE_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET_TEST set — skipping signature verification (dev mode)");
    return { ok: true, mode: "dev" };
  }
  for (const { secret, mode } of secrets) {
    if (verifyStripeSignature(rawBody, sigHeader, secret)) {
      return { ok: true, mode };
    }
  }
  return { ok: false, mode: "none" };
}

// ── Event helpers ────────────────────────────────────────

/** Resolve the subscription plan ('monthly' | 'annual' | null) from the
 * subscription object: price metadata first, then subscription metadata, then
 * product name / price nickname as a fallback. */
function planFromSubscription(sub: any): string | null {
  const price = sub?.items?.data?.[0]?.price;
  if (price?.metadata?.plan) return String(price.metadata.plan).toLowerCase();
  if (sub?.metadata?.plan) return String(sub.metadata.plan).toLowerCase();
  const productName =
    typeof price?.product === "object" && price.product ? price.product.name : null;
  const nickname = price?.nickname ?? null;
  const probe = `${productName || ""} ${nickname || ""}`.toLowerCase();
  if (probe.includes("annual")) return "annual";
  if (probe.includes("monthly")) return "monthly";
  return null;
}

/** Map a Stripe subscription status to the tenant's subscription_status
 * convention (ACTIVE / TRIAL / CANCELLED / PAST_DUE / ...). */
function mapSubscriptionStatus(status: string | undefined): string {
  const s = (status || "").toUpperCase();
  if (s === "ACTIVE" || s === "TRIALING" || s === "TRIAL") return s === "TRIALING" ? "TRIAL" : s;
  if (s === "CANCELED" || s === "CANCELLED") return "CANCELLED";
  if (s === "PAST_DUE") return "PAST_DUE";
  if (s === "INCOMPLETE" || s === "INCOMPLETE_EXPIRED") return "INCOMPLETE";
  return s || "ACTIVE";
}

/** Find the tenant a subscription belongs to:
 *  1. metadata.tenant_id / metadata.client_id on the subscription
 *  2. stripe_customer_id stored on tenants (from an earlier checkout)
 *  3. customer email (subscription.customer_details.email or
 *     metadata.client_email / metadata.customer_email) matched against users */
function findTenantForSubscription(db: ReturnType<typeof getDb>, sub: any): { id: number; name: string } | undefined {
  const meta = sub?.metadata ?? {};
  const rawTid = meta.tenant_id ?? meta.client_id;
  if (rawTid !== undefined && rawTid !== null && rawTid !== "") {
    const t = db.query("SELECT id, name FROM tenants WHERE id = $id").get({ $id: Number(rawTid) }) as { id: number; name: string } | undefined;
    if (t) return t;
  }
  const customer = sub?.customer;
  if (typeof customer === "string") {
    const t = db.query("SELECT id, name FROM tenants WHERE stripe_customer_id = $cus").get({ $cus: customer }) as { id: number; name: string } | undefined;
    if (t) return t;
  }
  const email = sub?.customer_details?.email || meta.client_email || meta.customer_email;
  if (email && typeof email === "string") {
    const u = db.query("SELECT tenant_id FROM users WHERE lower(email) = lower($email) AND tenant_id IS NOT NULL").get({ $email: String(email).trim().toLowerCase() }) as { tenant_id: number } | undefined;
    if (u?.tenant_id) {
      const t = db.query("SELECT id, name FROM tenants WHERE id = $id").get({ $id: u.tenant_id }) as { id: number; name: string } | undefined;
      if (t) return t;
    }
  }
  return undefined;
}

function handleSubscriptionEvent(event: any): { handled: boolean; note: string } {
  const sub = event?.data?.object ?? {};
  const db = getDb();
  const tenant = findTenantForSubscription(db, sub);
  if (!tenant) {
    const note = `subscription ${sub.id ?? "?"} for customer ${sub.customer ?? "?"} — no tenant match (metadata, customer id, or email)`;
    console.warn(`[stripe] ${event.type}: ${note}`);
    return { handled: false, note };
  }
  const plan = planFromSubscription(sub);
  const status = mapSubscriptionStatus(sub.status);
  const customerId = typeof sub.customer === "string" ? sub.customer : null;
  const subId = sub.id ? String(sub.id) : null;
  // Trial end (subscription.trial_end is a Unix epoch in seconds) — stored only
  // while the subscription is trialing; cleared once it converts to paid.
  const trialEnd = status === "TRIAL" && typeof sub.trial_end === "number"
    ? new Date(sub.trial_end * 1000).toISOString().slice(0, 10)
    : null;
  const cancelAtPeriodEnd = sub.cancel_at_period_end === true ? 1 : 0;
  db.query(`
    UPDATE tenants
    SET subscription_plan = COALESCE($plan, subscription_plan),
        subscription_status = $status,
        subscription_trial_end = $trialEnd,
        cancel_at_period_end = $cancelEnd,
        stripe_customer_id = COALESCE($cus, stripe_customer_id),
        stripe_subscription_id = COALESCE($sub, stripe_subscription_id),
        updated_at = datetime('now')
    WHERE id = $tid
  `).run({ $plan: plan, $status: status, $trialEnd: trialEnd, $cancelEnd: cancelAtPeriodEnd, $cus: customerId, $sub: subId, $tid: tenant.id });
  logAudit(db, "tenant", tenant.id, `stripe_${event.type}`, {
    stripe_subscription_id: subId,
    plan,
    status,
    trial_end: trialEnd,
    cancel_at_period_end: cancelAtPeriodEnd,
    customer: customerId,
  });
  console.log(`[stripe] ${event.type}: tenant ${tenant.id} (${tenant.name}) → plan=${plan ?? "unchanged"}, status=${status}, sub=${subId ?? "?"}`);
  return { handled: true, note: `tenant ${tenant.id} updated` };
}

/** Find the tenant a subscription invoice belongs to — via stripe_customer_id or
 * stripe_subscription_id stored on the tenant. */
function findTenantForInvoice(db: ReturnType<typeof getDb>, invoice: any): { id: number; name: string } | undefined {
  const customer = typeof invoice?.customer === "string" ? invoice.customer : null;
  if (customer) {
    const t = db.query("SELECT id, name FROM tenants WHERE stripe_customer_id = $cus").get({ $cus: customer }) as { id: number; name: string } | undefined;
    if (t) return t;
  }
  const sub = typeof invoice?.subscription === "string" ? invoice.subscription : null;
  if (sub) {
    const t = db.query("SELECT id, name FROM tenants WHERE stripe_subscription_id = $sub").get({ $sub: sub }) as { id: number; name: string } | undefined;
    if (t) return t;
  }
  return undefined;
}

/** invoice.payment_succeeded — a subscription payment went through. Update the
 * tenant's billing period from the invoice line period (the source of truth for
 * renewal dates) and set the status back to ACTIVE. */
function handleInvoicePaymentSucceeded(event: any): { handled: boolean; note: string } {
  const invoice = event?.data?.object ?? {};
  const db = getDb();
  const tenant = findTenantForInvoice(db, invoice);
  if (!tenant) {
    const note = `invoice ${invoice.id ?? "?"} for customer ${invoice.customer ?? "?"} — no tenant match (stripe_customer_id or stripe_subscription_id)`;
    console.warn(`[stripe] invoice.payment_succeeded: ${note}`);
    return { handled: false, note };
  }
  const period = invoice?.lines?.data?.[0]?.period;
  let start: string | null = null;
  let end: string | null = null;
  if (period?.start) start = new Date(period.start * 1000).toISOString().slice(0, 10);
  if (period?.end) end = new Date(period.end * 1000).toISOString().slice(0, 10);
  db.query(`
    UPDATE tenants
    SET subscription_status = 'ACTIVE',
        subscription_trial_end = NULL,
        subscription_period_start = COALESCE($start, subscription_period_start),
        subscription_period_end = COALESCE($end, subscription_period_end),
        updated_at = datetime('now')
    WHERE id = $tid
  `).run({ $start: start, $end: end, $tid: tenant.id });
  logAudit(db, "tenant", tenant.id, "invoice_payment_succeeded", { invoice: invoice.id ?? null, period_start: start, period_end: end });
  console.log(`[stripe] invoice.payment_succeeded: tenant ${tenant.id} (${tenant.name}) → period ${start ?? "?"} → ${end ?? "?"}`);
  return { handled: true, note: `tenant ${tenant.id} period updated` };
}

/** invoice.payment_failed — a subscription renewal payment failed. Flag the
 * tenant PAST_DUE so the client sees the hold until payment is collected. */
function handleInvoicePaymentFailed(event: any): { handled: boolean; note: string } {
  const invoice = event?.data?.object ?? {};
  const db = getDb();
  const tenant = findTenantForInvoice(db, invoice);
  if (!tenant) {
    const note = `invoice ${invoice.id ?? "?"} for customer ${invoice.customer ?? "?"} — no tenant match (stripe_customer_id or stripe_subscription_id)`;
    console.warn(`[stripe] invoice.payment_failed: ${note}`);
    return { handled: false, note };
  }
  db.query(`
    UPDATE tenants
    SET subscription_status = 'PAST_DUE',
        updated_at = datetime('now')
    WHERE id = $tid
  `).run({ $tid: tenant.id });
  logAudit(db, "tenant", tenant.id, "invoice_payment_failed", { invoice: invoice.id ?? null, attempt: invoice.attempt ?? null });
  console.log(`[stripe] invoice.payment_failed: tenant ${tenant.id} (${tenant.name}) → PAST_DUE`);
  return { handled: true, note: `tenant ${tenant.id} marked PAST_DUE` };
}

function handleAccountUpdated(event: any): { handled: boolean; note: string } {
  const account = event?.data?.object ?? {};
  const db = getDb();
  const meta = account?.metadata ?? {};
  const accountId = account.id ? String(account.id) : null;
  let partner = null;
  if (meta.partner_id !== undefined && meta.partner_id !== null && meta.partner_id !== "") {
    partner = db.query("SELECT id, first_name, last_name FROM partners WHERE id = $id").get({ $id: Number(meta.partner_id) }) as { id: number; first_name: string; last_name: string } | undefined;
  }
  if (!partner && accountId) {
    partner = db.query("SELECT id, first_name, last_name FROM partners WHERE stripe_account_id = $aid").get({ $aid: accountId }) as { id: number; first_name: string; last_name: string } | undefined;
  }
  if (!partner) {
    const note = `account ${accountId ?? "?"} — no partner match (metadata.partner_id or stripe_account_id)`;
    console.warn(`[stripe] account.updated: ${note}`);
    return { handled: false, note };
  }
  const currentlyDue = account?.requirements?.currently_due ?? [];
  const detailsSubmitted = account?.details_submitted === true ? 1 : 0;
  const payoutsEnabled = account?.payouts_enabled === true ? 1 : 0;
  const chargesEnabled = account?.charges_enabled === true ? 1 : 0;
  db.query(`
    UPDATE partners
    SET stripe_account_id = COALESCE($aid, stripe_account_id),
        stripe_details_submitted = $ds,
        stripe_currently_due = $due,
        stripe_payouts_enabled = $pe,
        stripe_charges_enabled = $ce,
        stripe_disconnected_at = NULL,
        updated_at = datetime('now')
    WHERE id = $id
  `).run({
    $aid: accountId,
    $ds: detailsSubmitted,
    $due: JSON.stringify(currentlyDue),
    $pe: payoutsEnabled,
    $ce: chargesEnabled,
    $id: partner.id,
  });
  logPartnerAudit(db, partner.id, "stripe_account_updated", {
    stripe_account_id: accountId,
    details_submitted: detailsSubmitted === 1,
    currently_due: currentlyDue,
    payouts_enabled: payoutsEnabled === 1,
    charges_enabled: chargesEnabled === 1,
  }, null, "stripe-webhook");
  logAudit(db, "partner", partner.id, "stripe_account_updated", {
    stripe_account_id: accountId,
    details_submitted: detailsSubmitted === 1,
    currently_due: currentlyDue,
    payouts_enabled: payoutsEnabled === 1,
  });
  console.log(`[stripe] account.updated: partner ${partner.id} (${partner.first_name} ${partner.last_name}) → details_submitted=${detailsSubmitted === 1}, currently_due=${currentlyDue.length}, payouts_enabled=${payoutsEnabled === 1}`);
  return { handled: true, note: `partner ${partner.id} updated` };
}

function handleAccountDeauthorized(event: any): { handled: boolean; note: string } {
  const account = event?.data?.object ?? {};
  const db = getDb();
  const accountId = account.id ? String(account.id) : null;
  if (!accountId) return { handled: false, note: "no account id" };
  const partner = db.query("SELECT id FROM partners WHERE stripe_account_id = $aid").get({ $aid: accountId }) as { id: number } | undefined;
  if (!partner) {
    console.warn(`[stripe] account.application.deauthorized: account ${accountId} not linked to a partner`);
    return { handled: false, note: "no partner match" };
  }
  db.query(`
    UPDATE partners
    SET stripe_account_id = NULL,
        stripe_details_submitted = 0,
        stripe_currently_due = NULL,
        stripe_payouts_enabled = 0,
        stripe_charges_enabled = 0,
        stripe_disconnected_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = $id
  `).run({ $id: partner.id });
  logPartnerAudit(db, partner.id, "stripe_account_deauthorized", { stripe_account_id: accountId }, null, "stripe-webhook");
  logAudit(db, "partner", partner.id, "stripe_account_deauthorized", { stripe_account_id: accountId });
  console.log(`[stripe] account.application.deauthorized: partner ${partner.id} disconnected`);
  return { handled: true, note: `partner ${partner.id} disconnected` };
}

function findPayoutForTransfer(db: ReturnType<typeof getDb>, transfer: any): { id: number; partner_id: number; amount: number } | undefined {
  const transferId = transfer?.id ? String(transfer.id) : null;
  if (transferId) {
    const byRef = db.query("SELECT id, partner_id, amount FROM payouts WHERE transaction_ref = $ref").get({ $ref: transferId }) as { id: number; partner_id: number; amount: number } | undefined;
    if (byRef) return byRef;
  }
  const meta = transfer?.metadata ?? {};
  if (meta.payout_id !== undefined && meta.payout_id !== null && meta.payout_id !== "") {
    const byMeta = db.query("SELECT id, partner_id, amount FROM payouts WHERE id = $id").get({ $id: Number(meta.payout_id) }) as { id: number; partner_id: number; amount: number } | undefined;
    if (byMeta) return byMeta;
  }
  return undefined;
}

function handleTransferEvent(event: any): { handled: boolean; note: string } {
  const transfer = event?.data?.object ?? {};
  const db = getDb();
  const payout = findPayoutForTransfer(db, transfer);
  if (!payout) {
    const note = `transfer ${transfer.id ?? "?"} — no payout match (transaction_ref or metadata.payout_id)`;
    console.warn(`[stripe] ${event.type}: ${note}`);
    return { handled: false, note };
  }
  const transferId = transfer.id ? String(transfer.id) : null;
  const partner = db.query("SELECT id, first_name, last_name, email FROM partners WHERE id = $pid").get({ $pid: payout.partner_id }) as { id: number; first_name: string; last_name: string; email: string } | undefined;

  if (event.type === "transfer.paid") {
    const paidDate = transfer.created ? new Date(transfer.created * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    db.query(`
      UPDATE payouts
      SET status = 'paid', payment_date = $date, payment_method = 'stripe_connect',
          transaction_ref = COALESCE($ref, transaction_ref)
      WHERE id = $id
    `).run({ $date: paidDate, $ref: transferId, $id: payout.id });
    logPartnerAudit(db, payout.partner_id, "payout_transfer_paid", { payout_id: payout.id, amount: payout.amount, transaction_ref: transferId, payment_date: paidDate }, null, "stripe-webhook");
    logAudit(db, "payout", payout.id, "payout_transfer_paid", { amount: payout.amount, transaction_ref: transferId, payment_date: paidDate });
    if (partner?.email) {
      const name = partner ? `${partner.first_name} ${partner.last_name}`.trim() : `partner #${payout.partner_id}`;
      sendEmail([partner.email], "Your ClearToPay partner payout has been transferred", buildPartnerTransferPaidEmail(name, payout.amount, transferId || "unknown"), undefined, undefined, "partner_payout");
    }
    console.log(`[stripe] transfer.paid: payout ${payout.id} marked paid (ref ${transferId ?? "?"})`);
    return { handled: true, note: `payout ${payout.id} paid` };
  }

  if (event.type === "transfer.failed") {
    const reason = [transfer.failure_code, transfer.failure_message].filter(Boolean).join(" — ") || "transfer failed";
    db.query(`
      UPDATE payouts
      SET status = 'failed',
          transaction_ref = COALESCE($ref, transaction_ref),
          notes = $notes
      WHERE id = $id
    `).run({ $ref: transferId, $notes: reason, $id: payout.id });
    logPartnerAudit(db, payout.partner_id, "payout_transfer_failed", { payout_id: payout.id, amount: payout.amount, transaction_ref: transferId, failure_reason: reason }, reason, "stripe-webhook");
    logAudit(db, "payout", payout.id, "payout_transfer_failed", { amount: payout.amount, transaction_ref: transferId, failure_reason: reason });
    if (partner?.email) {
      const name = partner ? `${partner.first_name} ${partner.last_name}`.trim() : `partner #${payout.partner_id}`;
      sendEmail([partner.email], "Action needed: your ClearToPay partner payout could not be transferred", buildPartnerTransferFailedEmail(name, payout.amount, transferId || "unknown", reason), undefined, undefined, "partner_payout");
    }
    console.log(`[stripe] transfer.failed: payout ${payout.id} marked failed (${reason})`);
    return { handled: true, note: `payout ${payout.id} failed` };
  }

  return { handled: false, note: `unknown transfer event type ${event.type}` };
}

// Provision a tenant from a completed Stripe checkout:
// find-or-create user by email → find-or-create tenant → activate subscription
// (TRIAL when the subscription is trialing, ACTIVE when paid) → setup wizard
async function provisionTenantFromCheckout(
  email: string,
  session: any,
  subInfo?: { status?: string; trialEnd?: string | null }
) {
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

  // Trialing subscription (30-day free trial, card on file) → tenant TRIAL with
  // a trial end date; truly paid subscription (no trial) → tenant ACTIVE.
  const trialing = subInfo?.status === "trialing";
  const status = trialing ? "TRIAL" : "ACTIVE";
  const trialEnd = trialing ? (subInfo?.trialEnd ?? null) : null;

  let tenant = findTenantForUser(db, user.id);
  if (!tenant) {
    tenant = createTenantForUser(db, user.id, {
      name: user.company_name || "My Company",
      subscription_status: status,
      periodStart,
      periodEnd,
      trialEnd,
    });
    logAudit(db, "tenant", tenant.id, "tenant_created", { name: tenant.name, owner_user_id: user.id, source: "stripe_webhook" });
    logAudit(db, "tenant", tenant.id, "subscription_activated", { email: normEmail, period_start: periodStart, period_end: periodEnd, status, trial_end: trialEnd });
  } else {
    db.query(`
      UPDATE tenants
      SET subscription_status = $status,
          subscription_trial_end = $trialEnd,
          subscription_period_start = $start,
          subscription_period_end = $end,
          admin_email = $email,
          updated_at = datetime('now')
      WHERE id = $id
    `).run({ $status: status, $trialEnd: trialEnd, $start: periodStart, $end: periodEnd, $email: normEmail, $id: tenant.id });
    logAudit(db, "tenant", tenant.id, "subscription_activated", { email: normEmail, period_start: periodStart, period_end: periodEnd, status, trial_end: trialEnd });
    tenant = findTenantForUser(db, user.id)!;
  }

  // Record plan / subscription ids when the checkout carries them (extension
  // of the pre-existing placeholder logic — the tenant creation itself is
  // unchanged).
  const meta = session?.metadata ?? {};
  const plan = meta.plan ? String(meta.plan).toLowerCase() : null;
  const customerId = typeof session?.customer === "string" ? session.customer : null;
  const subId = typeof session?.subscription === "string" ? session.subscription : null;
  if (plan || customerId || subId) {
    db.query(`
      UPDATE tenants
      SET subscription_plan = COALESCE($plan, subscription_plan),
          stripe_customer_id = COALESCE($cus, stripe_customer_id),
          stripe_subscription_id = COALESCE($sub, stripe_subscription_id),
          updated_at = datetime('now')
      WHERE id = $id
    `).run({ $plan: plan, $cus: customerId, $sub: subId, $id: tenant.id });
    logAudit(db, "tenant", tenant.id, "subscription_recorded_from_checkout", { plan, customer: customerId, subscription: subId });
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

// ── Stripe Webhook Route ─────────────────────────────────

// POST /api/webhooks/stripe — receives Stripe events (raw body required for signature verification)
app.post("/api/webhooks/stripe", async (c) => {
  try {
    const rawBody = await c.req.text();
    const sigHeader = c.req.header("stripe-signature");

    const verified = verifyWithSecrets(rawBody, sigHeader);
    if (!verified.ok) {
      console.warn("[stripe] Webhook signature verification failed (live and test secrets both rejected)");
      return c.json({ error: "Invalid signature" }, 400);
    }
    if (verified.mode !== "dev") {
      console.log(`[stripe] Webhook verified with ${verified.mode} secret`);
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const type = event?.type ?? "unknown";

    if (type === "checkout.session.completed") {
      const session = event.data?.object ?? {};
      const email = session.customer_details?.email;
      if (!email || typeof email !== "string") {
        console.warn("[stripe] checkout.session.completed without customer_details.email");
        return c.json({ error: "Missing customer_details.email in checkout session" }, 400);
      }
      // Retrieve the subscription so we know whether this session started a
      // 30-day trial (subscription.status === "trialing", no charge yet) or
      // collected payment immediately (paid) — the tenant maps to TRIAL or
      // ACTIVE accordingly.
      let subInfo: { status?: string; trialEnd?: string | null } | undefined;
      if (typeof session.subscription === "string") {
        try {
          const sub = await getStripe()!.subscriptions.retrieve(session.subscription);
          subInfo = {
            status: sub.status,
            trialEnd: typeof sub.trial_end === "number"
              ? new Date(sub.trial_end * 1000).toISOString().slice(0, 10)
              : null,
          };
        } catch (err) {
          console.warn(`[stripe] checkout.session.completed: could not retrieve subscription ${session.subscription}: ${String(err)}`);
        }
      }
      const result = await provisionTenantFromCheckout(email, session, subInfo);
      return c.json({ success: true, event_type: type, ...result });
    }

    if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      // created/updated: sync plan + status (incl. "trialing" → TRIAL).
      // deleted: Stripe sends the subscription with status "canceled", which
      // handleSubscriptionEvent maps to CANCELLED on the tenant.
      const result = handleSubscriptionEvent(event);
      // Always 2xx fast — an unmatched subscription is not an error to Stripe.
      return c.json({ received: true, event_type: type, handled: result.handled, note: result.note });
    }

    if (type === "invoice.payment_succeeded") {
      // Renewal (or initial) invoice paid — real billing period dates.
      const result = handleInvoicePaymentSucceeded(event);
      return c.json({ received: true, event_type: type, handled: result.handled, note: result.note });
    }

    if (type === "invoice.payment_failed") {
      // Renewal payment failed — flag the tenant PAST_DUE.
      const result = handleInvoicePaymentFailed(event);
      return c.json({ received: true, event_type: type, handled: result.handled, note: result.note });
    }

    if (type === "account.updated") {
      const result = handleAccountUpdated(event);
      return c.json({ received: true, event_type: type, handled: result.handled, note: result.note });
    }

    if (type === "account.application.deauthorized") {
      const result = handleAccountDeauthorized(event);
      return c.json({ received: true, event_type: type, handled: result.handled, note: result.note });
    }

    if (type === "transfer.paid" || type === "transfer.failed") {
      const result = handleTransferEvent(event);
      return c.json({ received: true, event_type: type, handled: result.handled, note: result.note });
    }

    // Acknowledge all other event types — never crash on unknown events.
    return c.json({ received: true, event_type: type });
  } catch (err) {
    console.error("[stripe] Webhook error:", err);
    return serverError(c, err);
  }
});

// ── Checkout Session (public) ────────────────────────────

// Subscription plans sold on the marketing checkout page. Prices are ensured
// idempotently in the OWNER'S Stripe account (via their secret key) — the
// platform catalog placeholders in the web app are never touched.
const CHECKOUT_PLANS: Record<string, { product: string; amount: number; interval: "month" | "year" }> = {
  monthly: { product: "ClearToPay Monthly", amount: 14900, interval: "month" },
  annual: { product: "ClearToPay Annual", amount: 120000, interval: "year" },
};

/**
 * Find (by metadata.plan on an active price) or create the price for a plan.
 * Returns the price id, or null for an unknown plan. Safe to call repeatedly —
 * a price created by a previous call is reused.
 */
async function ensurePlanPrice(stripe: Stripe, plan: string): Promise<string | null> {
  const cfg = CHECKOUT_PLANS[plan];
  if (!cfg) return null;
  const prices = await stripe.prices.list({ active: true, limit: 100 });
  for (const p of prices.data) {
    if (
      p.currency === "usd" &&
      p.unit_amount === cfg.amount &&
      p.recurring?.interval === cfg.interval &&
      p.metadata?.plan === plan
    ) {
      return p.id;
    }
  }
  const product = await stripe.products.create({ name: cfg.product, metadata: { plan } });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: cfg.amount,
    currency: "usd",
    recurring: { interval: cfg.interval },
    metadata: { plan },
  });
  console.log(`[checkout] created price ${price.id} for plan ${plan} (${cfg.product}, ${(cfg.amount / 100).toFixed(2)}/${cfg.interval})`);
  return price.id;
}

// POST /api/checkout/session — create a Stripe Checkout session for the
// monthly or annual subscription. Public (no auth required); when the caller IS
// authenticated, their tenant_id is passed through as subscription metadata so
// the webhook can attach the subscription to their existing tenant.
//
// Body: { plan: "monthly" | "annual", success_url?, cancel_url?, email? }
// Returns: { url } — a Stripe-hosted checkout page. Creating a session never
// charges anyone and never provisions a tenant (that happens on the webhook).
app.post("/api/checkout/session", async (c) => {
  const stripe = getStripe();
  if (!stripe) {
    return c.json({ error: "Stripe is not configured" }, 503);
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const plan = String(body.plan ?? "").toLowerCase();
  if (plan !== "monthly" && plan !== "annual") {
    return c.json({ error: "plan must be 'monthly' or 'annual'" }, 400);
  }

  const email = typeof body.email === "string" && body.email.trim() !== "" ? body.email.trim() : undefined;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Invalid email address" }, 400);
  }

  // Optional: if the caller is authenticated, attach their tenant to the
  // subscription so the webhook finds the existing tenant instead of creating
  // a new one for the email. Also used for client_reference_id (ownership
  // verification on /api/checkout/confirm).
  let tenantId: number | undefined;
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const user = await verifyAuthToken(authHeader.slice(7));
    if (user) {
      const t = findTenantForUser(getDb(), user.user_id);
      if (t) tenantId = t.id;
    }
  }
  // Fallback: no auth token, but an email was provided — look the user up by
  // email so the session can still be tied to their tenant.
  if (tenantId === undefined && email) {
    const u = getDb().query(
      "SELECT tenant_id FROM users WHERE lower(email) = lower($email) AND tenant_id IS NOT NULL"
    ).get({ $email: email.trim().toLowerCase() }) as { tenant_id: number } | undefined;
    if (u?.tenant_id) tenantId = u.tenant_id;
  }

  let priceId: string;
  try {
    priceId = (await ensurePlanPrice(stripe, plan))!;
  } catch (err) {
    console.error("[checkout] failed to ensure plan price:", err);
    return serverError(c, err);
  }
  if (!priceId) return c.json({ error: "Unknown plan" }, 400);

  // Default success/cancel URLs point back to the SAME origin the request came
  // from (works on dev and live hosts); fall back to the canonical live domain.
  const reqOrigin = c.req.header("Origin");
  const reqHost = c.req.header("Host");
  const baseOrigin = reqOrigin && /^https?:\/\//.test(reqOrigin)
    ? reqOrigin.replace(/\/+$/, "")
    : reqHost && !reqHost.includes("localhost") && !reqHost.includes("127.0.0.1")
      ? `https://${reqHost}`
      : "https://cleartopay.ctonew.app";

  const successUrl = typeof body.success_url === "string" && body.success_url !== ""
    ? body.success_url
    : `${baseOrigin}/app?checkout=success`;
  const cancelUrl = typeof body.cancel_url === "string" && body.cancel_url !== ""
    ? body.cancel_url
    : `${baseOrigin}/checkout?cancelled=1`;

  const baseParams: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    // A card (or other payment method) is required at checkout — it's kept on
    // file for the 30-day free trial and charged automatically when the trial
    // ends (Stripe auto-bills the saved method; nothing is charged at checkout).
    payment_method_collection: "always",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 30,
      metadata: {
        plan,
        ...(tenantId !== undefined ? { tenant_id: String(tenantId) } : {}),
      },
    },
    metadata: { plan, source: "site-checkout" },
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Ownership anchor for /api/checkout/confirm: the session carries the
    // tenant id so the confirm endpoint can verify the session belongs to the
    // authenticated user.
    ...(tenantId !== undefined ? { client_reference_id: String(tenantId) } : {}),
    ...(email ? { customer_email: email } : {}),
  };

  // Do NOT hard-code payment methods — Stripe dynamically determines and
  // displays the payment methods eligible for the customer/device/location
  // (card, Apple Pay, Google Pay, Amazon Pay, Cash App Pay, Link, ...).
  try {
    const session = await stripe.checkout.sessions.create(baseParams);
    if (!session.url) {
      return c.json({ error: "Stripe did not return a checkout URL" }, 500);
    }
    // session_id is required by the SPA's /api/checkout/confirm step.
    return c.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error("[checkout] session create failed:", err);
    return serverError(c, err);
  }
});

// ── Checkout Confirm (synchronous activation fallback) ───

// POST /api/checkout/confirm — belt-and-suspenders activation path. Activates
// the caller's tenant immediately after a paid Stripe Checkout session, so a
// customer who just paid is ACTIVE right away even though the webhook signing
// secret match with the Stripe Dashboard is still unconfirmed.
//
// Auth: manual bearer check (same pattern as the session handler) so this
// endpoint is NOT under the requireTenant gate — PENDING tenants must be able
// to call it (it performs its own ownership verification).
//
// Body: { session_id }
// Returns: { status: "active", tenant } once the tenant is activated.
app.post("/api/checkout/confirm", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const sessionId = typeof body.session_id === "string" && body.session_id.trim() !== ""
    ? body.session_id.trim()
    : null;
  if (!sessionId) {
    return c.json({ error: "session_id is required" }, 400);
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const user = await verifyAuthToken(authHeader.slice(7));
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const stripe = getStripe();
  if (!stripe) {
    return c.json({ error: "Stripe is not configured" }, 503);
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.code === "resource_missing") {
      return c.json({ error: "session_not_found" }, 404);
    }
    console.error("[checkout] confirm: session retrieve failed:", err);
    return serverError(c, err, 400);
  }

  // Retrieve the subscription (when present) for real status + billing-period
  // dates. A trialing subscription (30-day free trial, card on file) activates
  // the tenant as TRIAL; a paid subscription activates it as ACTIVE.
  let sub: Stripe.Subscription | null = null;
  const subId0 = typeof session.subscription === "string" ? session.subscription : null;
  if (subId0) {
    try {
      sub = await stripe.subscriptions.retrieve(subId0);
    } catch (err) {
      console.warn(`[checkout] confirm: subscription retrieve failed (${subId0}): ${String(err)}`);
    }
  }

  // Gate: only activate when the subscription is trialing (no charge yet, card
  // on file) OR Stripe reports the payment was collected.
  const trialing = sub?.status === "trialing";
  const paid = session.payment_status === "paid" ||
    (session.payment_status === "no_payment_required" && session.subscription != null);
  if (!trialing && !paid) {
    return c.json({ error: "not_paid", message: "This checkout session has not been paid yet." }, 402);
  }

  // Ownership: the session's client_reference_id must be the caller's tenant,
  // OR the session's customer email must match the caller's email.
  const db = getDb();
  const tenant = findTenantForUser(db, user.user_id);
  if (!tenant) {
    return c.json({ error: "No tenant found for this user. Please contact support." }, 403);
  }
  const refMatch = session.client_reference_id != null && String(session.client_reference_id) === String(tenant.id);
  const emailMatch = typeof session.customer_email === "string" &&
    session.customer_email.trim().toLowerCase() === user.email.toLowerCase();
  if (!refMatch && !emailMatch) {
    return c.json({ error: "session_does_not_belong_to_user" }, 403);
  }

  // Real billing-period dates from the subscription when available.
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let subPlan: string | null = null;
  let subId: string | null = subId0;
  let customerId: string | null = typeof session.customer === "string" ? session.customer : null;
  let trialEnd: string | null = null;
  const metaPlan = session.metadata?.plan ? String(session.metadata.plan).toLowerCase() : null;
  if (sub) {
    if (sub?.current_period_start) periodStart = new Date(sub.current_period_start * 1000).toISOString().slice(0, 10);
    if (sub?.current_period_end) periodEnd = new Date(sub.current_period_end * 1000).toISOString().slice(0, 10);
    if (trialing && typeof sub.trial_end === "number") trialEnd = new Date(sub.trial_end * 1000).toISOString().slice(0, 10);
    subPlan = planFromSubscription(sub) ?? metaPlan;
    subId = sub.id ? String(sub.id) : subId0;
    customerId = typeof sub.customer === "string" ? sub.customer : customerId;
  }

  // Fallback period dates: today → +30d (monthly) / +365d (annual).
  const plan = subPlan ?? metaPlan ?? null;
  const today = new Date().toISOString().slice(0, 10);
  if (!periodStart) periodStart = today;
  if (!periodEnd) {
    const days = plan === "annual" ? 365 : 30;
    periodEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  const nextStatus = trialing ? "TRIAL" : "ACTIVE";
  db.query(`
    UPDATE tenants
    SET subscription_status = $status,
        subscription_trial_end = $trialEnd,
        subscription_plan = COALESCE($plan, subscription_plan),
        subscription_period_start = COALESCE($start, subscription_period_start),
        subscription_period_end = COALESCE($end, subscription_period_end),
        stripe_customer_id = COALESCE($cus, stripe_customer_id),
        stripe_subscription_id = COALESCE($sub, stripe_subscription_id),
        updated_at = datetime('now')
    WHERE id = $tid
  `).run({
    $status: nextStatus,
    $trialEnd: trialEnd,
    $plan: plan,
    $start: periodStart,
    $end: periodEnd,
    $cus: customerId,
    $sub: subId,
    $tid: tenant.id,
  });
  logAudit(db, "tenant", tenant.id, "subscription_activated", {
    source: "checkout_confirm",
    session_id: sessionId,
    plan,
    status: nextStatus,
    trial_end: trialEnd,
    period_start: periodStart,
    period_end: periodEnd,
    stripe_customer_id: customerId,
    stripe_subscription_id: subId,
  });
  console.log(`[checkout] confirm: tenant ${tenant.id} → ${nextStatus} (plan=${plan ?? "unchanged"}, session ${sessionId})`);

  const wizard = findWizard(db, tenant.id);
  const updated = findTenantForUser(db, user.user_id)!;
  return c.json({
    status: nextStatus.toLowerCase(),
    tenant: {
      id: updated.id,
      name: updated.name,
      subscription_status: updated.subscription_status,
      subscription_plan: updated.subscription_plan ?? null,
      subscription_trial_end: updated.subscription_trial_end ?? null,
      subscription_period_start: updated.subscription_period_start,
      subscription_period_end: updated.subscription_period_end,
      payment_week_start_day: updated.payment_week_start_day,
      wizard_status: wizard?.status || "NOT_STARTED",
    },
  });
});

// ── Billing (Customer Portal + Cancel) ───────────────────
// All three endpoints sit under /api/billing/* which is in TENANT_DATA_PATHS,
// so they require auth + an ACTIVE/TRIAL tenant (requireTenant middleware).

/** Resolve the return origin for portal/cancel redirects — same origin the
 * request came from, falling back to the canonical live app URL. */
function billingReturnUrl(c: any, fallbackPath: string): string {
  const reqOrigin = c.req.header("Origin");
  const reqHost = c.req.header("Host");
  const base = reqOrigin && /^https?:\/\//.test(reqOrigin)
    ? reqOrigin.replace(/\/+$/, "")
    : reqHost && !reqHost.includes("localhost") && !reqHost.includes("127.0.0.1")
      ? `https://${reqHost}`
      : "https://cleartopay.ctonew.app";
  return `${base}${fallbackPath}`;
}

// POST /api/billing/portal — create a Stripe Customer Portal session so the
// tenant can update their payment method / manage their subscription in
// Stripe's hosted portal. Returns { url }. 409 when no Stripe customer exists.
app.post("/api/billing/portal", async (c) => {
  const user = c.get("user") as { user_id: number } | undefined;
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb();
  const tenant = findTenantForUser(db, user.user_id);
  if (!tenant) return c.json({ error: "No tenant found for this user. Please contact support." }, 403);
  if (!tenant.stripe_customer_id) {
    return c.json({
      error: "no_stripe_customer",
      message: "No payment method is on file for this account yet. Complete checkout first to manage billing.",
    }, 409);
  }
  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Stripe is not configured" }, 503);
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url: billingReturnUrl(c, "/app/billing"),
    });
    logAudit(db, "tenant", tenant.id, "billing_portal_created", { customer: tenant.stripe_customer_id });
    return c.json({ url: session.url });
  } catch (err) {
    console.error("[billing] portal session create failed:", err);
    return serverError(c, err);
  }
});

// POST /api/billing/cancel — set the Stripe subscription to cancel_at_period_end
// (the customer keeps access until the end of the current period) and flag the
// tenant so the UI can show "subscription ends on <date>". The
// customer.subscription.deleted webhook later flips the tenant to CANCELLED,
// after which the paywall gate blocks access.
app.post("/api/billing/cancel", async (c) => {
  const user = c.get("user") as { user_id: number } | undefined;
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb();
  const tenant = findTenantForUser(db, user.user_id);
  if (!tenant) return c.json({ error: "No tenant found for this user. Please contact support." }, 403);
  if (!tenant.stripe_subscription_id) {
    return c.json({
      error: "no_stripe_subscription",
      message: "No active Stripe subscription was found for this account.",
    }, 409);
  }
  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Stripe is not configured" }, 503);
  try {
    const sub = await stripe.subscriptions.update(tenant.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    const cancelAt = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString().slice(0, 10) : null;
    db.query(`
      UPDATE tenants
      SET cancel_at_period_end = 1,
          updated_at = datetime('now')
      WHERE id = $tid
    `).run({ $tid: tenant.id });
    logAudit(db, "tenant", tenant.id, "subscription_cancel_requested", {
      stripe_subscription_id: tenant.stripe_subscription_id,
      cancels_at: cancelAt,
    });
    console.log(`[billing] cancel: tenant ${tenant.id} → cancel_at_period_end (ends ${cancelAt ?? "?"})`);
    return c.json({ success: true, cancel_at_period_end: true, cancels_on: cancelAt });
  } catch (err) {
    console.error("[billing] cancel failed:", err);
    return serverError(c, err);
  }
});

// GET /api/billing/status — everything the billing UI needs: plan, status,
// next billing date (or trial end), cancellation state, and whether a Stripe
// customer is on file (for the portal button).
app.get("/api/billing/status", async (c) => {
  const user = c.get("user") as { user_id: number } | undefined;
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb();
  const tenant = findTenantForUser(db, user.user_id);
  if (!tenant) return c.json({ error: "No tenant found for this user. Please contact support." }, 403);
  const status = tenant.subscription_status || "PENDING";
  const trialEnd = tenant.subscription_trial_end ?? null;
  const periodEnd = tenant.subscription_period_end ?? null;
  return c.json({
    plan: tenant.subscription_plan ?? null,
    status,
    period_start: tenant.subscription_period_start ?? null,
    period_end: periodEnd,
    trial_end: trialEnd,
    next_billing_date: trialEnd && status === "TRIAL" ? trialEnd : periodEnd,
    cancel_at_period_end: tenant.cancel_at_period_end === 1,
    stripe_customer_present: Boolean(tenant.stripe_customer_id),
    stripe_subscription_present: Boolean(tenant.stripe_subscription_id),
  });
});

export default app;
