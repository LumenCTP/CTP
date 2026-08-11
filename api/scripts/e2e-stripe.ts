#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// E2E harness for Stripe Connect payouts — STRIPE TEST MODE ONLY.
//
// Run:  cd api && bun run scripts/e2e-stripe.ts
//
// Hard guards:
//   • REFUSES to run unless STRIPE_SECRET_KEY_TEST AND STRIPE_WEBHOOK_SECRET_TEST
//     are present (or at least one test credential — see "handler-only mode").
//     The error message names the exact env vars to add.
//   • REFUSES when the only key present is the LIVE one (never runs against
//     live keys; the live key is never read for API calls).
//   • Uses the test keys exclusively.
//
// Handler-only mode (ephemeral whsec): if STRIPE_WEBHOOK_SECRET_TEST is set but
// STRIPE_SECRET_KEY_TEST is NOT (e.g. a self-generated secret passed at
// runtime, NOT written to .env), the webhook-handler parts of checks 2, 3, 4,
// 5 and 6 still run against the local API; the parts that need the real Stripe
// test API (1, 5-account-link, 6-transfer-creation) are marked
// 'NEEDS TEST KEYS'. Nothing is ever faked.
//
// Exit code: 0 ONLY when all six checks PASS.
// ─────────────────────────────────────────────────────────────────────────────
import Stripe from "stripe";
import { createHmac } from "node:crypto";
import { getDb } from "../src/db";
import { calculateCommissions, MONTHLY_RATE } from "../src/commissions";

const WEBHOOK_URL = process.env.CTP_E2E_WEBHOOK_URL || "http://127.0.0.1:3001/api/webhooks/stripe";
const TEST_SUFFIX = `${Date.now()}`;
const CHECKOUT_EMAIL = `e2e-checkout-${TEST_SUFFIX}@cleartopay.test`;
const PARTNER_EMAIL = `e2e-partner-${TEST_SUFFIX}@cleartopay.test`;
const TENANT_NAME = `E2E Stripe Tenant ${TEST_SUFFIX}`;

type Status = "PASS" | "FAIL" | "NEEDS TEST KEYS";
const results: { check: number; name: string; status: Status; detail: string; sub?: { label: string; status: Status; detail: string }[] }[] = [];
let exitCode = 0;
function record(check: number, name: string, status: Status, detail: string, sub?: { label: string; status: Status; detail: string }[]) {
  results.push({ check, name, status, detail, sub });
  if (status === "FAIL") exitCode = 1;       // 1 = a check failed
  if (status === "NEEDS TEST KEYS") exitCode = 3; // 3 = not all six passed yet (missing test keys)
}
function fail(check: number, name: string, detail: string) { record(check, name, "FAIL", detail); }
function needsKeys(check: number, name: string, detail: string) { record(check, name, "NEEDS TEST KEYS", detail); }

// ── Environment / hard guards ─────────────────────────────────────────────
const liveKey = process.env.STRIPE_SECRET_KEY;
const testKey = process.env.STRIPE_SECRET_KEY_TEST;
const testWhsec = process.env.STRIPE_WEBHOOK_SECRET_TEST;

if (!testKey && !testWhsec) {
  console.error("┌────────────────────────────────────────────────────────────────────────┐");
  console.error("│ REFUSING TO RUN — no Stripe TEST credentials found.                    │");
  console.error("│                                                                        │");
  console.error("│ Add these two env vars (test-mode keys from the Stripe dashboard):     │");
  console.error("│   STRIPE_SECRET_KEY_TEST=sk_test_...                                   │");
  console.error("│   STRIPE_WEBHOOK_SECRET_TEST=whsec_...                                 │");
  console.error(`│ Live key detected: ${liveKey ? "YES — never used by this harness" : "no"}.                      │`);
  console.error("└────────────────────────────────────────────────────────────────────────┘");
  process.exit(2);
}
if (testKey && !testWhsec) {
  console.error("REFUSING TO RUN — STRIPE_SECRET_KEY_TEST is present but STRIPE_WEBHOOK_SECRET_TEST is not.");
  console.error("Add STRIPE_WEBHOOK_SECRET_TEST=whsec_... (test mode) to api/.env (or pass it in the environment).");
  process.exit(2);
}
const fullMode = !!testKey;
if (!fullMode) {
  console.warn("⚠  Handler-only mode: STRIPE_SECRET_KEY_TEST is absent. Checks that need the real Stripe test API will be marked 'NEEDS TEST KEYS'. Only the webhook-handler parts run (signed with the provided STRIPE_WEBHOOK_SECRET_TEST).");
}

