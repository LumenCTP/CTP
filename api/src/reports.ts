import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { getDb } from "./db";
import {
  calculatePaymentWeek,
  calculateVendorCompliance,
  coverageIssueTexts,
  getTenantPaymentWeekStartDay,
  type PerTypeDetail,
  type VendorComplianceResult,
} from "./compliance";

// ── Types ───────────────────────────────────────────────

export interface ReportVendor {
  vendor_id: number;
  vendor_name: string;
  contact_name: string | null;
  contact_email: string | null;
  payment_status: string;
  details: PerTypeDetail[];
  reason?: string;
}

export interface ReportData {
  client_id: number;
  client_name: string;
  report_date: string;
  payment_week: { week_start: string; week_end: string };
  approved: ReportVendor[];
  review: ReportVendor[];
  hold: ReportVendor[];
  expiring_during_week: Array<{
    vendor_name: string;
    document_type: string;
    expiration_date: string;
  }>;
  missing_docs: Array<{
    vendor_name: string;
    missing_types: string[];
  }>;
  /**
   * "By project" grouping — each project this client has vendors on, with the
   * readiness counts and the vendors themselves. EMPTY for a tenant that does
   * not use projects, in which case every renderer produces exactly the report
   * it produced before this section existed (no project = no grouping).
   */
  projects: ReportProjectGroup[];
  /**
   * Documents that will expire but have NO contact address recorded (neither a
   * COI producer email nor a document sender email), so the automated renewal
   * reminder cannot reach anyone. Surfaced here (bug #11) instead of being
   * silently skipped by the scheduler — the client/owner must supply a contact
   * for these vendors or follow up manually.
   */
  needs_attention: Array<{
    document_id: number;
    vendor_name: string;
    document_type: string;
    expiration_date: string;
  }>;
}

/**
 * One project's vendors + readiness inside the report's "By project" section.
 *
 * The counts are computed from the vendors listed in this group (never from a
 * separate query), so a group's numbers always match the rows printed under it.
 * They are scoped to THIS client's vendors, so on a project shared with another
 * client the group answers "is everyone from this client on Project X clear to
 * pay?" — the tenant-wide total is on the dashboard's Projects page.
 */
export interface ReportProjectGroup {
  project_id: number;
  project_name: string;
  vendor_count: number;
  approved_count: number;
  review_count: number;
  hold_count: number;
  all_clear: boolean;
  vendors: ReportVendor[];
}

/**
 * Fallback reason for a row with no engine-supplied reason (an approved vendor):
 * the same wording the dashboard uses for an approved vendor, so the report and
 * the dashboard never describe the same vendor differently.
 */
function vendorReason(v: ReportVendor): string {
  return v.reason && v.reason.length > 0 ? v.reason : "All required documents current";
}

/** "2 approved · 1 review · 1 hold" — the one-line readiness read for a group. */
function projectReadinessText(g: ReportProjectGroup): string {
  if (g.vendor_count === 0) return "no vendors assigned yet";
  if (g.all_clear) return `all ${g.vendor_count} approved for payment`;
  const parts: string[] = [];
  if (g.approved_count) parts.push(`${g.approved_count} approved`);
  if (g.review_count) parts.push(`${g.review_count} review`);
  if (g.hold_count) parts.push(`${g.hold_count} hold`);
  return parts.join(" · ");
}


const REPORTS_DIR = path.join(import.meta.dir, "..", "data", "reports");

