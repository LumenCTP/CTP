// ── Stripe Connect: client + mode selection + payout safety gate ───────────
// Delegation B. All Stripe usage in the API goes through this module so mode
// selection (test vs live) and the payout safety gate live in ONE place.
//
// ENV CONTRACT (lead manages api/.env — never edit it here):
//   LIVE keys (already present):  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
//   TEST keys (added later):      STRIPE_PUBLISHABLE_KEY,
//                                 STRIPE_SECRET_KEY_TEST,
//                                 STRIPE_PUBLISHABLE_KEY_TEST,
//                                 STRIPE_WEBHOOK_SECRET_TEST
//   STRIPE_TEST_MODE=true        → force test mode (in addition to the test key
//                                 being present).
//   STRIPE_PAYOUTS_ENABLED=true  → allow REAL transfers in live mode. Default
//                                 OFF: live money never moves until the owner
//                                 flips this after the test-mode E2E passes.
import Stripe from "stripe";
import { getDb } from "./db";

export type StripeMode = "test" | "live";

/**
 * Active mode. TEST only when a test secret key is present AND
 * STRIPE_TEST_MODE=true (or an explicit mode is passed, e.g. by the E2E
 * harness). Otherwise LIVE.
 */
export function stripeMode(explicit?: StripeMode): StripeMode {
  if (explicit === "test" || explicit === "live") return explicit;
  const testKey = process.env.STRIPE_SECRET_KEY_TEST;
  if (testKey && testKey.trim() !== "" && process.env.STRIPE_TEST_MODE === "true") {
    return "test";
  }
  return "live";
}

export function isTestMode(explicit?: StripeMode): boolean {
  return stripeMode(explicit) === "test";
}

/**
 * Returns a Stripe client for the active mode, or null when the key for that
 * mode is absent (callers must degrade gracefully — never crash).
 */
export function getStripe(mode?: StripeMode): Stripe | null {
  const m = stripeMode(mode);
  const key = m === "test" ? process.env.STRIPE_SECRET_KEY_TEST : process.env.STRIPE_SECRET_KEY;
  if (!key || key.trim() === "") {
    console.warn(`[stripe-connect] No Stripe secret key configured for ${m} mode — returning null (callers must handle)`);
    return null;
  }
  return new Stripe(key);
}

/**
 * Stripe webhook secrets to try, in order (live first, then test), with the
 * mode each belongs to. The webhook handler tries both so a single endpoint
 * can verify events from either environment.
 */
export function getWebhookSecrets(): Array<{ secret: string; mode: StripeMode }> {
  const secrets: Array<{ secret: string; mode: StripeMode }> = [];
  const live = process.env.STRIPE_WEBHOOK_SECRET;
  const test = process.env.STRIPE_WEBHOOK_SECRET_TEST;
  if (live && live.trim() !== "") secrets.push({ secret: live, mode: "live" });
  if (test && test.trim() !== "") secrets.push({ secret: test, mode: "test" });
  return secrets;
}

/**
 * TEST_MODE safety gate for attemptPayoutTransfer().
 * Real transfers are only created when:
 *   (a) we are in TEST mode (no real money), OR
 *   (b) STRIPE_PAYOUTS_ENABLED=true was explicitly set by the owner
 *       (allowed only AFTER the six-check test-mode E2E has passed).
 * Default = payouts NOT enabled → transfers are skipped and the payout stays
 * 'pending'. This is what guarantees live money never moves prematurely.
 */
export function isPayoutsEnabled(mode?: StripeMode): boolean {
  if (isTestMode(mode)) return true;
  return process.env.STRIPE_PAYOUTS_ENABLED === "true";
}

/**
 * App origin used for Stripe Connect onboarding refresh/return URLs (points at
 * the partner portal SPA route). Overridable via APP_ORIGIN for local dev.
 */
export const APP_ORIGIN = process.env.APP_ORIGIN || "https://cleartopay.ctonew.app";
export const PARTNER_PORTAL_CONNECT_URL = `${APP_ORIGIN}/app/partner/dashboard`;

// ── Partner onboarding state helpers ───────────────────────────────────────

export interface PartnerStripeRow {
  id: number;
  stripe_account_id: string | null;
  stripe_details_submitted: number | null;
  stripe_currently_due: string | null;
  stripe_payouts_enabled: number | null;
  stripe_charges_enabled: number | null;
  stripe_disconnected_at: string | null;
}

/** A stored JSON array (stripe_currently_due) is "empty" when null/blank/[] . */
export function currentlyDueIsEmpty(stored: string | null | undefined): boolean {
  if (!stored) return true;
  try {
    const arr = JSON.parse(stored);
    return Array.isArray(arr) && arr.length === 0;
  } catch {
    return true; // unparseable ⇒ treat as empty (nothing actionable stored)
  }
}

/**
 * A partner is fully onboarded for transfers when they have a connected
 * account AND details_submitted=true AND nothing currently due AND
 * payouts_enabled=true. attemptPayoutTransfer refuses to move money to anyone
 * who fails this.
 */
export function partnerOnboardingComplete(p: Partial<PartnerStripeRow>): boolean {
  return !!p.stripe_account_id
    && Number(p.stripe_details_submitted) === 1
    && currentlyDueIsEmpty(p.stripe_currently_due)
    && Number(p.stripe_payouts_enabled) === 1;
}

/** Human status for the portal: 'not_connected' | 'onboarding' | 'active'. */
export function partnerConnectStatus(p: Partial<PartnerStripeRow>): "not_connected" | "onboarding" | "active" {
  if (!p.stripe_account_id) return "not_connected";
  if (partnerOnboardingComplete(p)) return "active";
  return "onboarding";
}

/** Loads a partner's stripe columns by partner id (raw row). */
export function getPartnerStripeRow(db: ReturnType<typeof getDb>, partnerId: number): Partial<PartnerStripeRow> {
  const row = db.query(`
    SELECT id, stripe_account_id, stripe_details_submitted, stripe_currently_due,
           stripe_payouts_enabled, stripe_charges_enabled, stripe_disconnected_at
    FROM partners WHERE id = $id
  `).get({ $id: partnerId }) as Partial<PartnerStripeRow> | undefined;
  return row ?? { id: partnerId };
}