// ── Stripe client (TEST KEY ONLY — live key is never touched) ─────────────
const stripe: Stripe | null = fullMode ? new Stripe(testKey as string) : null;

// ── Helpers ────────────────────────────────────────────────────────────────
function sign(payload: unknown, secret: string): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { body, signature: `t=${ts},v1=${sig}` };
}

async function postWebhook(payload: unknown, secret: string): Promise<{ status: number; json: any }> {
  const { body, signature } = sign(payload, secret);
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function apiHealthy(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:3001/api/health");
    return res.ok;
  } catch {
    return false;
  }
}

const db = getDb();
interface Seeded {
  tenantId: number;
  partnerId: number;
  userId: number;
  referralId: number;
}
function seedData(): Seeded {
  // Pre-clean any leftovers from previous runs of this harness. Order matters:
  // users.tenant_id → tenants AND tenants.owner_user_id → users form a circular
  // FK, so NULL the user→tenant link first, then delete tenants, then users.
  db.query("DELETE FROM payouts WHERE partner_id IN (SELECT id FROM partners WHERE email LIKE 'e2e-partner-%@cleartopay.test')").run();
  db.query("DELETE FROM commissions WHERE partner_id IN (SELECT id FROM partners WHERE email LIKE 'e2e-partner-%@cleartopay.test')").run();
  db.query("DELETE FROM referrals WHERE partner_id IN (SELECT id FROM partners WHERE email LIKE 'e2e-partner-%@cleartopay.test')").run();
  db.query("DELETE FROM partner_audit_log WHERE partner_id IN (SELECT id FROM partners WHERE email LIKE 'e2e-partner-%@cleartopay.test')").run();
  const leftoverUsers = db.query("SELECT id FROM users WHERE email LIKE 'e2e-%@cleartopay.test'").all() as { id: number }[];
  const leftoverTenants = db.query(`
    SELECT id FROM tenants
    WHERE name LIKE 'E2E Stripe Tenant %'
       OR owner_user_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%@cleartopay.test')
  `).all() as { id: number }[];
  db.query("UPDATE users SET tenant_id = NULL WHERE email LIKE 'e2e-%@cleartopay.test'").run();
  for (const t of leftoverTenants) {
    db.query("DELETE FROM setup_wizard WHERE tenant_id = $id").run({ $id: t.id });
    db.query("DELETE FROM tenants WHERE id = $id").run({ $id: t.id });
  }
  const leftoverPartners = db.query("SELECT id FROM partners WHERE email LIKE 'e2e-partner-%@cleartopay.test'").all() as { id: number }[];
  for (const p of leftoverPartners) db.query("DELETE FROM partners WHERE id = $id").run({ $id: p.id });
  for (const u of leftoverUsers) db.query("DELETE FROM users WHERE id = $id").run({ $id: u.id });

  const userRes = db.query("INSERT INTO users (full_name, company_name, email, password_hash, role) VALUES ($fn, $cn, $email, $pw, 'partner')").run({
    $fn: "E2E Partner", $cn: "E2E Partner Agency", $email: PARTNER_EMAIL, $pw: "e2e_placeholder",
  });
  const userId = Number(userRes.lastInsertRowid);
  const partnerRes = db.query(`
    INSERT INTO partners (user_id, first_name, last_name, company_name, email, partner_type, status, commission_percentage)
    VALUES ($uid, 'E2E', 'Partner', 'E2E Partner Agency', $email, 'agency', 'approved', 25.0)
  `).run({ $uid: userId, $email: PARTNER_EMAIL });
  const partnerId = Number(partnerRes.lastInsertRowid);
  const tenantRes = db.query("INSERT INTO tenants (name, owner_user_id, subscription_status, subscription_plan) VALUES ($name, $uid, 'TRIAL', NULL)").run({
    $name: TENANT_NAME, $uid: userId,
  });
  const tenantId = Number(tenantRes.lastInsertRowid);
  const refRes = db.query(`
    INSERT INTO referrals (partner_id, partner_code, referred_company, contact_email, customer_status, tenant_id)
    VALUES ($pid, 'E2ETEST', $company, $email, 'active', $tid)
  `).run({ $pid: partnerId, $company: TENANT_NAME, $email: PARTNER_EMAIL, $tid: tenantId });
  const referralId = Number(refRes.lastInsertRowid);
  return { tenantId, partnerId, userId, referralId };
}

