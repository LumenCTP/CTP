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
}

export interface VendorComplianceResult {
  vendor_id: number;
  client_id: number;
  status: ComplianceStatus;
  payment_status: PaymentStatus;
  details: PerTypeDetail[];
}

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

/**
 * Determine per-document-type compliance.
 * Returns status and the document driving it (if any).
 */
function evaluateDocType(
  db: ReturnType<typeof getDb>,
  vendorId: number,
  requiredType: string,
  today: string,
  tenantId: number,
): PerTypeDetail {
  // Get all documents of this type for the vendor, with their extractions
  const rows = db
    .query(
      `
    SELECT d.id, d.document_type,
           de.expiration_date, de.is_reviewed, de.ai_confidence_score
    FROM documents d
    LEFT JOIN document_extractions de ON de.document_id = d.id
    WHERE d.vendor_id = $vendor_id
      AND d.document_type = $doc_type
      AND d.tenant_id = $tenant_id
    ORDER BY d.received_date DESC
  `,
    )
    .all({ $vendor_id: vendorId, $doc_type: requiredType, $tenant_id: tenantId }) as Array<{
    id: number;
    document_type: string;
    expiration_date: string | null;
    is_reviewed: number | null;
    ai_confidence_score: number | null;
  }>;

  if (rows.length === 0) {
    return {
      document_type: requiredType,
      status: "missing",
      document_id: null,
      expiration_date: null,
      is_reviewed: false,
      has_unreviewed: false,
    };
  }

  const reviewed = rows.filter((r) => r.is_reviewed === 1);
  const reviewedWithExpiry = reviewed.filter((r) => r.expiration_date);
  const reviewedNoExpiry = reviewed.filter((r) => !r.expiration_date);
  const unreviewed = rows.filter((r) => r.is_reviewed !== 1);

  const hasUnreviewed = unreviewed.length > 0;

  // If no reviewed docs at all → needs_review
  if (reviewed.length === 0) {
    return {
      document_type: requiredType,
      status: "needs_review",
      document_id: rows[0].id,
      expiration_date: rows[0].expiration_date,
      is_reviewed: false,
      has_unreviewed: true,
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
  // "needs_review" because AI hasn't processed newer versions.
  if (hasUnreviewed) {
    status = "needs_review";
  }

  return {
    document_type: requiredType,
    status,
    document_id: bestDoc.id,
    expiration_date: bestDoc.expiration_date ?? null,
    is_reviewed: true,
    has_unreviewed: hasUnreviewed,
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

  for (const d of details) {
    if (d.status === "missing") {
      hasMissing = true;
    }
    if (d.status === "expired") {
      hasExpired = true;
    }
    if (d.status === "needs_review" && d.has_unreviewed) {
      hasNeedsReview = true;
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
  if (hasMissing || hasExpired || hasExpiringInPaymentWeek) {
    return "hold";
  }

  // Review conditions
  if (hasNeedsReview || hasExpiringSoon) {
    return "review";
  }

  return "approved";
}

// ── Main Calculation Functions ─────────────────────────

export function calculateVendorCompliance(
  vendorId: number,
  clientId: number,
  tenantId: number,
): VendorComplianceResult {
  const db = getDb();
  const today = getToday();
  // Use the tenant's configured payment-week start day (not a hardcoded Monday).
  const weekStartDay = getTenantPaymentWeekStartDay(db, tenantId);
  const { week_start: paymentWeekStart, week_end: paymentWeekEnd } = calculatePaymentWeek(weekStartDay);

  // Get client's required document types
  const requiredTypes = db
    .query(
      `SELECT document_type FROM client_required_documents
     WHERE client_id = $client_id
       AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)
     ORDER BY document_type`,
    )
    .all({ $client_id: clientId, $tenant_id: tenantId }) as Array<{ document_type: string }>;

  if (requiredTypes.length === 0) {
    // No requirements → vendor is compliant and approved
    const status: ComplianceStatus = "compliant";
    const paymentStatus: PaymentStatus = "approved";
    upsertCompliance(db, vendorId, clientId, status, paymentStatus, tenantId);
    return {
      vendor_id: vendorId,
      client_id: clientId,
      status,
      payment_status: paymentStatus,
      details: [],
    };
  }

  // Evaluate each required type
  const details: PerTypeDetail[] = requiredTypes.map((rt) =>
    evaluateDocType(db, vendorId, rt.document_type, today, tenantId),
  );

  // Roll up compliance status (worst non-missing status wins)
  const statuses = details.map((d) => d.status);
  const overallStatus = worstStatus(statuses);

  // Determine payment status
  const paymentStatus = determinePaymentStatus(details, today, paymentWeekStart, paymentWeekEnd);

  // Upsert into compliance_status
  upsertCompliance(db, vendorId, clientId, overallStatus, paymentStatus, tenantId);

  return {
    vendor_id: vendorId,
    client_id: clientId,
    status: overallStatus,
    payment_status: paymentStatus,
    details,
  };
}

function upsertCompliance(
  db: ReturnType<typeof getDb>,
  vendorId: number,
  clientId: number,
  status: ComplianceStatus,
  paymentStatus: PaymentStatus,
  tenantId: number,
): void {
  db.query(
    `
    INSERT INTO compliance_status (vendor_id, client_id, status, payment_status, calculated_at)
    SELECT $vendor_id, $client_id, $status, $payment_status, datetime('now')
    WHERE EXISTS (SELECT 1 FROM vendors WHERE id = $vendor_id AND tenant_id = $tenant_id)
    ON CONFLICT(vendor_id) DO UPDATE SET
      client_id = $client_id,
      status = $status,
      payment_status = $payment_status,
      calculated_at = datetime('now')
  `,
  ).run({
    $vendor_id: vendorId,
    $client_id: clientId,
    $status: status,
    $payment_status: paymentStatus,
    $tenant_id: tenantId,
  });
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