function ensureReportsDir() {
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

// ── Report Data Gathering ───────────────────────────────

export function gatherReportData(clientId: number): ReportData {
  const db = getDb();

  const client = db
    .query("SELECT id, name FROM clients WHERE id = $id")
    .get({ $id: clientId }) as { id: number; name: string } | undefined;

  if (!client) {
    throw new Error(`Client not found: ${clientId}`);
  }

  const tenantRow = db.query("SELECT tenant_id FROM clients WHERE id = $id").get({ $id: clientId }) as { tenant_id: number } | undefined;
  if (!tenantRow?.tenant_id) throw new Error(`Client tenant not found: ${clientId}`);

  // Ensure fresh compliance data in a SINGLE pass, retaining each vendor's
  // result so the report loop below reuses it instead of recomputing
  // compliance a second time (calculateVendorCompliance is the only function
  // that upserts compliance_status, so DB side-effects are unchanged).
  const complianceByVendor = new Map<number, VendorComplianceResult>();
  const calcVendors = db
    .query("SELECT id, client_id FROM vendors WHERE client_id = $client_id AND tenant_id = $tenant_id")
    .all({ $client_id: clientId, $tenant_id: tenantRow.tenant_id }) as Array<{ id: number; client_id: number }>;
  for (const cv of calcVendors) {
    complianceByVendor.set(cv.id, calculateVendorCompliance(cv.id, cv.client_id, tenantRow.tenant_id));
  }

  // The payment week window comes from the tenant's configured start day.
  const weekStartDay = getTenantPaymentWeekStartDay(db, tenantRow.tenant_id);
  const { week_start, week_end } = calculatePaymentWeek(weekStartDay);
  const today = new Date().toISOString().slice(0, 10);

  // Get all vendors for this client with full compliance details
  const vendorRows = db
    .query(
      `SELECT v.id, v.name, v.contact_name, v.contact_email,
              cs.payment_status
       FROM vendors v
       LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
       WHERE v.client_id = $client_id
       ORDER BY v.name ASC`
    )
    .all({ $client_id: clientId }) as Array<{
    id: number;
    name: string;
    contact_name: string | null;
    contact_email: string | null;
    payment_status: string | null;
  }>;

  const approved: ReportVendor[] = [];
  const review: ReportVendor[] = [];
  const hold: ReportVendor[] = [];
  // Every vendor in the report exactly once, in the same name order the flat
  // sections use — the input to the "By project" grouping below.
  const reportVendors: ReportVendor[] = [];
  const expiringDuringWeek: ReportData["expiring_during_week"] = [];
  const missingDocs: ReportData["missing_docs"] = [];

  for (const v of vendorRows) {
    // Reuse the single-pass result; fall back to a direct compute only in the
    // (shouldn't-happen) case the vendor was not in the calcVendors set.
    let compliance = complianceByVendor.get(v.id);
    if (!compliance) {
      compliance = calculateVendorCompliance(v.id, clientId, tenantRow.tenant_id);
    }

    const rv: ReportVendor = {
      vendor_id: v.id,
      vendor_name: v.name,
      contact_name: v.contact_name,
      contact_email: v.contact_email,
      payment_status: compliance.payment_status,
      details: compliance.details,
    };

    // Determine reason for review/hold
    if (compliance.payment_status === "hold") {
      const missing = compliance.details
        .filter((d) => d.status === "missing")
        .map((d) => d.document_type);
      const expired = compliance.details
        .filter((d) => d.status === "expired")
        .map((d) => d.document_type);
      const expiringInWeek = compliance.details.filter((d) => {
        return (
          d.is_reviewed &&
          d.expiration_date &&
          d.expiration_date >= today &&
          d.expiration_date <= week_end
        );
      });

      const reasons: string[] = [];
      if (missing.length > 0) reasons.push(`Missing: ${missing.join(", ")}`);
      if (expired.length > 0) reasons.push(`Expired: ${expired.join(", ")}`);
      const cov = coverageIssueTexts(compliance.details);
      if (cov.length > 0) reasons.push(cov.join("; "));
      if (expiringInWeek.length > 0) {
        reasons.push(
          `Expiring during payment week: ${expiringInWeek
            .map((e) => e.document_type)
            .join(", ")}`
        );
      }
      rv.reason = reasons.join("; ");
      hold.push(rv);
    } else if (compliance.payment_status === "review") {
      const reasons: string[] = [];
      if (compliance.details.some((d) => d.has_unreviewed)) {
        reasons.push("Documents in review");
      }
      const cov = coverageIssueTexts(compliance.details);
      if (cov.length > 0) reasons.push(cov.join("; "));
      if (
        compliance.details.some((d) => {
          if (!d.is_reviewed || !d.expiration_date) return false;
          const expDate = d.expiration_date;
          const sevenDays = new Date(today);
          sevenDays.setDate(sevenDays.getDate() + 7);
          const sevenDaysStr = sevenDays.toISOString().slice(0, 10);
          return expDate >= today && expDate <= sevenDaysStr;
        })
      ) {
        reasons.push("Expiring within 7 days");
      }
      rv.reason = reasons.join("; ") || "Needs review";
      review.push(rv);
    } else {
      approved.push(rv);
    }

    // Every vendor is recorded exactly once, in the flat sections' name order —
    // the input to the "By project" grouping built after this loop.
    reportVendors.push(rv);

    // Collect expiring-during-week entries
    for (const d of compliance.details) {
      if (
        d.is_reviewed &&
        d.expiration_date &&
        d.expiration_date >= week_start &&
        d.expiration_date <= week_end
      ) {
        expiringDuringWeek.push({
          vendor_name: v.name,
          document_type: d.document_type,
          expiration_date: d.expiration_date,
        });
      }
    }

    // Collect missing docs
    const missing = compliance.details
      .filter((d) => d.status === "missing")
      .map((d) => d.document_type);
    if (missing.length > 0) {
      missingDocs.push({
        vendor_name: v.name,
        missing_types: missing,
      });
    }
  }

  return {
    client_id: client.id,
    client_name: client.name,
    report_date: today,
    payment_week: { week_start, week_end },
    approved,
    review,
    hold,
    expiring_during_week: expiringDuringWeek,
    missing_docs: missingDocs,
    projects: buildProjectGroups(tenantRow.tenant_id, reportVendors),
    needs_attention: gatherNeedsAttention(clientId),
  };
}

/** Group name used for this client's vendors that belong to no project. */
const NO_PROJECT_GROUP_NAME = "(Not assigned to a project)";

/**
 * Group this client's reported vendors by project.
 *
 * Rules (kept deliberately simple so the section always adds up):
 *  - a project appears only when at least one of THIS client's vendors is on it
 *    (an empty project is noise in a report; the Projects page shows those);
 *  - a vendor assigned to two projects appears under both, which is the point of
 *    a grouping — so the groups' counts sum to MORE than the client's vendor
 *    count when vendors span projects;
 *  - this client's vendors on no project at all are collected in a final
 *    "(Not assigned to a project)" group, so every vendor is still accounted for;
 *  - counts are computed from the vendors listed in each group, so a group's
 *    numbers can never disagree with the rows printed under it;
 *  - a tenant with no projects gets [] — every renderer then emits exactly the
 *    report it emitted before this section existed.
 */
export function buildProjectGroups(tenantId: number, vendors: ReportVendor[]): ReportProjectGroup[] {
  const db = getDb();
  const projects = db.query(
    "SELECT id, name FROM projects WHERE tenant_id = $tenant_id ORDER BY name COLLATE NOCASE ASC"
  ).all({ $tenant_id: tenantId }) as Array<{ id: number; name: string }>;
  if (projects.length === 0) return [];

  // Tenant-scoped on both sides: the project must belong to this tenant and the
  // vendor must too, so a stale link across tenants can never leak a vendor.
  const assignments = db.query(`
    SELECT vp.project_id, vp.vendor_id
    FROM vendor_projects vp
    WHERE vp.project_id IN (SELECT id FROM projects WHERE tenant_id = $tenant_id)
      AND vp.vendor_id IN (SELECT id FROM vendors WHERE tenant_id = $tenant_id)
  `).all({ $tenant_id: tenantId }) as Array<{ project_id: number; vendor_id: number }>;

  const projectByVendor = new Map<number, number[]>();
  for (const a of assignments) {
    const list = projectByVendor.get(a.vendor_id);
    if (list) list.push(a.project_id);
    else projectByVendor.set(a.vendor_id, [a.project_id]);
  }

  const groups: ReportProjectGroup[] = [];
  const unassigned: ReportVendor[] = [];

  for (const p of projects) {
    const members = vendors.filter((v) => projectByVendor.get(v.vendor_id)?.includes(p.id));
    if (members.length === 0) continue;
    groups.push({ project_id: p.id, project_name: p.name, ...summarizeGroup(members), vendors: members });
  }

  for (const v of vendors) {
    if (!projectByVendor.has(v.vendor_id)) unassigned.push(v);
  }
  if (unassigned.length > 0) {
    groups.push({
      project_id: 0,
      project_name: NO_PROJECT_GROUP_NAME,
      ...summarizeGroup(unassigned),
      vendors: unassigned,
    });
  }

  return groups;
}

/** approved/review/hold counts + all_clear for one group's vendor list. */
function summarizeGroup(vendors: ReportVendor[]): Omit<ReportProjectGroup, "project_id" | "project_name" | "vendors"> {
  let approved = 0;
  let review = 0;
  let hold = 0;
  for (const v of vendors) {
    if (v.payment_status === "approved") approved++;
    else if (v.payment_status === "review") review++;
    else hold++;
  }
  const vendorCount = vendors.length;
  return {
    vendor_count: vendorCount,
    approved_count: approved,
    review_count: review,
    hold_count: hold,
    // Same definition as the Projects page: only claimable with >= 1 vendor.
    all_clear: vendorCount > 0 && approved === vendorCount && review === 0 && hold === 0,
  };
}

/**
 * Documents that expire but have no recipient address for renewal reminders —
 * exactly the set the scheduler's checkRenewals would skip (producer_email and
 * sender_email both empty). Bug #11: instead of silently dropping these, list
 * them in the weekly report so the client/owner knows which vendors need a
 * contact email or manual follow-up. Query mirrors scheduler.ts checkRenewals
 * (reviewed docs with a real expiration date); no address is fabricated.
 */
function gatherNeedsAttention(clientId: number): ReportData["needs_attention"] {
  const db = getDb();
  const rows = db.query(`
    SELECT d.id as document_id, de.document_type, de.expiration_date, v.name as vendor_name
    FROM documents d
    JOIN document_extractions de ON de.document_id = d.id
    JOIN vendors v ON v.id = d.vendor_id
    WHERE d.client_id = $client_id
      AND de.is_reviewed = 1
      AND de.expiration_date IS NOT NULL
      AND de.expiration_date != ''
      AND (de.producer_email IS NULL OR TRIM(de.producer_email) = '')
      AND (d.sender_email IS NULL OR TRIM(d.sender_email) = '')
    ORDER BY de.expiration_date ASC
  `).all({ $client_id: clientId }) as Array<{
    document_id: number;
    document_type: string;
    expiration_date: string;
    vendor_name: string;
  }>;
  return rows.map((r) => ({
    document_id: r.document_id,
    vendor_name: r.vendor_name,
    document_type: r.document_type,
    expiration_date: r.expiration_date,
  }));
}

// ── Colors ───────────────────────────────────────────────

const COLORS = {
  blue: "#1a56db",
  green: "#059669",
  amber: "#d97706",
  red: "#dc2626",
  dark: "#1f2937",
  gray: "#6b7280",
  lightGray: "#e5e7eb",
  white: "#ffffff",
};

function paymentStatusColor(status: string): string {
  if (status === "approved") return COLORS.green;
  if (status === "review") return COLORS.amber;
  return COLORS.red;
}

function paymentStatusLabel(status: string): string {
  if (status === "approved") return "Approved for Payment";
  if (status === "review") return "Review Before Payment";
  return "Hold Payment";
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── Document-Level Row Expansion ─────────────────────────
// The report must show EVERY required document type for EVERY vendor, not just
// a vendor-level line. calculateVendorCompliance already attaches a PerTypeDetail
// per required type to each ReportVendor (missing types included), so the
// renderer just needs to flatten those details into one row per vendor per type.

export interface DocLevelRow {
  vendor_name: string;
  document_type: string;
  status_label: string;
  expiration_label: string;
  contact: string;
}

function docTypeStatusLabel(d: {
  status: string;
  document_type?: string;
  coverage_status?: PerTypeDetail["coverage_status"];
  coverage_required?: string | null;
  coverage_extracted?: number | null;
}): string {
  // Coverage-gated rows carry the SAME human-readable phrase the dashboard, the
  // CSV export and the AI chat use (with both amounts) instead of the raw engine
  // token — "below_limit" must never reach a client-facing report. The two cases
  // mirror the UI: below → "…below required…" (drives Hold), unreadable →
  // "…coverage limit not readable" (drives Review).
  if (d.status === "below_limit" || (d.status === "needs_review" && d.coverage_status === "unreadable")) {
    const [cov] = coverageIssueTexts([d as PerTypeDetail]);
    if (cov) return cov;
  }
  switch (d.status) {
    case "missing": return "Missing";
    case "expired": return "Expired";
    case "expiring_soon": return "Expiring Soon";
    case "needs_review": return "Needs Review";
    case "compliant": return "Compliant";
    case "below_limit": return "Coverage Below Requirement";
    default: return d.status;
  }
}

/** Flatten vendor-level rows into one row per vendor per required doc type. */
export function expandDocumentRows(vendors: ReportVendor[]): DocLevelRow[] {
  const rows: DocLevelRow[] = [];
  for (const v of vendors) {
    // A vendor whose client has NO required document types configured has an
    // empty details array; still emit one visible row so the vendor never
    // disappears from the report.
    const details: PerTypeDetail[] = v.details.length > 0
      ? v.details
      : [{ document_type: "(no required documents configured)", status: "missing", document_id: null, expiration_date: null, is_reviewed: false, has_unreviewed: false }];
    for (const d of details) {
      rows.push({
        vendor_name: v.vendor_name,
        document_type: d.document_type,
        status_label: docTypeStatusLabel(d),
        expiration_label: d.expiration_date ? formatDate(d.expiration_date) : "—",
        contact: v.contact_name || v.contact_email || "—",
      });
    }
  }
  return rows;
}

/** Total document-level rows across all three payment sections (Approved/Review/Hold). */
export function countDocumentRows(data: ReportData): number {
  return expandDocumentRows(data.approved).length
    + expandDocumentRows(data.review).length
    + expandDocumentRows(data.hold).length;
}

// ── PDF Generation ──────────────────────────────────────

export function generatePdfReport(data: ReportData): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
  });

  // Page counter
  let pageNumber = 1;
  let drawingFooter = false;
  const footer = () => {
    // pdfkit auto-adds a page when text starts in the bottom-margin zone
    // (y > page.maxY() = height - margins.bottom). The footer intentionally
    // lives in that zone, so suppress the boundary while drawing it and guard
    // against reentrancy (a pageAdded-triggered addPage inside this handler
    // would otherwise recurse forever).
    if (drawingFooter) return;
    drawingFooter = true;
    const prevBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    try {
      doc.fontSize(8).fillColor(COLORS.gray).text(
        `Page ${pageNumber} — Generated by ClearToPay Compliance on ${formatDate(data.report_date)}`,
        50,
        doc.page.height - 58,
        { align: "center", width: doc.page.width - 100 }
      );
      doc
        .fontSize(7)
        .fillColor(COLORS.gray)
        .text(
          `This report reflects the compliance documents on file and the criteria configured for ${data.client_name} as of ${formatDate(data.report_date)}. It is an administrative tool, not legal advice. ClearToPay does not determine coverage adequacy; final payment and coverage decisions are the client's responsibility.`,
          50,
          doc.page.height - 46,
          { align: "center", width: doc.page.width - 100, lineGap: 1 }
        );
      pageNumber++;
    } finally {
      doc.page.margins.bottom = prevBottom;
      drawingFooter = false;
    }
  };

  // Footer + disclaimer on the first page, and on every page added after it
  // (renderSection's doc.addPage() emits pageAdded).
  footer();
  doc.y = doc.page.margins.top;
  doc.on("pageAdded", footer);

  // ── Header ──
  doc
    .fontSize(22)
    .fillColor(COLORS.blue)
    .font("Helvetica-Bold")
    .text("Clear-to-Pay Report", { align: "left" });

  doc.moveDown(0.3);
  doc
    .fontSize(13)
    .fillColor(COLORS.dark)
    .font("Helvetica")
    .text(data.client_name);

  doc.moveDown(0.1);
  doc
    .fontSize(9)
    .fillColor(COLORS.gray)
    .text(`Report Date: ${formatDate(data.report_date)}`);

  doc
    .fontSize(9)
    .fillColor(COLORS.gray)
    .text(
      `Payment Week: ${formatDate(data.payment_week.week_start)} – ${formatDate(data.payment_week.week_end)}`
    );

  doc.moveDown(0.8);

  // ── Section 1: Approved ──
  // One row per vendor per required document type — every document a vendor
  // has on file, and every required type (shown Missing) when there is none.
  const docRowHeaders = ["Vendor Name", "Document Type", "Status", "Expiration Date", "Contact"];
  const docRowMapper = (r: DocLevelRow): string[] => [
    r.vendor_name,
    r.document_type,
    r.status_label,
    r.expiration_label,
    r.contact,
  ];

  renderSection(
    doc,
    "1. Approved for Payment This Week",
    COLORS.green,
    expandDocumentRows(data.approved),
    docRowHeaders,
    docRowMapper,
    COLORS.green
  );

  // ── Section 2: Review ──
  renderSection(
    doc,
    "2. Review Before Payment",
    COLORS.amber,
    expandDocumentRows(data.review),
    docRowHeaders,
    docRowMapper,
    COLORS.amber
  );

  // ── Section 3: Hold ──
  renderSection(
    doc,
    "3. Hold Payment",
    COLORS.red,
    expandDocumentRows(data.hold),
    docRowHeaders,
    docRowMapper,
    COLORS.red
  );

  // ── Section 4: Expiring During Payment Week ──
  renderSection(
    doc,
    "4. Expiring During Payment Week",
    COLORS.amber,
    data.expiring_during_week,
    ["Vendor Name", "Document Type", "Expiration Date"],
    (e) => [e.vendor_name, e.document_type, formatDate(e.expiration_date)],
    COLORS.amber
  );

  // ── Section 5: Missing Required Documents ──
  renderSection(
    doc,
    "5. Missing Required Documents",
    COLORS.red,
    data.missing_docs,
    ["Vendor Name", "Missing Document Types"],
    (m) => [m.vendor_name, m.missing_types.join(", ")],
    COLORS.red
  );

  // ── Section 6: Needs Attention — No Contact for Renewal Reminder ──
  // Bug #11 surfacing: reviewed documents that will expire but have no
  // producer/sender email recorded, so the automated renewal reminder cannot
  // reach anyone. The client must add a contact for these vendors or follow up
  // manually — they are no longer silently dropped.
  renderSection(
    doc,
    "6. Needs Attention — No Contact for Renewal Reminder",
    COLORS.blue,
    data.needs_attention,
    ["Vendor Name", "Document Type", "Expiration Date"],
    (n) => [n.vendor_name, n.document_type, formatDate(n.expiration_date)],
    COLORS.blue
  );

  // ── Section 7: By Project ──
  // Rendered ONLY when the tenant uses projects: a tenant without projects gets
  // exactly the six sections it always had. Each project is its own sub-table
  // (same columns/layout as the sections above) so the client can read
  // "is everyone on Project X clear to pay?" straight off the page.
  if (data.projects.length > 0) {
    renderTitle(doc, "7. By Project", COLORS.blue);
    doc
      .fontSize(9)
      .fillColor(COLORS.gray)
      .font("Helvetica-Oblique")
      .text(
        "This client's vendors under each project they are assigned to; a vendor on two projects is listed under both. Counts are this client's vendors only.",
        { align: "left" }
      );
    data.projects.forEach((group, index) => {
      const heading = group.all_clear
        ? `${group.project_name} — all clear for payment (${group.vendor_count} vendor${group.vendor_count === 1 ? "" : "s"})`
        : `${group.project_name} — ${projectReadinessText(group)}`;
      renderSection(
        doc,
        `7.${index + 1} ${heading}`,
        group.all_clear ? COLORS.green : group.hold_count > 0 ? COLORS.red : COLORS.amber,
        group.vendors,
        ["Vendor Name", "Payment Status", "Details"],
        (v) => [v.vendor_name, paymentStatusLabel(v.payment_status), vendorReason(v)],
        group.all_clear ? COLORS.green : group.hold_count > 0 ? COLORS.red : COLORS.amber
      );
    });
  }

  // Finalize
  doc.end();
  return doc;
}

