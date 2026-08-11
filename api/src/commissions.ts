// ── Partner Commission + Monthly Payout Engine ─────────────────────────────
// Delegation A: automated commission auto-creation (daily) and monthly payout
// runs (end-of-month). Money is NEVER moved here — payouts are created with
// status 'pending' and attemptPayoutTransfer() is the seam where delegation B
// will wire the real Stripe Connect transfer. Without STRIPE_SECRET_KEY the
// seam logs "transfer deferred" and leaves the payout status untouched.
import { getDb } from "./db";
import { sendEmail, buildPartnerPayoutEmail } from "./email";
import { logAudit } from "./middleware";

// ── Revenue / commission constants ────────────────────────────────────────
// Source of truth: api/src/routes/partners.ts (/api/admin/cashflow uses the
// same numbers). Keep these in sync if pricing changes.
export const MONTHLY_RATE = 149; // monthly plan, $/month
export const ANNUAL_MONTHLY_EQUIVALENT = 100; // annual plan, monthly-equivalent ($1,200/yr)
export const DEFAULT_COMMISSION_PERCENT = 25.0; // used when partner row has NULL

// ── Helpers ───────────────────────────────────────────────────────────────

/** Current billing-period key, e.g. "2026-08" (UTC). */
export function billingPeriodKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Mirrors logPartnerAudit() in api/src/routes/partners.ts (same columns and
 * defaults) but lives here so the scheduler/commission engine does not have to
 * import the whole partner Hono router (which would create a circular import
 * with the admin trigger endpoints below).
 */
function logPartnerAudit(
  db: ReturnType<typeof getDb>,
  partnerId: number,
  action: string,
  changes: Record<string, unknown> | null = null,
  reason: string | null = null,
  performedBy: string = "system",
): void {
  db.query(
    "INSERT INTO partner_audit_log (partner_id, action, changes, reason, performed_by) VALUES ($pid, $action, $changes, $reason, $by)",
  ).run({
    $pid: partnerId,
    $action: action,
    $changes: changes ? JSON.stringify(changes) : null,
    $reason: reason,
    $by: performedBy,
  });
}

// ── 1. Commission auto-creation (daily) ───────────────────────────────────

export interface CommissionRunResult {
  created: number;
  skipped: number; // idempotent: commission already exists for the period
  errors: string[]; // per-tenant failures (job continues past them)
}

/**
 * For every ACTIVE tenant whose referral row is linked to an APPROVED partner
 * (referrals.tenant_id set), create the commission for the CURRENT billing
 * period if none exists. Idempotency key: (partner_id, tenant_id,
 * billing_period) — enforced by a check-then-insert plus a UNIQUE index
 * (uq_commissions_partner_tenant_period, see db.ts).
 *
 * Eligible revenue: $149/mo (monthly plan) or $100/mo monthly-equivalent
 * (annual plan). Commission percent: partner.commission_percentage, default
 * 25%. Commissions are created with status 'approved' and audit-logged.
 * One tenant failing never aborts the run.
 */
