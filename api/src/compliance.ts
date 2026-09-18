import { getDb } from "./db";
import type { ComplianceStatus, PaymentStatus } from "@clear-to-pay/shared";

// ── Types ───────────────────────────────────────────────

export interface PerTypeDetail {
  document_type: string;
  status: ComplianceStatus | "missing";
  document_id: number | null;
  expiration_date: string | null;
  is_reviewed: boolean;
  has_unreviewed: boolean;
  /** Coverage enforcement detail (owner "Simple"): one dollar amount per doc type. */
  coverage_required: string | null;
  coverage_extracted: number | null;
  coverage_status: "ok" | "below" | "unreadable" | "n/a" | null;
}

export interface VendorComplianceResult {
  vendor_id: number;
  client_id: number;
  status: ComplianceStatus;
  payment_status: PaymentStatus;
  details: PerTypeDetail[];
  /** Derived 0-100 compliance score (see computeComplianceScore). */
  compliance_score: number;
  /** Score band: >= 80 "Good", 40-79 "Fair", < 40 "Poor". */
  score_label: ScoreLabel;
}

/** Color/label band for the derived per-vendor compliance score. */
export type ScoreLabel = "Good" | "Fair" | "Poor";

export interface RecalculationSummary {
  vendor_count: number;
  approved: number;
  review: number;
  hold: number;
}

// ── Payment Week Calculation ───────────────────────────

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Returns the week_start and week_end dates bounding the current payment week.
 * The payment week runs from the configured start day (default Monday) through
 * the day before it (e.g. Monday → Sunday, Wednesday → Tuesday), so a vendor's
 * documents must stay valid through week_end to be approved for payment.
 */
export function calculatePaymentWeek(startDay: string = "monday"): { week_start: string; week_end: string } {
  const now = new Date();
  const target = WEEKDAY_INDEX[startDay] ?? WEEKDAY_INDEX.monday;
  const todayIdx = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  // Most recent occurrence of the start day (may be earlier this week, or last
  // week if we are before the start day).
  let daysBack = todayIdx - target;
  if (daysBack < 0) daysBack += 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysBack);
  weekStart.setHours(0, 0, 0, 0);

  // End of the payment week = day before the next start day (start + 6 days).
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { week_start: fmt(weekStart), week_end: fmt(weekEnd) };
}

/** Fetch a tenant's configured payment-week start day (defaults to monday). */
export function getTenantPaymentWeekStartDay(db: ReturnType<typeof getDb>, tenantId: number): string {
  const row = db.query("SELECT payment_week_start_day FROM tenants WHERE id = $id").get({ $id: tenantId }) as
    | { payment_week_start_day?: string | null }
    | undefined;
  const day = row?.payment_week_start_day?.trim().toLowerCase() ?? "monday";
  return WEEKDAY_INDEX[day] !== undefined ? day : "monday";
}

// ── Per-Type Compliance ─────────────────────────────────

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Coverage enforcement (owner "Simple") ───────────────
// One dollar amount per required insurance doc type. The engine compares the
// AI-extracted limit on the best reviewed doc against the client's required
// amount. This is a FLAGGING AID only: the client remains responsible for
// verifying their own coverage adequacy (existing disclaimer framing).

/** Maps a required document type to the coverage column gated for it. */
const COVERAGE_LIMIT_COLUMN: Record<string, keyof CoverageRow> = {
  "General Liability": "coverage_gl_occurrence",
  "Workers Comp": "coverage_wc_employers",
  "Commercial Auto": "coverage_auto_csl",
  "Umbrella": "coverage_umbrella",
};

interface CoverageRow {
  coverage_gl_occurrence: number | null;
  coverage_gl_aggregate: number | null;
  coverage_wc_employers: number | null;
  coverage_auto_csl: number | null;
  coverage_umbrella: number | null;
}

/**
 * Normalize a client's coverage-requirement TEXT into whole dollars (or null).
 * Accepts "1000000", "$1,000,000", "1M", "1m", "1,000,000", "$1M", and
 * descriptive strings carrying a dollar amount ("$1,000,000 per occurrence /
 * $2,000,000 aggregate" → the first amount, 1,000,000). Unparseable or null
 * input returns null, and the caller SKIPS the gate (a requirement we cannot
 * read must never auto-hold a vendor).
 */