/**
 * A standalone section heading — same look as renderSection's title, without a
 * table. Used for the "By project" section, whose content is a series of
 * per-project sub-tables.
 */
function renderTitle(doc: PDFKit.PDFDocument, title: string, color: string) {
  // Reset x first: the previous table left doc.x at its last cell's position.
  doc.x = doc.page.margins.left;
  if (doc.y > doc.page.height - 140) {
    doc.addPage();
  }
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor(color).font("Helvetica-Bold").text(title, { align: "left", underline: false });
  doc.moveDown(0.3);
}

// ── Section Rendering Helper ─────────────────────────────

function renderSection<T>(
  doc: PDFKit.PDFDocument,
  title: string,
  color: string,
  rows: T[],
  headers: string[],
  rowMapper: (item: T) => string[],
  _accentColor: string
) {
  // IMPORTANT: reset doc.x to the left margin before anything else. The
  // cell-drawing text() calls leave doc.x at the last cell's x position, so
  // without this reset every section after the first would be shifted right
  // (headings wrap, rows clip off the right edge of the page).
  doc.x = doc.page.margins.left;

  // Check if we need a new page (rough estimate: need ~120pt for header + first row)
  if (doc.y > doc.page.height - 140) {
    doc.addPage();
  }

  // Section heading
  doc.moveDown(0.5);
  doc
    .fontSize(12)
    .fillColor(color)
    .font("Helvetica-Bold")
    .text(title, { align: "left", underline: false });

  doc.moveDown(0.3);

  if (rows.length === 0) {
    doc
      .fontSize(10)
      .fillColor(COLORS.gray)
      .font("Helvetica-Oblique")
      .text("No vendors in this category.");
    doc.moveDown(0.5);
    return;
  }

  // Column widths (approximate)
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = availableWidth / headers.length;

  // Table header
  const startX = doc.x;
  const headerY = doc.y;

  drawTableHeader(doc, headers, startX, headerY, colWidth, color);

  // Table rows — WRAP instead of clip: each cell's height is measured at the
  // column width, and the row advances by its tallest cell, so no cell is ever
  // truncated with an ellipsis and multi-line values (long doc-type lists,
  // long vendor names, emails) render in full.
  doc.font("Helvetica").fontSize(9);
  let rowY = headerY + 22;

  for (const row of rows) {
    const cells = rowMapper(row);

    // Measure every cell with wrapping enabled; row height = tallest cell + padding.
    let rowHeight = 14; // single-line floor
    for (const cell of cells) {
      const textHeight = cell ? doc.heightOfString(cell, { width: colWidth - 8 }) : 0;
      if (textHeight > rowHeight) rowHeight = textHeight;
    }
    rowHeight += 4;

    // Page-break check MUST be per-row against the row's ACTUAL height: if a
    // row started inside the footer zone (y > page.height - 80) pdfkit would
    // auto-addPage mid-draw, firing pageAdded → footer → addPage recursion.
    if (rowY + rowHeight > doc.page.height - 80) {
      doc.addPage();
      rowY = doc.page.margins.top + 10;
      // Redraw header on new page
      drawTableHeader(doc, headers, startX, rowY, colWidth, color);
      rowY += 22;
      doc.font("Helvetica").fontSize(9);
    }

    for (let i = 0; i < cells.length; i++) {
      doc.fillColor(COLORS.dark).text(
        cells[i],
        startX + i * colWidth + 4,
        rowY,
        {
          width: colWidth - 8,
          lineBreak: true,
        }
      );
    }

    // Row separator
    rowY += rowHeight;
    doc
      .moveTo(startX, rowY)
      .lineTo(startX + availableWidth, rowY)
      .strokeColor(COLORS.lightGray)
      .lineWidth(0.5)
      .stroke();
  }

  doc.y = rowY + 10;
}