function cleanup(seeded: Seeded | null, checkoutTenantId?: number) {
  try {
    // Break the circular users.tenant_id ↔ tenants.owner_user_id FK pair first.
    const tenantIds = [seeded?.tenantId, checkoutTenantId].filter((v): v is number => !!v);
    for (const tid of tenantIds) {
      db.query("UPDATE users SET tenant_id = NULL WHERE tenant_id = $tid").run({ $tid: tid });
    }
    if (seeded) {
      db.query("DELETE FROM payouts WHERE partner_id = $pid").run({ $pid: seeded.partnerId });
      db.query("DELETE FROM commissions WHERE partner_id = $pid").run({ $pid: seeded.partnerId });
      db.query("DELETE FROM referrals WHERE partner_id = $pid").run({ $pid: seeded.partnerId });
      db.query("DELETE FROM partner_audit_log WHERE partner_id = $pid").run({ $pid: seeded.partnerId });
      db.query("DELETE FROM setup_wizard WHERE tenant_id = $tid").run({ $tid: seeded.tenantId });
      db.query("DELETE FROM tenants WHERE id = $tid").run({ $tid: seeded.tenantId });
      db.query("DELETE FROM partners WHERE id = $pid").run({ $pid: seeded.partnerId });
      db.query("DELETE FROM users WHERE id = $uid").run({ $uid: seeded.userId });
    }
    if (checkoutTenantId) {
      db.query("DELETE FROM setup_wizard WHERE tenant_id = $tid").run({ $tid: checkoutTenantId });
      db.query("DELETE FROM tenants WHERE id = $tid").run({ $tid: checkoutTenantId });
    }
    db.query("DELETE FROM users WHERE email = $email").run({ $email: CHECKOUT_EMAIL });
    console.log("[e2e] Cleanup complete");
  } catch (err) {
    console.error("[e2e] Cleanup error (non-fatal):", String(err));
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log(" ClearToPay — Stripe Connect E2E (TEST MODE ONLY)");
  console.log(` Webhook: ${WEBHOOK_URL}`);
  console.log(` Mode: ${fullMode ? "FULL (test keys present)" : "HANDLER-ONLY (ephemeral whsec)"}`);
  console.log("════════════════════════════════════════════════════════════════");

  if (!(await apiHealthy())) {
    console.error("REFUSING TO RUN — the local API is not reachable at http://127.0.0.1:3001/api/health.");
    console.error("Start it first (see skill cleartopay-restart-api), then re-run this harness.");
    process.exit(2);
  }

  const seeded = seedData();
  let checkoutTenantId: number | undefined;

  try {
    // ── CHECK 1: Checkout session creation (real Stripe test API) ──────────
    {
      const name = "Checkout Session + test product/price (test mode)";
      if (!stripe) {
        needsKeys(1, name, "STRIPE_SECRET_KEY_TEST not present — cannot create a real test Checkout Session");
      } else {
        try {
          const product = await stripe.products.create({ name: `E2E Monthly Plan ${TEST_SUFFIX}`, metadata: { plan: "monthly" } });
          const price = await stripe.prices.create({
            product: product.id,
            unit_amount: 14900,
            currency: "usd",
            recurring: { interval: "month" },
            metadata: { plan: "monthly" },
          });
          const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            line_items: [{ price: price.id, quantity: 1 }],
            success_url: "https://cleartopay.ctonew.app/app/setup?e2e=success",
            cancel_url: "https://cleartopay.ctonew.app/get-started?e2e=cancel",
            metadata: { client_email: CHECKOUT_EMAIL, plan: "monthly" },
          });
          if (session.url && session.id.startsWith("cs_test_")) {
            record(1, name, "PASS", `product ${product.id}, price ${price.id}, session ${session.id} (url present)`);
          } else {
            fail(1, name, `session created but no url (id=${session.id})`);
          }
        } catch (err: any) {
          fail(1, name, `Stripe API error: ${err?.message ?? String(err)}`);
        }
      }
    }

    // ── CHECK 2: checkout.session.completed webhook → 2xx ──────────────────
    {
      const name = "Webhook 2xx (checkout.session.completed, HMAC-verified)";
      const session = {
        id: `cs_e2e_${TEST_SUFFIX}`,
        customer: `cus_e2e_${TEST_SUFFIX}`,
        customer_details: { email: CHECKOUT_EMAIL, name: "E2E Checkout User" },
        metadata: { client_email: CHECKOUT_EMAIL, plan: "monthly" },
        subscription: `sub_e2e_checkout_${TEST_SUFFIX}`,
      };
      const event = { id: `evt_e2e_checkout_${TEST_SUFFIX}`, type: "checkout.session.completed", data: { object: session } };
      const res = await postWebhook(event, testWhsec as string);
      const ok = res.status >= 200 && res.status < 300 && (res.json?.success === true || res.json?.received === true);
      if (ok) {
        checkoutTenantId = res.json?.tenant_id;
        record(2, name, "PASS", `HTTP ${res.status}; tenant created: ${checkoutTenantId ?? "?"}`);
      } else {
        fail(2, name, `HTTP ${res.status} body=${JSON.stringify(res.json)} (check the API has STRIPE_WEBHOOK_SECRET_TEST=${(testWhsec as string).slice(0, 8)}… set)`);
      }
    }

    // ── CHECK 3: customer.subscription.created recorded on tenant ──────────
    {
      const name = "Subscription recorded (plan/status/stripe_subscription_id)";
      const sub = {
        id: `sub_e2e_${TEST_SUFFIX}`,
        customer: `cus_e2e_${TEST_SUFFIX}`,
        status: "active",
        metadata: { tenant_id: String(seeded.tenantId), plan: "monthly" },
        items: { data: [{ price: { id: `price_e2e_${TEST_SUFFIX}`, metadata: { plan: "monthly" } } }] },
      };
      const event = { id: `evt_e2e_sub_${TEST_SUFFIX}`, type: "customer.subscription.created", data: { object: sub } };
      const res = await postWebhook(event, testWhsec as string);
      const row = db.query("SELECT subscription_plan, subscription_status, stripe_subscription_id, stripe_customer_id FROM tenants WHERE id = $id").get({ $id: seeded.tenantId }) as
        { subscription_plan: string | null; subscription_status: string | null; stripe_subscription_id: string | null; stripe_customer_id: string | null } | undefined;
      const ok = res.status >= 200 && res.status < 300
        && row?.subscription_plan === "monthly"
        && row?.subscription_status === "ACTIVE"
        && row?.stripe_subscription_id === `sub_e2e_${TEST_SUFFIX}`
        && row?.stripe_customer_id === `cus_e2e_${TEST_SUFFIX}`;
      if (ok) {
        record(3, name, "PASS", `HTTP ${res.status}; tenant ${seeded.tenantId} → plan=monthly status=ACTIVE sub=${row?.stripe_subscription_id}`);
      } else {
        fail(3, name, `HTTP ${res.status} body=${JSON.stringify(res.json)}; DB row=${JSON.stringify(row)}`);
      }
    }

    // ── CHECK 4: commission auto-creation (idempotent) ─────────────────────
    {
      const name = "Commission auto-creation ($149/mo × 25%) + idempotency";
      const run1 = calculateCommissions(new Date());
      const row = db.query(`
        SELECT commission_amount, eligible_revenue, commission_percentage, status
        FROM commissions WHERE partner_id = $pid AND tenant_id = $tid AND billing_period = $period
      `).get({ $pid: seeded.partnerId, $tid: seeded.tenantId, $period: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}` }) as
        { commission_amount: number; eligible_revenue: number; commission_percentage: number; status: string } | undefined;
      const expected = Math.round(MONTHLY_RATE * 0.25 * 100) / 100;
      const countBefore = (db.query("SELECT COUNT(*) AS c FROM commissions WHERE partner_id = $pid AND tenant_id = $tid").get({ $pid: seeded.partnerId, $tid: seeded.tenantId }) as { c: number }).c;
      const run2 = calculateCommissions(new Date());
      const countAfter = (db.query("SELECT COUNT(*) AS c FROM commissions WHERE partner_id = $pid AND tenant_id = $tid").get({ $pid: seeded.partnerId, $tid: seeded.tenantId }) as { c: number }).c;
      const ok = !!row && Math.abs(Number(row.commission_amount) - expected) < 0.01
        && Number(row.eligible_revenue) === MONTHLY_RATE
        && row.status === "approved"
        && countBefore === countAfter && countAfter === 1;
      if (ok) {
        record(4, name, "PASS", `amount $${row?.commission_amount} (expected $${expected}); run1 created=${run1.created}; run2 added 0 new rows for this pair (idempotent)`);
      } else {
        fail(4, name, `row=${JSON.stringify(row)} expected=$${expected} run1=${JSON.stringify(run1)} run2=${JSON.stringify(run2)} countBefore=${countBefore} countAfter=${countAfter}`);
      }
    }

    // ── CHECK 5: Connect Express onboarding + account.updated ──────────────
    {
      const name = "Connect Express onboarding (account + link) and account.updated sync";
      let accountId: string | null = null;
      const subResults: { label: string; status: Status; detail: string }[] = [];
      if (stripe) {
        try {
          const account = await stripe.accounts.create({
            type: "express",
            email: PARTNER_EMAIL,
            external_account: { object: "bank_account", country: "US", currency: "usd", routing_number: "110000000", account_number: "000123456789" },
            metadata: { partner_id: String(seeded.partnerId) },
          });
          accountId = account.id;
          db.query("UPDATE partners SET stripe_account_id = $aid, updated_at = datetime('now') WHERE id = $id").run({ $aid: accountId, $id: seeded.partnerId });
          const link = await stripe.accountLinks.create({
            account: accountId,
            type: "account_onboarding",
            refresh_url: "https://cleartopay.ctonew.app/app/partner/dashboard",
            return_url: "https://cleartopay.ctonew.app/app/partner/dashboard",
          });
          if (link.url && account.id.startsWith("acct_")) {
            subResults.push({ label: "Express account + account link", status: "PASS", detail: `account ${account.id}, link url present` });
          } else {
            subResults.push({ label: "Express account + account link", status: "FAIL", detail: `account ${account.id}, link.url=${link.url ? "missing" : "missing"}` });
          }
        } catch (err: any) {
          subResults.push({ label: "Express account + account link", status: "FAIL", detail: `Stripe API error: ${err?.message ?? String(err)}` });
        }
      }
      // account.updated simulation (handler part — runs in both modes).
      const simAccountId = accountId ?? `acct_e2e_${TEST_SUFFIX}`;
      db.query("UPDATE partners SET stripe_account_id = $aid, updated_at = datetime('now') WHERE id = $id").run({ $aid: simAccountId, $id: seeded.partnerId });
      const accountObj = {
        id: simAccountId,
        object: "account",
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { currently_due: [], eventually_due: [], disabled_reason: null },
        metadata: { partner_id: String(seeded.partnerId) },
      };
      const event = { id: `evt_e2e_acct_${TEST_SUFFIX}`, type: "account.updated", data: { object: accountObj } };
      const res = await postWebhook(event, testWhsec as string);
      const p = db.query("SELECT stripe_account_id, stripe_details_submitted, stripe_currently_due, stripe_payouts_enabled FROM partners WHERE id = $id").get({ $id: seeded.partnerId }) as
        { stripe_account_id: string | null; stripe_details_submitted: number; stripe_currently_due: string | null; stripe_payouts_enabled: number } | undefined;
      const simOk = res.status >= 200 && res.status < 300
        && p?.stripe_account_id === simAccountId
        && Number(p?.stripe_details_submitted) === 1
        && Number(p?.stripe_payouts_enabled) === 1
        && (() => { try { const arr = JSON.parse(p?.stripe_currently_due ?? "[]"); return Array.isArray(arr) && arr.length === 0; } catch { return false; } })();
      subResults.push({ label: "account.updated webhook sync", status: simOk ? "PASS" : "FAIL", detail: simOk ? `partner stored: details_submitted=1 payouts_enabled=1 currently_due=[]` : `HTTP ${res.status} body=${JSON.stringify(res.json)} DB=${JSON.stringify(p)}` });

      if (!stripe) {
        record(5, name, "NEEDS TEST KEYS", "Express account/account-link creation requires STRIPE_SECRET_KEY_TEST (see sub-results)", subResults);
      } else if (subResults.some((s) => s.status === "FAIL")) {
        record(5, name, "FAIL", "one or more sub-checks failed", subResults);
      } else {
        record(5, name, "PASS", "account + link + webhook sync all passed", subResults);
      }
    }

    // ── CHECK 6: transfer + transfer.paid ──────────────────────────────────
    {
      const name = "Stripe Connect transfer + transfer.paid finalization";
      const payoutId = Number(db.query(`
        INSERT INTO payouts (partner_id, amount, status, notes) VALUES ($pid, 25.00, 'pending', 'e2e transfer check')
      `).run({ $pid: seeded.partnerId }).lastInsertRowid);
      const subResults: { label: string; status: Status; detail: string }[] = [];
      let transferId: string | null = null;

      if (stripe) {
        try {
          const partner = db.query("SELECT stripe_account_id FROM partners WHERE id = $id").get({ $id: seeded.partnerId }) as { stripe_account_id: string | null };
          if (!partner?.stripe_account_id) throw new Error("no connected account id stored on the partner");
          const transfer = await stripe.transfers.create({
            amount: 2500,
            currency: "usd",
            destination: partner.stripe_account_id,
            metadata: { payout_id: String(payoutId), partner_id: String(seeded.partnerId) },
          }, { idempotencyKey: `ctp-e2e-${TEST_SUFFIX}` });
          transferId = transfer.id;
          if (Number(transfer.amount) === 2500 && transfer.currency === "usd") {
            subResults.push({ label: "transfer.create", status: "PASS", detail: `transfer ${transfer.id} amount ${transfer.amount} ${transfer.currency} (idempotency key used)` });
          } else {
            subResults.push({ label: "transfer.create", status: "FAIL", detail: `transfer ${transfer.id} amount=${transfer.amount} currency=${transfer.currency} (expected 2500 usd)` });
          }
        } catch (err: any) {
          subResults.push({ label: "transfer.create", status: "FAIL", detail: `Stripe API error: ${err?.message ?? String(err)}` });
        }
      }

      // transfer.paid simulation (handler part — runs in both modes).
      const simTransferId = transferId ?? `tr_e2e_${TEST_SUFFIX}`;
      const transferObj = { id: simTransferId, object: "transfer", amount: 2500, currency: "usd", created: Math.floor(Date.now() / 1000), metadata: { payout_id: String(payoutId), partner_id: String(seeded.partnerId) } };
      const event = { id: `evt_e2e_tr_${TEST_SUFFIX}`, type: "transfer.paid", data: { object: transferObj } };
      const res = await postWebhook(event, testWhsec as string);
      const pay = db.query("SELECT status, transaction_ref, payment_method, payment_date FROM payouts WHERE id = $id").get({ $id: payoutId }) as
        { status: string; transaction_ref: string | null; payment_method: string | null; payment_date: string | null } | undefined;
      const simOk = res.status >= 200 && res.status < 300
        && pay?.status === "paid"
        && pay?.transaction_ref === simTransferId
        && pay?.payment_method === "stripe_connect"
        && !!pay?.payment_date;
      subResults.push({ label: "transfer.paid webhook", status: simOk ? "PASS" : "FAIL", detail: simOk ? `payout ${payoutId} → paid (ref ${simTransferId})` : `HTTP ${res.status} body=${JSON.stringify(res.json)} DB=${JSON.stringify(pay)}` });

      if (!stripe) {
        record(6, name, "NEEDS TEST KEYS", "transfer.create requires STRIPE_SECRET_KEY_TEST (see sub-results)", subResults);
      } else if (subResults.some((s) => s.status === "FAIL")) {
        record(6, name, "FAIL", "one or more sub-checks failed", subResults);
      } else {
        record(6, name, "PASS", "transfer created + transfer.paid finalized the payout", subResults);
      }
    }
  } finally {
    cleanup(seeded, checkoutTenantId);
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("─────────────────────────────── REPORT ───────────────────────────────");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⏸";
    console.log(` ${icon} Check ${r.check}: ${r.name} — ${r.status}`);
    console.log(`      ${r.detail}`);
    for (const s of r.sub ?? []) {
      const si = s.status === "PASS" ? "✅" : s.status === "FAIL" ? "❌" : "⏸";
      console.log(`      ${si}   ${s.label}: ${s.status} — ${s.detail}`);
    }
  }
  console.log("──────────────────────────────────────────────────────────────────────");
  const passed = results.filter((r) => r.status === "PASS").length;
  const needKeys = results.filter((r) => r.status === "NEEDS TEST KEYS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`Result: ${passed} passed, ${needKeys} need test keys, ${failed} failed (of ${results.length} checks)`);
  if (exitCode === 0) {
    console.log("ALL SIX CHECKS PASSED IN TEST MODE ✅ — real payouts may now be enabled with STRIPE_PAYOUTS_ENABLED=true.");
  } else if (needKeys > 0 && failed === 0) {
    console.log("Handler-level checks passed; full E2E awaits STRIPE_SECRET_KEY_TEST (real test-mode API calls). See the lead's env checklist.");
  } else {
    console.log("Some checks FAILED — see details above.");
  }

  const summary = {
    mode: fullMode ? "full" : "handler-only",
    webhook_url: WEBHOOK_URL,
    checks: results.map((r) => ({ check: r.check, name: r.name, status: r.status, detail: r.detail, sub: r.sub })),
    passed,
    need_test_keys: needKeys,
    failed,
    exit_code: exitCode,
  };
  console.log("\nJSON SUMMARY:\n" + JSON.stringify(summary, null, 2));
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[e2e] Unhandled harness error:", err);
  process.exit(1);
});