export function calculateCommissions(now: Date = new Date()): CommissionRunResult {
  const db = getDb();
  const period = billingPeriodKey(now);
  const result: CommissionRunResult = { created: 0, skipped: 0, errors: [] };

  const rows = db.query(`
    SELECT t.id AS tenant_id,
           t.subscription_plan,
           r.id AS referral_id,
           r.partner_id,
           COALESCE(p.commission_percentage, $default_pct) AS commission_percentage
    FROM tenants t
    JOIN referrals r ON r.tenant_id = t.id
    JOIN partners p ON p.id = r.partner_id
    WHERE UPPER(t.subscription_status) = 'ACTIVE'
      AND p.status = 'approved'
  `).all({ $default_pct: DEFAULT_COMMISSION_PERCENT }) as Array<{
    tenant_id: number;
    subscription_plan: string | null;
    referral_id: number;
    partner_id: number;
    commission_percentage: number;
  }>;

  if (rows.length === 0) {
    console.log(`[commissions] ${period}: no ACTIVE tenants with an approved-partner referral — nothing to do`);
    return result;
  }

  for (const row of rows) {
    try {
      const existing = db.query(
        `SELECT id FROM commissions WHERE partner_id = $pid AND tenant_id = $tid AND billing_period = $period`,
      ).get({ $pid: row.partner_id, $tid: row.tenant_id, $period: period });
      if (existing) {
        result.skipped++;
        continue;
      }
      const plan = (row.subscription_plan || "").toLowerCase();
      const revenue = plan === "annual" ? ANNUAL_MONTHLY_EQUIVALENT : MONTHLY_RATE;
      const pct = Number(row.commission_percentage);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        result.errors.push(`tenant ${row.tenant_id}: invalid commission_percentage ${row.commission_percentage}`);
        continue;
      }
      const amount = Math.round(revenue * (pct / 100) * 100) / 100;
      const ins = db.query(`
        INSERT INTO commissions (partner_id, referral_id, tenant_id, billing_period, eligible_revenue, commission_percentage, commission_amount, status)
        VALUES ($pid, $ref_id, $tid, $period, $revenue, $pct, $amount, 'approved')
      `).run({
        $pid: row.partner_id,
        $ref_id: row.referral_id,
        $tid: row.tenant_id,
        $period: period,
        $revenue: revenue,
        $pct: pct,
        $amount: amount,
      });
      const commissionId = Number(ins.lastInsertRowid);
      logAudit(db, "commission", commissionId, "commission_auto_created", {
        partner_id: row.partner_id,
        tenant_id: row.tenant_id,
        referral_id: row.referral_id,
        billing_period: period,
        eligible_revenue: revenue,
        commission_percentage: pct,
        commission_amount: amount,
        plan: plan || "monthly",
      });
      logPartnerAudit(db, row.partner_id, "commission_auto_created", {
        commission_id: commissionId,
        tenant_id: row.tenant_id,
        billing_period: period,
        eligible_revenue: revenue,
        commission_percentage: pct,
        commission_amount: amount,
      }, null, "system");
      result.created++;
      console.log(`[commissions] ${period}: created commission #${commissionId} partner ${row.partner_id} tenant ${row.tenant_id} amount $${amount}`);
    } catch (err) {
      result.errors.push(`tenant ${row.tenant_id}: ${String(err)}`);
      console.error(`[commissions] Error creating commission for tenant ${row.tenant_id}:`, err);
    }
  }
  return result;
}

// ── 2. Monthly payout run (end-of-month) ──────────────────────────────────

// Once-per-month guard, mirroring scheduler.ts lastMonthlyCheckDate style:
// module-level date key set when the payout run fires, so repeated ticks in
// the same calendar month do not re-run. (A process restart resets this, but
// the per-partner DB guard below plus the commission status flip keep the run
// idempotent regardless.)
let lastPayoutRunMonth: string | null = null;

export interface PayoutRunResult {
  run: boolean; // false when the day-of-month / once-per-month gate blocked the run
  month: string;
  payoutsCreated: number;
  commissionsPaid: number;
  emailsQueued: number;
  transfersDeferred: number;
  errors: string[];
}

/**
 * End-of-month payout run. Fires on day 30 OR the last day of the month
 * (handles Feb 28/29 and 30/31-day months) at most once per calendar month.
 * For each partner with APPROVED commissions: aggregate the sum, create ONE
 * payout (status 'pending', payment_date = run date), mark those commissions
 * 'paid' + set payout_id, audit-log, email the partner (honest "being
 * processed" wording — money is NOT transferred here), then call
 * attemptPayoutTransfer() which no-ops without a Stripe key.
 */