function drawTableHeader(
  doc: PDFKit.PDFDocument,
  headers: string[],
  startX: number,
  y: number,
  colWidth: number,
  color: string
) {
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Header background
  doc
    .rect(startX, y, availableWidth, 20)
    .fillColor(color)
    .fill();

  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.white);

  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], startX + i * colWidth + 4, y + 4, {
      width: colWidth - 8,
      height: 14,
      ellipsis: true,
      lineBreak: false,
    });
  }
}

// ── Excel Generation ────────────────────────────────────

export async function generateExcelReport(data: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ClearToPay Compliance";
  wb.created = new Date();

  // ── Summary Sheet ──
  const summarySheet = wb.addWorksheet("Summary");
  buildSummarySheet(summarySheet, data);

  // ── Approved Sheet ──
  const approvedSheet = wb.addWorksheet("Approved");
  buildVendorSheet(approvedSheet, data.approved, COLORS.green);

  // ── Review Sheet ──
  const reviewSheet = wb.addWorksheet("Review");
  buildVendorSheet(reviewSheet, data.review, COLORS.amber);

  // ── Hold Sheet ──
  const holdSheet = wb.addWorksheet("Hold");
  buildVendorSheet(holdSheet, data.hold, COLORS.red);

  // ── Expiring Sheet ──
  const expiringSheet = wb.addWorksheet("Expiring");
  buildExpiringSheet(expiringSheet, data.expiring_during_week);

  // ── Missing Sheet ──
  const missingSheet = wb.addWorksheet("Missing");
  buildMissingSheet(missingSheet, data.missing_docs);

  // ── Needs Attention Sheet (bug #11: docs expiring with no reminder contact) ──
  const needsAttentionSheet = wb.addWorksheet("Needs Attention");
  buildNeedsAttentionSheet(needsAttentionSheet, data.needs_attention);

  // ── By Project Sheet ──
  // Added ONLY when the tenant uses projects, so a tenant without projects gets
  // the same workbook (same sheets, same order) it has always had.
  const projectSheet = data.projects.length > 0 ? wb.addWorksheet("By Project") : null;
  if (projectSheet) buildProjectSheet(projectSheet, data.projects);

  // ── Administrative notice on every worksheet ──
  const noticeSheets = [summarySheet, approvedSheet, reviewSheet, holdSheet, expiringSheet, missingSheet, needsAttentionSheet];
  if (projectSheet) noticeSheets.push(projectSheet);
  for (const sheet of noticeSheets) {
    addReportNotice(sheet, data.report_date);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function addReportNotice(sheet: ExcelJS.Worksheet, reportDate: string) {
  const notice = `This report reflects documents on file and client-configured criteria as of ${formatDate(reportDate)}. It is an administrative aid only, not legal or insurance advice. AI-extracted data may contain errors. ClearToPay does not verify coverage adequacy or approve payment; the client is responsible for final payment and coverage decisions.`;
  const row = sheet.rowCount + 2;
  const lastCol = Math.max(sheet.columnCount, 1);
  sheet.mergeCells(row, 1, row, lastCol);
  const cell = sheet.getCell(row, 1);
  cell.value = notice;
  cell.font = { name: "Helvetica", size: 8, italic: true, color: { argb: "FF6b7280" } };
  cell.alignment = { wrapText: true };
  sheet.getRow(row).height = 45;
}

function buildSummarySheet(
  sheet: ExcelJS.Worksheet,
  data: ReportData
) {
  // Title
  sheet.mergeCells("A1:C1");
  const titleCell = sheet.getCell("A1");
  titleCell.value = "Clear-to-Pay Report";
  titleCell.font = { name: "Helvetica", size: 18, bold: true, color: { argb: "FF1a56db" } };

  sheet.mergeCells("A2:C2");
  sheet.getCell("A2").value = data.client_name;
  sheet.getCell("A2").font = { name: "Helvetica", size: 13, bold: true };

  sheet.mergeCells("A3:C3");
  sheet.getCell("A3").value = `Report Date: ${formatDate(data.report_date)}`;
  sheet.getCell("A3").font = { name: "Helvetica", size: 10, color: { argb: "FF6b7280" } };

  sheet.mergeCells("A4:C4");
  sheet.getCell("A4").value = `Payment Week: ${formatDate(data.payment_week.week_start)} – ${formatDate(data.payment_week.week_end)}`;
  sheet.getCell("A4").font = { name: "Helvetica", size: 10, color: { argb: "FF6b7280" } };

  // Section counts
  const sections = [
    { label: "Approved for Payment", count: data.approved.length, color: COLORS.green },
    { label: "Review Before Payment", count: data.review.length, color: COLORS.amber },
    { label: "Hold Payment", count: data.hold.length, color: COLORS.red },
    { label: "Expiring During Payment Week", count: data.expiring_during_week.length, color: COLORS.amber },
    { label: "Missing Required Documents", count: data.missing_docs.length, color: COLORS.red },
    { label: "Needs Attention (No Reminder Contact)", count: data.needs_attention.length, color: COLORS.blue },
  ];

  let row = 6;
  sheet.getCell(`A${row}`).value = "Section";
  sheet.getCell(`B${row}`).value = "Count";
  sheet.getCell(`A${row}`).font = { bold: true, size: 10 };
  sheet.getCell(`B${row}`).font = { bold: true, size: 10 };
  const headerRow = sheet.getRow(row);
  headerRow.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1a56db" } };
    c.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  for (const s of sections) {
    row++;
    sheet.getCell(`A${row}`).value = s.label;
    sheet.getCell(`B${row}`).value = s.count;
    sheet.getCell(`B${row}`).font = { bold: true, color: { argb: s.color.replace("#", "FF") } };
  }

  sheet.getColumn("A").width = 35;
  sheet.getColumn("B").width = 12;
  sheet.getColumn("C").width = 20;
}

function buildVendorSheet(
  sheet: ExcelJS.Worksheet,
  rows: ReportVendor[],
  color: string,
) {
  // Document-level detail, mirroring the PDF: one row per vendor per required
  // document type (missing required types included).
  sheet.columns = [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Document Type", key: "document_type", width: 24 },
    { header: "Status", key: "status", width: 42 },
    { header: "Expiration Date", key: "expiration_date", width: 18 },
    { header: "Contact Name", key: "contact_name", width: 22 },
    { header: "Contact Email", key: "contact_email", width: 28 },
    { header: "Payment Status", key: "payment_status", width: 22 },
  ];

  // Header styling
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: color.replace("#", "FF") },
    };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  // Data rows — one per vendor per required doc type
  for (const v of rows) {
    const details: PerTypeDetail[] = v.details.length > 0
      ? v.details
      : [{ document_type: "(no required documents configured)", status: "missing", document_id: null, expiration_date: null, is_reviewed: false, has_unreviewed: false }];
    for (const d of details) {
      sheet.addRow({
        vendor_name: v.vendor_name,
        document_type: d.document_type,
        status: docTypeStatusLabel(d),
        expiration_date: d.expiration_date ? formatDate(d.expiration_date) : "",
        contact_name: v.contact_name || "",
        contact_email: v.contact_email || "",
        payment_status: paymentStatusLabel(v.payment_status),
      });
    }
  }

  // If empty, show a note
  if (rows.length === 0) {
    sheet.addRow({ vendor_name: "No vendors in this category" });
  }
}

