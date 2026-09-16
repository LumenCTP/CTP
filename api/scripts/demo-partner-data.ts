/**
 * Demo PARTNER data — the canonical 10 fake referral clients + realistic 25%
 * commission/payout history used to showcase the partner dashboard.
 *
 * Shared by two entry points so the demo stays consistent:
 *   - seed-demo-partner-data.ts   (re-seed an EXISTING demo partner in place)
 *   - demo-seed-accounts.ts       (create a brand-new isolated demo partner)
 *
 * Everything here is clearly fake ("Demo ..." names, @demo-*.com emails) and
 * is written as sample/demo rows only — it must never be mistaken for real
 * client or real money data. It only ever touches the partner id passed in.
 */
import type { Database } from "bun:sqlite";

const PCT = 25.0;

// Monthly-equivalent eligible revenue by plan (matches api/src/commissions.ts:
// monthly → $149/mo, annual → $100/mo monthly-equivalent of $1,200/yr).
const MONTHLY_REV = 149;
const ANNUAL_REV = 100;

// Offset helper: ISO date N days from today (YYYY-MM-DD).
function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthOf(dateStr: string): string {
  return dateStr.slice(0, 7); // YYYY-MM
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

interface ReferralSpec {
  slug: string;
  company: string;
  contact: string;
  email: string;
  phone: string;
  status: string;
  plan: string | null;
  amount: number | null;
  refDays: number;
  signDays: number | null;
}

// Exactly 10 clearly-fake referral clients. Status mix: 5 active, 1 trial,
// 3 lead, 1 cancelled.
const REFERRALS: ReferralSpec[] = [
  { slug: "framing", company: "Demo Framing LLC", contact: "Frank Demo", email: "frank@demo-framing.com", phone: "(555) 010-0101", status: "active", plan: "Annual", amount: 1200, refDays: 190, signDays: 180 },
  { slug: "glass", company: "Demo Glass Co", contact: "Gloria Demo", email: "gloria@demo-glass.com", phone: "(555) 010-0102", status: "active", plan: "Monthly", amount: 149, refDays: 150, signDays: 142 },
  { slug: "excavation", company: "Demo Excavation Services", contact: "Erin Demo", email: "erin@demo-excavation.com", phone: "(555) 010-0103", status: "active", plan: "Monthly", amount: 149, refDays: 120, signDays: 112 },
  { slug: "hvac", company: "Demo HVAC Solutions Inc", contact: "Hank Demo", email: "hank@demo-hvac.com", phone: "(555) 010-0104", status: "active", plan: "Monthly", amount: 149, refDays: 100, signDays: 93 },
  { slug: "painting", company: "Demo Painting & Finishing Co", contact: "Paula Demo", email: "paula@demo-painting.com", phone: "(555) 010-0105", status: "active", plan: "Annual", amount: 1200, refDays: 75, signDays: 67 },
  { slug: "roofing", company: "Demo Roofing & Gutters LLC", contact: "Ray Demo", email: "ray@demo-roofing.com", phone: "(555) 010-0106", status: "trial", plan: "Monthly", amount: 149, refDays: 20, signDays: 14 },
  { slug: "landscaping", company: "Demo Landscaping Services", contact: "Lena Demo", email: "lena@demo-landscaping.com", phone: "(555) 010-0107", status: "lead", plan: null, amount: null, refDays: 9, signDays: null },
  { slug: "electrical", company: "Demo Electrical Contractors", contact: "Eli Demo", email: "eli@demo-electrical.com", phone: "(555) 010-0108", status: "lead", plan: null, amount: null, refDays: 6, signDays: null },
  { slug: "masonry", company: "Demo Masonry Works", contact: "Manny Demo", email: "manny@demo-masonry.com", phone: "(555) 010-0109", status: "lead", plan: null, amount: null, refDays: 3, signDays: null },
  { slug: "security", company: "Demo Security Systems Co", contact: "Sam Demo", email: "sam@demo-security.com", phone: "(555) 010-0110", status: "cancelled", plan: "Monthly", amount: 149, refDays: 200, signDays: 195 },
];

// Commission history per referral slug. Each entry: status + earned_date offset
// (days). 25% of monthly-equivalent revenue: annual → $25/mo, monthly → $37.25/mo.
// paid rows link to the single historical payout; approved+scheduled form the
// "next expected payout"; pending accrues but isn't yet approved for payout.
interface CommissionSpec {
  ref: string;
  status: "paid" | "approved" | "scheduled" | "pending";
  offset: number; // earned_date = today + offset days
}

const COMMISSIONS: CommissionSpec[] = [
  // framing (annual → $25/mo): 5 paid past months + 1 approved last month
  { ref: "framing", status: "paid", offset: -180 },
  { ref: "framing", status: "paid", offset: -150 },
  { ref: "framing", status: "paid", offset: -120 },
  { ref: "framing", status: "paid", offset: -90 },
  { ref: "framing", status: "paid", offset: -60 },
  { ref: "framing", status: "approved", offset: -30 },
  // glass (monthly → $37.25/mo): 3 paid + 1 approved
  { ref: "glass", status: "paid", offset: -120 },
  { ref: "glass", status: "paid", offset: -90 },
  { ref: "glass", status: "paid", offset: -60 },
  { ref: "glass", status: "approved", offset: -30 },
  // excavation (monthly → $37.25/mo): 2 paid + 1 approved + 1 scheduled
  { ref: "excavation", status: "paid", offset: -90 },
  { ref: "excavation", status: "paid", offset: -60 },
  { ref: "excavation", status: "approved", offset: -30 },
  { ref: "excavation", status: "scheduled", offset: 0 },
  // hvac (monthly → $37.25/mo): 2 paid + 1 pending (current, not yet approved)
  { ref: "hvac", status: "paid", offset: -90 },
  { ref: "hvac", status: "paid", offset: -60 },
  { ref: "hvac", status: "pending", offset: 0 },
  // painting (annual → $25/mo): 3 paid + 1 approved current month
  { ref: "painting", status: "paid", offset: -120 },
  { ref: "painting", status: "paid", offset: -90 },
  { ref: "painting", status: "paid", offset: -60 },
  { ref: "painting", status: "approved", offset: 0 },
];

const NOTE = "Sample/demo data — not a real client and not real money.";

export interface DemoPartnerSeedResult {
  partner_id: number;
  referral_count: number;
  commission_count: number;
  paid_total: number;
  next_expected_payout: number;
  payout_id: number | null;
}

/**
 * Reset the given partner's demo referrals/commissions/payouts and write the
 * canonical 10-referral demo dataset. Deletes only rows whose partner_id
 * matches; never touches other partners or any real client data.
 */
export function seedDemoPartnerData(db: Database, partnerId: number, code: string): DemoPartnerSeedResult {
  // 1. Clear prior demo rows for THIS partner (children before parents).
  db.query("DELETE FROM commissions WHERE partner_id = $p").run({ $p: partnerId });
  db.query("DELETE FROM payouts WHERE partner_id = $p").run({ $p: partnerId });
  db.query("DELETE FROM referrals WHERE partner_id = $p").run({ $p: partnerId });

  // 2. Historical payout (paid) — insert first so paid commissions can link to it.
  const payoutAmount = money(
    COMMISSIONS.filter((c) => c.status === "paid").reduce(
      (sum, c) => sum + (REFERRALS.find((r) => r.slug === c.ref)!.plan === "Annual" ? ANNUAL_REV : MONTHLY_REV) * (PCT / 100),
      0,
    ),
  );
  const payoutRes = db.query(
    `INSERT INTO payouts (partner_id, amount, status, payment_date, payment_method, transaction_ref, notes)
     VALUES ($p, $amt, 'paid', $date, 'ACH', $txn, $notes)`,
  ).run({
    $p: partnerId,
    $amt: payoutAmount,
    $date: dateOffset(-35),
    $txn: `py_demo_${monthOf(dateOffset(-35))}`,
    $notes: "Sample payout — demo data only, not real money.",
  });
  const payoutId = Number(payoutRes.lastInsertRowid);

  // 3. Referrals.
  const referralIds = new Map<string, number>();
  for (const r of REFERRALS) {
    const res = db.query(
      `INSERT INTO referrals
         (partner_id, partner_code, referred_company, contact_name, contact_email, contact_phone,
          referral_date, signup_date, subscription_start_date, subscription_plan, subscription_amount,
          customer_status, notes)
       VALUES ($p, $code, $co, $cn, $e, $ph, $ref, $sign, $sub, $plan, $amt, $st, $note)`,
    ).run({
      $p: partnerId,
      $code: code,
      $co: r.company,
      $cn: r.contact,
      $e: r.email,
      $ph: r.phone,
      $ref: dateOffset(r.refDays),
      $sign: r.signDays !== null ? dateOffset(r.signDays) : null,
      $sub: r.status === "active" ? dateOffset(r.signDays ?? r.refDays) : null,
      $plan: r.plan,
      $amt: r.amount,
      $st: r.status,
      $note: NOTE,
    });
    referralIds.set(r.slug, Number(res.lastInsertRowid));
  }

  // 4. Commissions at 25% of monthly-equivalent revenue.
  for (const c of COMMISSIONS) {
    const ref = REFERRALS.find((r) => r.slug === c.ref)!;
    const revenue = ref.plan === "Annual" ? ANNUAL_REV : MONTHLY_REV;
    const amount = money(revenue * (PCT / 100));
    const earned = dateOffset(c.offset);
    db.query(
      `INSERT INTO commissions
         (partner_id, referral_id, tenant_id, billing_period, eligible_revenue, commission_percentage,
          commission_amount, earned_date, status, payout_id)
       VALUES ($p, $r, NULL, $bp, $rev, $pct, $amt, $earned, $st, $po)`,
    ).run({
      $p: partnerId,
      $r: referralIds.get(c.ref),
      $bp: monthOf(earned),
      $rev: revenue,
      $pct: PCT,
      $amt: amount,
      $earned: earned,
      $st: c.status,
      $po: c.status === "paid" ? payoutId : null,
    });
  }

  // 5. Summary (mirrors the dashboard endpoint's next-expected-payout rule:
  //    approved + scheduled).
  const totals = db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('approved','scheduled') THEN commission_amount ELSE 0 END), 0) AS next_payout,
       COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount ELSE 0 END), 0) AS paid
     FROM commissions WHERE partner_id = $p`,
  ).get({ $p: partnerId }) as { next_payout: number; paid: number };

  return {
    partner_id: partnerId,
    referral_count: REFERRALS.length,
    commission_count: COMMISSIONS.length,
    paid_total: money(totals.paid),
    next_expected_payout: money(totals.next_payout),
    payout_id: payoutId,
  };
}