export function runPartnerPayouts(now: Date = new Date()): PayoutRunResult {
  const db = getDb();
  const month = billingPeriodKey(now);
  const day = now.getUTCDate();
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const result: PayoutRunResult = {
    run: false,
    month,
    payoutsCreated: 0,
    commissionsPaid: 0,
    emailsQueued: 0,
    transfersDeferred: 0,
    errors: [],
  };

  // Gate 1: only day 30 or the last day of the month.
  if (day !== 30 && day !== lastDay) {
    console.log(`[payouts] ${month}-${String(day).padStart(2, "0")}: not a payout day (day 30 or last day ${lastDay}) — skipping`);
    return result;
  }
  // Gate 2: at most once per calendar month (process-level, lastMonthlyCheckDate style).
  if (lastPayoutRunMonth === month) {
    console.log(`[payouts] ${month}: payout run already executed this month — skipping`);
    return result;
  }
  lastPayoutRunMonth = month;
  result.run = true;

  const runDate = now.toISOString().slice(0, 10);
  console.log(`[payouts] ${month}: payout run started (run date ${runDate})`);

  // Aggregate APPROVED commissions per partner.
  const partners = db.query(`
    SELECT c.partner_id,
           p.first_name || ' ' || p.last_name AS partner_name,
           p.email,
           SUM(c.commission_amount) AS total_amount,
           COUNT(c.id) AS commission_count
    FROM commissions c
    JOIN partners p ON p.id = c.partner_id
    WHERE c.status = 'approved'
    GROUP BY c.partner_id
    HAVING SUM(c.commission_amount) > 0
  `).all() as Array<{
    partner_id: number;
    partner_name: string;
    email: string;
    total_amount: number;
    commission_count: number;
  }>;

  if (partners.length === 0) {
    console.log(`[payouts] ${month}: no partners with approved commissions — nothing to pay out`);
    return result;
  }

  for (const partner of partners) {
    try {
      // Gate 3 (per-partner, DB-level): no payout already exists for this
      // partner in the current calendar month. Survives process restarts that
      // reset the module guard above.
      const existingPayout = db.query(
        `SELECT id FROM payouts WHERE partner_id = $pid AND substr(payment_date, 1, 7) = $month`,
      ).get({ $pid: partner.partner_id, $month: month });
      if (existingPayout) {
        console.log(`[payouts] ${month}: payout already exists for partner ${partner.partner_id} — skipping`);
        continue;
      }

      const amount = Math.round(Number(partner.total_amount) * 100) / 100;
      const payoutRun = db.transaction((): { payoutId: number; linked: number } => {
        const ins = db.query(`
          INSERT INTO payouts (partner_id, amount, status, payment_date, payment_method, transaction_ref, notes)
          VALUES ($pid, $amount, 'pending', $date, NULL, NULL, $notes)
        `).run({
          $pid: partner.partner_id,
          $amount: amount,
          $date: runDate,
          $notes: `Auto-generated monthly payout run (${month})`,
        });
        const payoutId = Number(ins.lastInsertRowid);
        const updated = db.query(`
          UPDATE commissions SET status = 'paid', payout_id = $payout_id
          WHERE partner_id = $pid AND status = 'approved'
        `).run({ $payout_id: payoutId, $pid: partner.partner_id });
        logAudit(db, "payout", payoutId, "payout_auto_created", {
          partner_id: partner.partner_id,
          amount,
          month,
          commissions_linked: Number(updated.changes),
        });
        logPartnerAudit(db, partner.partner_id, "payout_created", {
          payout_id: payoutId,
          amount,
          month,
          commissions_linked: Number(updated.changes),
        }, null, "system");
        return { payoutId, linked: Number(updated.changes) };
      });
      const { payoutId, linked } = payoutRun();
      result.payoutsCreated++;
      result.commissionsPaid += linked;

      // Honest partner email: payment is being PROCESSED, not paid. Money is
      // only actually transferred in delegation B (Stripe Connect).
      const periodLabel = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      const subject = `Your ClearToPay partner payout for ${periodLabel} is being processed`;
      const body = buildPartnerPayoutEmail(partner.partner_name, amount, periodLabel);
      sendEmail([partner.email], subject, body, undefined, undefined, "partner_payout");
      result.emailsQueued++;
      console.log(`[payouts] ${month}: payout created for partner ${partner.partner_id} (${partner.partner_name}) — $${amount} (${linked} commission(s)), email queued, transfer attempted next`);

      // Seam for delegation B: real Stripe Connect transfer lives here.
      attemptPayoutTransfer(payoutId);
    } catch (err) {
      result.errors.push(`partner ${partner.partner_id}: ${String(err)}`);
      console.error(`[payouts] Error processing payout for partner ${partner.partner_id}:`, err);
    }
  }
  return result;
}

// ── 3. Transfer seam (delegation B hooks in here) ─────────────────────────

/**
 * Attempts to transfer a payout to the partner. THIS DELEGATION DOES NOT MOVE
 * MONEY: without STRIPE_SECRET_KEY it logs that the transfer is deferred and
 * returns WITHOUT changing the payout status (stays 'pending'). Delegation B
 * implements the real Stripe Connect transfer in the body below and then
 * marks the payout 'paid' with payment_method / transaction_ref populated.
 */
export function attemptPayoutTransfer(payoutId: number): void {
  const db = getDb();
  const payout = db.query("SELECT id, partner_id, amount, status FROM payouts WHERE id = $id").get({ $id: payoutId }) as
    | { id: number; partner_id: number; amount: number; status: string }
    | undefined;
  if (!payout) {
    console.error(`[payouts] attemptPayoutTransfer: payout ${payoutId} not found`);
    return;
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey || stripeKey.trim() === "") {
    console.log(
      `[payouts] Stripe not configured — transfer deferred for payout ${payout.id} (partner ${payout.partner_id}, amount $${payout.amount}); status stays '${payout.status}'`,
    );
    return;
  }
  // TODO (delegation B): real Stripe Connect transfer implementation here.
  // On success: update payouts SET status='paid', payment_method='stripe_connect',
  // transaction_ref=<transfer id>, then audit-log. Never fabricate a transfer.
  console.log(`[payouts] attemptPayoutTransfer(${payoutId}): Stripe key present — transfer path not implemented yet (delegation B); status unchanged`);
}