function buildExpiringSheet(
  sheet: ExcelJS.Worksheet,
  rows: ReportData["expiring_during_week"]
) {
  sheet.columns = [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Document Type", key: "document_type", width: 22 },
    { header: "Expiration Date", key: "expiration_date", width: 18 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFd97706" },
    };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  for (const e of rows) {
    sheet.addRow({
      vendor_name: e.vendor_name,
      document_type: e.document_type,
      expiration_date: e.expiration_date,
    });
  }

  if (rows.length === 0) {
    sheet.addRow({ vendor_name: "No documents expiring this week" });
  }
}

function buildMissingSheet(
  sheet: ExcelJS.Worksheet,
  rows: ReportData["missing_docs"]
) {
  sheet.columns = [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Missing Document Types", key: "missing_types", width: 50 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFdc2626" },
    };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  for (const m of rows) {
    sheet.addRow({
      vendor_name: m.vendor_name,
      missing_types: m.missing_types.join(", "),
    });
  }

  if (rows.length === 0) {
    sheet.addRow({ vendor_name: "No vendors have missing documents" });
  }
}

/** Bug #11: docs that expire but have no contact recorded for renewal reminders. */
function buildNeedsAttentionSheet(
  sheet: ExcelJS.Worksheet,
  rows: ReportData["needs_attention"]
) {
  sheet.columns = [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Document Type", key: "document_type", width: 24 },
    { header: "Expiration Date", key: "expiration_date", width: 18 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1a56db" },
    };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  for (const n of rows) {
    sheet.addRow({
      vendor_name: n.vendor_name,
      document_type: n.document_type,
      expiration_date: n.expiration_date,
    });
  }

  if (rows.length === 0) {
    sheet.addRow({ vendor_name: "No documents are missing a reminder contact" });
  }
}

/**
 * "By Project" sheet — one row per project per vendor, so the whole sheet can be
 * filtered or pivoted on Project in Excel. The project's readiness read is
 * repeated on every one of its rows (it is the same value for the group), and
 * the untouched vendor-level detail stays in the Approved/Review/Hold sheets.
 */
function buildProjectSheet(
  sheet: ExcelJS.Worksheet,
  groups: ReportProjectGroup[],
) {
  sheet.columns = [
    { header: "Project", key: "project", width: 30 },
    { header: "Project Readiness", key: "readiness", width: 34 },
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Payment Status", key: "payment_status", width: 22 },
    { header: "Details", key: "details", width: 52 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1a56db" },
    };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  for (const g of groups) {
    const readiness = g.all_clear
      ? `All clear for payment (${g.vendor_count} vendor${g.vendor_count === 1 ? "" : "s"})`
      : projectReadinessText(g);
    for (const v of g.vendors) {
      sheet.addRow({
        project: g.project_name,
        readiness,
        vendor_name: v.vendor_name,
        payment_status: paymentStatusLabel(v.payment_status),
        details: vendorReason(v),
      });
    }
  }
}

// ── CSV Generation ──────────────────────────────────────
/**
 * The flat Clear-to-Pay CSV, byte-for-byte what the reports route used to build
 * inline, plus a "By project" block when the tenant uses projects.
 *
 * The by-project block reuses the SAME section/vendor/status/reason columns, so
 * an existing import or script that reads the flat rows keeps working: project
 * group headers carry "By Project" in the Section column and their vendor rows
 * carry "Project: <name>".
 */
export function generateCsvReport(data: ReportData): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows: string[] = ["Section,Vendor,Contact,Status,Reason,Document,Expiration,Missing Documents"];
  const addVendor = (section: string, v: ReportVendor) => rows.push([section, v.vendor_name, v.contact_email || v.contact_name || "", v.payment_status, v.reason || "", "", "", ""].map(esc).join(","));
  data.approved.forEach(v => addVendor("Approved", v));
  data.review.forEach(v => addVendor("Review", v));
  data.hold.forEach(v => addVendor("Hold", v));
  data.expiring_during_week.forEach(e => rows.push(["Expiring", e.vendor_name, "", "", "", e.document_type, e.expiration_date, ""].map(esc).join(",")));
  data.missing_docs.forEach(m => rows.push(["Missing", m.vendor_name, "", "", "", "", "", m.missing_types.join("; ")].map(esc).join(",")));

  // By-project block (absent for a tenant with no projects).
  if (data.projects.length > 0) {
    for (const g of data.projects) {
      const readiness = g.all_clear
        ? `ALL CLEAR — ${g.vendor_count} of ${g.vendor_count} approved for payment`
        : projectReadinessText(g);
      rows.push(["By Project", g.project_name, "", "", readiness, "", "", ""].map(esc).join(","));
      for (const v of g.vendors) {
        rows.push([`Project: ${g.project_name}`, v.vendor_name, v.contact_email || v.contact_name || "", v.payment_status, vendorReason(v), "", "", ""].map(esc).join(","));
      }
    }
  }

  rows.push([]);
  rows.push([`This report reflects documents on file and client-configured criteria as of ${data.report_date}. It is an administrative aid only, not legal or insurance advice. AI-extracted data may contain errors. ClearToPay does not verify coverage adequacy or approve payment; the client is responsible for final payment and coverage decisions.`].map(esc).join(","));
  return rows.join("\r\n") + "\r\n";
}

