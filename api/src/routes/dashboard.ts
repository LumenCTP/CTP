import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { calculatePaymentWeek, getTenantPaymentWeekStartDay, parseCoverageRequirement, refreshMissingScores } from "../compliance";
import { listProjectSummaries, projectAssignmentsForVendors } from "../lib/projects";

const app = new Hono();

/** One row of the dashboard's Clear-to-Pay vendor list (see /api/dashboard/clear-to-pay). */
interface ClearToPayVendor {
  vendor_id: number;
  vendor_name: string;
  client_id: number;
  client_name: string;
  compliance_status: string;
  payment_status: string;
  compliance_score: number | null;
  score_label: string | null;
  missing_documents: string[];
  earliest_expiring_date: string | null;
  earliest_expiring_type: string | null;
  reason: string;
}

/**
 * A project's answer to "is everyone on Project X clear to pay?".
 *
 * The counts are NOT recomputed here: they come from lib/projects
 * (PROJECT_SUMMARY_SQL), the exact query behind GET /api/projects, so the
 * dashboard and the Projects page can never show different numbers for the same
 * project. `vendors` is the dashboard's own vendor rows filtered to the project,
 * which is what the client drills into.
 */
interface ClearToPayProjectGroup {
  project_id: number;
  project_name: string;
  vendor_count: number;
  approved_count: number;
  review_count: number;
  hold_count: number;
  all_clear: boolean;
  vendors: ClearToPayVendor[];
}

/**
 * Group the dashboard's vendors by project.
 *
 * Returns [] for a tenant with no projects — the dashboard then renders exactly
 * the flat Clear-to-Pay view it always has. `assignedVendorIds` is returned so
 * the caller can report how many vendors are on no project at all.
 */