export function parseCoverageRequirement(text: string | null): number | null {
  if (!text) return null;
  const cleaned = String(text).replace(/[$,]/g, (ch) => (ch === "," ? "" : " "));
  const m = cleaned.match(/(\d+(?:\.\d+)?)\s*(m|k|b|million|thousand|billion)?/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const suffix = (m[2] || "").toLowerCase();
  let dollars = num;
  if (suffix === "m" || suffix === "million") dollars = num * 1_000_000;
  else if (suffix === "k" || suffix === "thousand") dollars = num * 1_000;
  else if (suffix === "b" || suffix === "billion") dollars = num * 1_000_000_000;
  return Math.round(dollars);
}

/**
 * Human-readable coverage-issue reasons across a vendor's detail list, e.g.
 * "General Liability coverage $500,000 below required $1,000,000" or
 * "General Liability coverage limit not readable". Returns [] when no
 * coverage issues. Used by reports and the dashboard/vendor reason strings.
 */
export function coverageIssueTexts(details: PerTypeDetail[]): string[] {
  const out: string[] = [];
  for (const d of details) {
    if (d.coverage_status === "below" && d.coverage_required && d.coverage_extracted != null) {
      out.push(
        `${d.document_type} coverage ${d.coverage_extracted.toLocaleString()} below required ${parseCoverageRequirement(d.coverage_required)?.toLocaleString() ?? d.coverage_required}`
      );
    } else if (d.coverage_status === "unreadable" && d.coverage_required) {
      out.push(`${d.document_type} coverage limit not readable`);
    }
  }
  return out;
}

/**
 * Determine whether a document type's status should be downgraded by the
 * coverage gate. Returns the new detail fields; `unchanged` when no gate
 * applies (requirement unparseable, doc type not coverage-capable) or the
 * doc already passes (extracted >= required).
 */
function applyCoverageGate(
  requiredType: string,
  requirementText: string | null,
  bestDocCoverage: CoverageRow | null,
): { coverage_required: string | null; coverage_extracted: number | null; coverage_status: "ok" | "below" | "unreadable" | "n/a" | null; newStatus: ComplianceStatus | null } {
  const column = COVERAGE_LIMIT_COLUMN[requiredType];
  // Doc types without an enforced coverage limit (W-9, Business License,
  // custom docs, COI bundle, etc.) → no coverage gate.
  if (!column) {
    return { coverage_required: null, coverage_extracted: null, coverage_status: "n/a", newStatus: null };
  }
  const required = parseCoverageRequirement(requirementText);
  // Unparseable / null requirement → skip the gate entirely (coverage_status
  // null means "not gated"). Never auto-hold on a requirement we can't read.
  if (required == null) {
    return { coverage_required: requirementText ?? null, coverage_extracted: null, coverage_status: null, newStatus: null };
  }
  const extracted = bestDocCoverage?.[column] ?? null;
  if (extracted == null) {
    // Limit not readable / not extracted → needs_review (Review, NOT Hold).
    return { coverage_required: requirementText ?? null, coverage_extracted: null, coverage_status: "unreadable", newStatus: "needs_review" };
  }
  if (extracted < required) {
    return { coverage_required: requirementText ?? null, coverage_extracted: extracted, coverage_status: "below", newStatus: "below_limit" };
  }
  return { coverage_required: requirementText ?? null, coverage_extracted: extracted, coverage_status: "ok", newStatus: null };
}

/**
 * Determine per-document-type compliance from pre-fetched document rows
 * (already filtered to the vendor/tenant and ordered by received_date DESC).
 * Returns status and the document driving it (if any).
 */
function evaluateDocType(
  rows: Array<{
    id: number;
    document_type: string;
    expiration_date: string | null;
    is_reviewed: number | null;
    ai_confidence_score: number | null;
    coverage_gl_occurrence: number | null;
    coverage_gl_aggregate: number | null;
    coverage_wc_employers: number | null;
    coverage_auto_csl: number | null;
    coverage_umbrella: number | null;
  }>,
  requiredType: string,
  today: string,
  coverageRequirement: string | null,
): PerTypeDetail {
  if (rows.length === 0) {
    // Missing doc → the requirement is shown for context but there is no doc to
    // compare, so coverage_status is null (not gated; "missing" already holds).
    return {
      document_type: requiredType,
      status: "missing",
      document_id: null,
      expiration_date: null,
      is_reviewed: false,
      has_unreviewed: false,
      coverage_required: coverageRequirement ?? null,
      coverage_extracted: null,
      coverage_status: null,
    };
  }

  const reviewed = rows.filter((r) => r.is_reviewed === 1);
  const reviewedWithExpiry = reviewed.filter((r) => r.expiration_date);
  const reviewedNoExpiry = reviewed.filter((r) => !r.expiration_date);
  const unreviewed = rows.filter((r) => r.is_reviewed !== 1);

  const hasUnreviewed = unreviewed.length > 0;

  // If no reviewed docs at all → needs_review (full review surface; no coverage
  // value is trustworthy enough to gate on yet).
  if (reviewed.length === 0) {
    return {
      document_type: requiredType,
      status: "needs_review",
      document_id: rows[0].id,
      expiration_date: rows[0].expiration_date,
      is_reviewed: false,
      has_unreviewed: true,
      coverage_required: coverageRequirement ?? null,
      coverage_extracted: null,
      coverage_status: null,
    };
  }

  // Determine the best document and its status
  let bestDoc: typeof rows[0];
  let status: ComplianceStatus;

  if (reviewedWithExpiry.length > 0) {
    // Pick the reviewed doc with the latest expiration_date
    reviewedWithExpiry.sort((a, b) => {
      const aDate = a.expiration_date ?? "";
      const bDate = b.expiration_date ?? "";
      return bDate.localeCompare(aDate); // descending
    });
    bestDoc = reviewedWithExpiry[0];
    const expDate = bestDoc.expiration_date!;

    if (expDate < today) {
      status = "expired";
    } else if (expDate <= addDays(today, 14)) {
      status = "expiring_soon";
    } else {
      status = "compliant";
    }
  } else {
    // Reviewed doc with no expiration date (e.g., W-9) → compliant
    bestDoc = reviewedNoExpiry[0];
    status = "compliant";
  }

  // If there are unreviewed docs alongside reviewed ones, the type is still
  // "needs_review" because AI hasn't processed newer versions. (A newer,
  // unreviewed certificate could change the coverage amount too.)
  if (hasUnreviewed) {
    status = "needs_review";
  }

  // ── Coverage gate ─────────────────────────────────────────────────────
  // Applied ONLY when the doc is otherwise compliant/expiring_soon (an expired
  // or needs-review doc stays that way; coverage is a secondary gate). Coverage
  // uses the BEST reviewed doc (the one driving the status), so we compare its
  // extracted limit. onlyCompareFromReviewed avoids holding on an unreviewed doc.
  let coverageStatus = "n/a" as PerTypeDetail["coverage_status"];
  let coverageExtracted: number | null = null;
  let coverageRequired: string | null = coverageRequirement ?? null;
  if (!hasUnreviewed && (status === "compliant" || status === "expiring_soon")) {
    const gate = applyCoverageGate(requiredType, coverageRequirement, bestDoc);
    coverageStatus = gate.coverage_status;
    coverageExtracted = gate.coverage_extracted;
    coverageRequired = gate.coverage_required;
    // below_limit → override the type status to Hold-driving below_limit.
    // unreadable → downgrade to needs_review (Review, NOT Hold).
    if (gate.newStatus === "below_limit") {
      status = "below_limit";
    } else if (gate.newStatus === "needs_review") {
      status = "needs_review";
    }
  } else {
    // Not gated right now (unreviewed, expired, or missing). Still surface the
    // requirement so the UI can show intent; status for these is unchanged.
    const gate = applyCoverageGate(requiredType, coverageRequirement, bestDoc);
    coverageStatus = gate.coverage_status === "n/a" ? "n/a" : gate.coverage_status;
    coverageExtracted = gate.coverage_extracted;
    coverageRequired = gate.coverage_required;
  }

  return {
    document_type: requiredType,
    status,
    document_id: bestDoc.id,
    expiration_date: bestDoc.expiration_date ?? null,
    is_reviewed: true,
    has_unreviewed: hasUnreviewed,
    coverage_required: coverageRequired,
    coverage_extracted: coverageExtracted,
    coverage_status: coverageStatus,
  };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Overall Status Rollup ──────────────────────────────

const STATUS_PRIORITY: Record<ComplianceStatus | "missing", number> = {
  expired: 4,
  below_limit: 3.5, // a present-but-insufficient doc beats an absent one (client may think they're covered)
  missing: 3,
  needs_review: 2,
  expiring_soon: 1,
  compliant: 0,
};

function worstStatus(
  statuses: (ComplianceStatus | "missing")[],
): ComplianceStatus {
  let worst: ComplianceStatus = "compliant";
  let worstPrio = 0;
  for (const s of statuses) {
    const p = STATUS_PRIORITY[s] ?? 0;
    if (p > worstPrio) {
      worstPrio = p;
      // Map "missing" back to a compliance status — but missing shouldn't
      // happen for overall compliance (only affects payment). We'll treat it
      // as expired for compliance display purposes.
      worst = s === "missing" ? "expired" : s;
    }
  }
  return worst;
}

// ── Per-Vendor Compliance Score (0-100) ────────────────
// A single readability number derived from the SAME per-document-type statuses
// the payment decision uses — it never changes the Hold/Review/Approved logic,
// it only summarizes it. Points per type are averaged over the client's required
// document types for that vendor, so a vendor with no configured requirements
// scores 100.

export const SCORE_POINTS: Record<ComplianceStatus | "missing", number> = {
  compliant: 100,
  expiring_soon: 75,
  needs_review: 50,
  below_limit: 25,
  missing: 0,
  expired: 0,
};

/** Map a 0-100 score to its band: >= 80 Good, 40-79 Fair, < 40 Poor. */
export function scoreLabelFor(score: number): ScoreLabel {
  if (score >= 80) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

/**
 * Average the per-type points across a vendor's required types and band it.
 * An empty detail list (client requires no documents) scores 100/"Good".
 */
export function computeComplianceScore(details: PerTypeDetail[]): { compliance_score: number; score_label: ScoreLabel } {
  if (details.length === 0) {
    return { compliance_score: 100, score_label: "Good" };
  }
  let total = 0;
  for (const d of details) total += SCORE_POINTS[d.status] ?? 0;
  const score = Math.round(total / details.length);
  return { compliance_score: score, score_label: scoreLabelFor(score) };
}

// ── Payment Status Decision ────────────────────────────

function determinePaymentStatus(
  details: PerTypeDetail[],
  today: string,
  paymentWeekStart: string,
  paymentWeekEnd: string,
): PaymentStatus {
  let hasMissing = false;
  let hasExpired = false;
  let hasExpiringInPaymentWeek = false;
  let hasNeedsReview = false;
  let hasExpiringSoon = false;
  let hasCoverageBelow = false;
  let hasCoverageUnreadable = false;

  for (const d of details) {
    if (d.status === "missing") {
      hasMissing = true;
    }
    if (d.status === "expired") {
      hasExpired = true;
    }
    // Coverage limit below the required amount → Hold (worst of the secondary gates).
    if (d.status === "below_limit") {
      hasCoverageBelow = true;
    }
    if (d.status === "needs_review" && d.has_unreviewed) {
      hasNeedsReview = true;
    }
    // Coverage limit not readable → Review (never auto-Hold on a parse miss).
    if (d.coverage_status === "unreadable") {
      hasCoverageUnreadable = true;
    }
    // Check if expiring during the tenant's payment week (for reviewed docs)
    if (
      d.is_reviewed &&
      d.expiration_date &&
      d.expiration_date >= paymentWeekStart &&
      d.expiration_date <= paymentWeekEnd
    ) {
      hasExpiringInPaymentWeek = true;
    }
    // Check if expiring within 7 days (but after payment week)
    if (
      d.is_reviewed &&
      d.expiration_date &&
      d.expiration_date >= today &&
      d.expiration_date <= addDays(today, 7)
    ) {
      hasExpiringSoon = true;
    }
  }

  // Hold conditions (worst)
  if (hasMissing || hasExpired || hasExpiringInPaymentWeek || hasCoverageBelow) {
    return "hold";
  }

  // Review conditions
  if (hasNeedsReview || hasExpiringSoon || hasCoverageUnreadable) {
    return "review";
  }

  return "approved";
}

// ── Main Calculation Functions ─────────────────────────

export function calculateVendorCompliance(
  vendorId: number,
  clientId: number,
  tenantId: number,
  opts: { persist?: boolean } = {},
): VendorComplianceResult {
  // persist:false = read-only scoring pass. The caller (refreshMissingScores)
  // reads the derived score without a status/payment write, so a read can never
  // mutate stored compliance state. All normal callers persist (default).
  const persist = opts.persist !== false;
  const db = getDb();
  const today = getToday();
  // Use the tenant's configured payment-week start day (not a hardcoded Monday).
  const weekStartDay = getTenantPaymentWeekStartDay(db, tenantId);
  const { week_start: paymentWeekStart, week_end: paymentWeekEnd } = calculatePaymentWeek(weekStartDay);

  // Get client's required document types (with their coverage requirement)
  const requiredTypes = db
    .query(
      `SELECT document_type, coverage_requirement FROM client_required_documents
     WHERE client_id = $client_id
       AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)
     ORDER BY document_type`,
    )
    .all({ $client_id: clientId, $tenant_id: tenantId }) as Array<{ document_type: string; coverage_requirement: string | null }>;

  if (requiredTypes.length === 0) {
    // No requirements → vendor is compliant and approved (and scores full marks)
    const status: ComplianceStatus = "compliant";
    const paymentStatus: PaymentStatus = "approved";
    const { compliance_score, score_label } = computeComplianceScore([]);
    if (persist) upsertCompliance(db, vendorId, clientId, status, paymentStatus, tenantId, compliance_score, score_label);
    return {
      vendor_id: vendorId,
      client_id: clientId,
      status,
      payment_status: paymentStatus,
      details: [],
      compliance_score,
      score_label,
    };
  }
  // Fetch ALL of the vendor's documents (any type) in one query, ordered by
  // received_date DESC — the same order the per-type query used — then group
  // rows by document_type in JS so the per-type status logic below is fed
  // byte-identical inputs (one query per vendor instead of one per type).
  const allDocRows = db
    .query(
      `
    SELECT d.id, d.document_type,
           de.expiration_date, de.is_reviewed, de.ai_confidence_score,
           de.coverage_gl_occurrence, de.coverage_gl_aggregate,
           de.coverage_wc_employers, de.coverage_auto_csl, de.coverage_umbrella
    FROM documents d
    LEFT JOIN document_extractions de ON de.document_id = d.id
    WHERE d.vendor_id = $vendor_id
      AND d.tenant_id = $tenant_id
    ORDER BY d.received_date DESC
  `,
    )
    .all({ $vendor_id: vendorId, $tenant_id: tenantId }) as Array<{
    id: number;
    document_type: string;
    expiration_date: string | null;
    is_reviewed: number | null;
    ai_confidence_score: number | null;
    coverage_gl_occurrence: number | null;
    coverage_gl_aggregate: number | null;
    coverage_wc_employers: number | null;
    coverage_auto_csl: number | null;
    coverage_umbrella: number | null;
  }>;

  const rowsByType = new Map<string, typeof allDocRows>();
  for (const r of allDocRows) {
    const arr = rowsByType.get(r.document_type);
    if (arr) arr.push(r);
    else rowsByType.set(r.document_type, [r]);
  }

  // Evaluate each required type (coverage requirement passed for the gate)
  const details: PerTypeDetail[] = requiredTypes.map((rt) =>
    evaluateDocType(rowsByType.get(rt.document_type) ?? [], rt.document_type, today, rt.coverage_requirement),
  );

  // Roll up compliance status (worst non-missing status wins)
  const statuses = details.map((d) => d.status);
  const overallStatus = worstStatus(statuses);

  // Determine payment status
  const paymentStatus = determinePaymentStatus(details, today, paymentWeekStart, paymentWeekEnd);

  // Derived 0-100 score (reporting aid; the payment decision above is unchanged)
  const { compliance_score, score_label } = computeComplianceScore(details);

  // Upsert into compliance_status (skipped on a read-only scoring pass)
  if (persist) upsertCompliance(db, vendorId, clientId, overallStatus, paymentStatus, tenantId, compliance_score, score_label);

  return {
    vendor_id: vendorId,
    client_id: clientId,
    status: overallStatus,
    payment_status: paymentStatus,
    details,
    compliance_score,
    score_label,
  };
}

function upsertCompliance(
  db: ReturnType<typeof getDb>,
  vendorId: number,
  clientId: number,
  status: ComplianceStatus,
  paymentStatus: PaymentStatus,
  tenantId: number,
  complianceScore: number,
  scoreLabel: ScoreLabel,
): void {
  db.query(
    `
    INSERT INTO compliance_status (vendor_id, client_id, status, payment_status, compliance_score, score_label, calculated_at)
    SELECT $vendor_id, $client_id, $status, $payment_status, $compliance_score, $score_label, datetime('now')
    WHERE EXISTS (SELECT 1 FROM vendors WHERE id = $vendor_id AND tenant_id = $tenant_id)
    ON CONFLICT(vendor_id) DO UPDATE SET
      client_id = $client_id,
      status = $status,
      payment_status = $payment_status,
      compliance_score = $compliance_score,
      score_label = $score_label,
      calculated_at = datetime('now')
  `,
  ).run({
    $vendor_id: vendorId,
    $client_id: clientId,
    $status: status,
    $payment_status: paymentStatus,
    $compliance_score: complianceScore,
    $score_label: scoreLabel,
    $tenant_id: tenantId,
  });
}

/**
 * Backfill for the derived score columns only.
 *
 * Vendors whose compliance_status row has no score yet get one computed from the
 * engine's current document state. This NEVER touches status / payment_status /
 * calculated_at — a read-triggered pass must not be able to change a stored
 * compliance decision (the recalculation endpoints remain the only writers).
 *
 * Cheap by design: one indexed join that returns zero rows once every vendor is
 * scored, so callers (the vendor list / dashboard reads) pay nothing in steady
 * state. Rows created before the score columns existed, or inserted directly by
 * the CSV importer, are filled in on first read.
 */
export function refreshMissingScores(tenantId: number): number {
  const db = getDb();
  const rows = db.query(
    `SELECT v.id AS vendor_id, v.client_id AS client_id
     FROM vendors v
     JOIN compliance_status cs ON cs.vendor_id = v.id
     WHERE v.tenant_id = $tenant_id
       AND (cs.compliance_score IS NULL OR cs.score_label IS NULL)`,
  ).all({ $tenant_id: tenantId }) as Array<{ vendor_id: number; client_id: number }>;

  const update = db.query(
    "UPDATE compliance_status SET compliance_score = $s, score_label = $l WHERE vendor_id = $v",
  );
  let refreshed = 0;
  for (const r of rows) {
    const res = calculateVendorCompliance(r.vendor_id, r.client_id, tenantId, { persist: false });
    update.run({ $s: res.compliance_score, $l: res.score_label, $v: r.vendor_id });
    refreshed++;
  }
  return refreshed;
}

export function calculateClientCompliance(
  clientId: number,
  tenantId: number,
): RecalculationSummary {
  const db = getDb();

  const vendors = db
    .query("SELECT id, client_id FROM vendors WHERE client_id = $client_id AND tenant_id = $tenant_id")
    .all({ $client_id: clientId, $tenant_id: tenantId }) as Array<{
    id: number;
    client_id: number;
  }>;

  let approved = 0;
  let review = 0;
  let hold = 0;

  for (const v of vendors) {
    const result = calculateVendorCompliance(v.id, v.client_id, tenantId);
    if (result.payment_status === "approved") approved++;
    else if (result.payment_status === "review") review++;
    else hold++;
  }

  return { vendor_count: vendors.length, approved, review, hold };
}

export function calculateAllCompliance(tenantId: number): RecalculationSummary {
  const db = getDb();

  const vendors = db.query("SELECT id, client_id FROM vendors WHERE tenant_id = $tenant_id").all({ $tenant_id: tenantId }) as Array<{
    id: number;
    client_id: number;
  }>;

  let approved = 0;
  let review = 0;
  let hold = 0;

  for (const v of vendors) {
    const result = calculateVendorCompliance(v.id, v.client_id, tenantId);
    if (result.payment_status === "approved") approved++;
    else if (result.payment_status === "review") review++;
    else hold++;
  }

  return { vendor_count: vendors.length, approved, review, hold };
}