function buildProjectGroups(
  tenantId: number,
  vendors: ClearToPayVendor[],
): { groups: ClearToPayProjectGroup[]; assignedVendorIds: Set<number> } {
  const assignedVendorIds = new Set<number>();
  const summaries = listProjectSummaries(tenantId);
  if (summaries.length === 0) return { groups: [], assignedVendorIds };

  const assignments = projectAssignmentsForVendors(tenantId, vendors.map((v) => v.vendor_id));
  const vendorIdsByProject = new Map<number, Set<number>>();
  for (const a of assignments) {
    assignedVendorIds.add(a.vendor_id);
    const ids = vendorIdsByProject.get(a.project_id);
    if (ids) ids.add(a.vendor_id);
    else vendorIdsByProject.set(a.project_id, new Set([a.vendor_id]));
  }

  const groups = summaries.map((p) => {
    const ids = vendorIdsByProject.get(p.id) ?? new Set<number>();
    return {
      project_id: p.id,
      project_name: p.name,
      vendor_count: p.vendor_count,
      approved_count: p.approved_count,
      review_count: p.review_count,
      hold_count: p.hold_count,
      all_clear: p.all_clear,
      vendors: vendors.filter((v) => ids.has(v.vendor_id)),
    };
  });

  return { groups, assignedVendorIds };
}


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

    // Documents expiring this week (within the tenant's payment-week window)
    const weekStartDay = getTenantPaymentWeekStartDay(db, tenantId);
    const { week_start, week_end } = calculatePaymentWeek(weekStartDay);
    const expiringThisWeek = (db.query(`
      SELECT COUNT(*) as count FROM document_extractions
      WHERE expiration_date IS NOT NULL
        AND expiration_date >= $week_start
        AND expiration_date <= $week_end
        AND is_reviewed = 1 AND document_id IN (SELECT id FROM documents WHERE tenant_id = $tenant_id)
    `).get({ $week_start: week_start, $week_end: week_end, $tenant_id: tenantId }) as { count: number }).count;

    // Needs review: items where is_reviewed = 0
    const needsReview = (db.query(`
      SELECT COUNT(*) as count
      FROM document_extractions de
      JOIN documents d ON de.document_id = d.id
      WHERE de.is_reviewed = 0 AND d.tenant_id = $tenant_id
    `).get({ $tenant_id: tenantId }) as { count: number }).count;

    // Weekly report recipients configured for at least one client? The Monday
    // scheduler only emails clients with weekly_report_recipients set, so the
    // dashboard can surface a "reports not configured" banner while it's false.
    const weeklyConfigured = (db.query(`
      SELECT COUNT(*) as count
      FROM client_email_config cec
      JOIN clients cl ON cl.id = cec.client_id
      WHERE cl.tenant_id = $tenant_id
        AND cec.weekly_report_recipients IS NOT NULL
        AND cec.weekly_report_recipients != ''
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
      weekly_reports_configured: weeklyConfigured > 0,
    });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── Clear-to-Pay Dashboard ─────────────────────────────

app.get("/api/dashboard/clear-to-pay", (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    // Fill the derived score columns for any vendor that predates the score
    // feature (no-op SELECT once every vendor is scored).
    refreshMissingScores(tenantId);
    const rows = db.query(`
      SELECT v.id AS vendor_id, v.name AS vendor_name,
             cl.id AS client_id, cl.name AS client_name,
             cs.status, cs.payment_status, cs.compliance_score, cs.score_label
      FROM compliance_status cs
      JOIN vendors v ON v.id = cs.vendor_id
      JOIN clients cl ON cl.id = cs.client_id
      WHERE cs.payment_status IN ('approved', 'review', 'hold')
        AND v.tenant_id = $tenant_id AND cl.tenant_id = $tenant_id
      ORDER BY cs.payment_status, v.name COLLATE NOCASE
    `).all({ $tenant_id: tenantId }) as Array<{
      vendor_id: number; vendor_name: string; client_id: number; client_name: string;
      status: string; payment_status: string;
      compliance_score: number | null; score_label: string | null;
    }>;

    if (rows.length === 0) {
      // No vendor readiness rows — but the tenant may still have projects, and
      // the Projects page would show them. Return the same keys either way so
      // the SPA never has to branch on a missing field.
      const empty = buildProjectGroups(tenantId, []);
      return c.json({ vendors: [], projects: empty.groups, unassigned_vendor_count: 0 });
    }

    // Batch the per-vendor lookups: 3 queries TOTAL (required docs by client,
    // present docs by vendor, earliest expiring by vendor), keyed on the
    // tenant-filtered rows above, joined in memory. All IDs are derived from
    // the tenant-scoped outer query; tenant_id filters are kept on every one.
    const clientIds = [...new Set(rows.map((r) => r.client_id))];
    const vendorIds = rows.map((r) => r.vendor_id);
    const $clientIds = JSON.stringify(clientIds);
    const $vendorIds = JSON.stringify(vendorIds);

    const requiredRows = db.query(`
      SELECT client_id, document_type, coverage_requirement FROM client_required_documents
      WHERE client_id IN (SELECT value FROM json_each($client_ids))
        AND client_id IN (SELECT id FROM clients WHERE tenant_id = $tenant_id)
      ORDER BY client_id, document_type
    `).all({ $client_ids: $clientIds, $tenant_id: tenantId }) as Array<{ client_id: number; document_type: string; coverage_requirement: string | null }>;

    const presentRows = db.query(`
      SELECT DISTINCT d.vendor_id, d.document_type
      FROM documents d
      WHERE d.vendor_id IN (SELECT value FROM json_each($vendor_ids))
        AND d.tenant_id = $tenant_id
    `).all({ $vendor_ids: $vendorIds, $tenant_id: tenantId }) as Array<{ vendor_id: number; document_type: string }>;

    // Coverage enforcement surfacing (owner "Simple"): per-vendor extracted
    // limits by doc type, matched against the client's requirement below. Only
    // gate-covered types (GL/WC/Auto/Umbrella) matter; NULL extracted → unreadable.
    const coverageRows = db.query(`
      SELECT d.vendor_id, d.document_type,
             de.coverage_gl_occurrence, de.coverage_wc_employers,
             de.coverage_auto_csl, de.coverage_umbrella
      FROM document_extractions de
      JOIN documents d ON d.id = de.document_id
      WHERE d.vendor_id IN (SELECT value FROM json_each($vendor_ids))
        AND d.tenant_id = $tenant_id
        AND de.is_reviewed = 1
    `).all({ $vendor_ids: $vendorIds, $tenant_id: tenantId }) as Array<{
      vendor_id: number; document_type: string;
      coverage_gl_occurrence: number | null; coverage_wc_employers: number | null;
      coverage_auto_csl: number | null; coverage_umbrella: number | null;
    }>;

    const expiringRows = db.query(`
      SELECT d.vendor_id, de.expiration_date, COALESCE(de.document_type, d.document_type) AS document_type
      FROM document_extractions de
      JOIN documents d ON d.id = de.document_id
      WHERE d.vendor_id IN (SELECT value FROM json_each($vendor_ids))
        AND d.tenant_id = $tenant_id
        AND de.expiration_date IS NOT NULL
      ORDER BY de.expiration_date ASC, d.id ASC
    `).all({ $vendor_ids: $vendorIds, $tenant_id: tenantId }) as Array<{ vendor_id: number; expiration_date: string; document_type: string }>;

    const requiredByClient = new Map<number, string[]>();
    const requirementFor = new Map<string, string | null>();
    for (const r of requiredRows) {
      const arr = requiredByClient.get(r.client_id);
      if (arr) arr.push(r.document_type);
      else requiredByClient.set(r.client_id, [r.document_type]);
      requirementFor.set(`${r.client_id}:${r.document_type}`, r.coverage_requirement ?? null);
    }
    const presentByVendor = new Map<number, Set<string>>();
    for (const r of presentRows) {
      const s = presentByVendor.get(r.vendor_id);
      if (s) s.add(r.document_type);
      else presentByVendor.set(r.vendor_id, new Set([r.document_type]));
    }
    // Gate-covered doc type → which extracted column to read.
    const COV_COL: Record<string, keyof typeof coverageRows[number]> = {
      "General Liability": "coverage_gl_occurrence",
      "Workers Comp": "coverage_wc_employers",
      "Commercial Auto": "coverage_auto_csl",
      "Umbrella": "coverage_umbrella",
    };
    const coverageByVendorType = new Map<string, number | null>();
    for (const r of coverageRows) {
      const col = COV_COL[r.document_type];
      if (!col) continue;
      coverageByVendorType.set(`${r.vendor_id}:${r.document_type}`, r[col] ?? null);
    }
    const expiringByVendor = new Map<number, { expiration_date: string; document_type: string }>();
    for (const r of expiringRows) {
      if (!expiringByVendor.has(r.vendor_id)) {
        expiringByVendor.set(r.vendor_id, { expiration_date: r.expiration_date, document_type: r.document_type });
      }
    }

    const vendors: ClearToPayVendor[] = rows.map((row) => {
      const requiredTypes = requiredByClient.get(row.client_id) ?? [];
      const presentTypes = presentByVendor.get(row.vendor_id) ?? new Set<string>();
      const missingDocuments = requiredTypes.filter((type) => !presentTypes.has(type));
      const expiring = expiringByVendor.get(row.vendor_id) ?? null;

      // Build a coverage reason for this vendor (the reason text the card shows).
      const coverageReasons: string[] = [];
      for (const type of requiredTypes) {
        const col = COV_COL[type];
        if (!col) continue;
        // A type the vendor has NO document for is a plain "Missing: …" — the
        // coverage gate never ran on it, so it must not also claim the limit is
        // unreadable (that read as two contradictory reasons on one card).
        if (!presentTypes.has(type)) continue;
        const required = parseCoverageRequirement(requirementFor.get(`${row.client_id}:${type}`) ?? null);
        if (required == null) continue;
        const extracted = coverageByVendorType.get(`${row.vendor_id}:${type}`) ?? null;
        if (extracted == null) {
          coverageReasons.push(`${type} coverage limit not readable`);
        } else if (extracted < required) {
          coverageReasons.push(`${type} coverage ${extracted.toLocaleString()} below required ${required.toLocaleString()}`);
        }
      }
      // Compose a single reason string mirroring the weekly report lists.
      const reasonParts: string[] = [];
      if (missingDocuments.length > 0) reasonParts.push(`Missing: ${missingDocuments.join(", ")}`);
      if (coverageReasons.length > 0) reasonParts.push(coverageReasons.join("; "));
      if (expiring) reasonParts.push(`${expiring.document_type} expires ${expiring.expiration_date}`);
      const reason = reasonParts.join("; ") || (row.payment_status === "hold" ? "Held" : row.payment_status === "review" ? "Review required" : "All required documents current");

      return {
        vendor_id: row.vendor_id,
        vendor_name: row.vendor_name,
        client_id: row.client_id,
        client_name: row.client_name,
        compliance_status: missingDocuments.length > 0 ? "missing" : row.status,
        payment_status: row.payment_status,
        // Derived 0-100 vendor score + band, straight from the engine's rollup
        // (null only for a vendor that has never been scored).
        compliance_score: row.compliance_score ?? null,
        score_label: row.score_label ?? null,
        missing_documents: missingDocuments,
        earliest_expiring_date: expiring?.expiration_date ?? null,
        earliest_expiring_type: expiring?.document_type ?? null,
        reason,
      };
    });

    const { groups: projects, assignedVendorIds } = buildProjectGroups(tenantId, vendors);

    return c.json({
      vendors,
      // Per-project grouping — "is everyone on Project X clear to pay?".
      // Empty for a tenant with no projects, which leaves the flat view above
      // exactly as it was.
      projects,
      // Vendors on this dashboard that belong to no project. A nudge only:
      // being unassigned says nothing about a vendor's compliance.
      unassigned_vendor_count: projects.length === 0
        ? 0
        : vendors.filter((v) => !assignedVendorIds.has(v.vendor_id)).length,
    });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
