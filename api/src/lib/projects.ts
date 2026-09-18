import { getDb } from "../db";

/**
 * The ONE project-readiness query behind GET /api/projects, GET /api/projects/:id
 * and the dashboard's "By project" section.
 *
 * Readiness is counted from the same compliance_status rows the dashboard,
 * the Projects page and the weekly report use, so a project can never report a
 * number that disagrees with the vendor's own payment status. It is a flagging
 * aid: the client still reviews the source documents and verifies coverage.
 *
 * Keeping the SQL here means the dashboard's per-project answer is guaranteed to
 * match the Projects page exactly — it is literally the same query.
 */

export interface ProjectSummary {
  id: number;
  name: string;
  vendor_count: number;
  approved_count: number;
  review_count: number;
  hold_count: number;
  /** "Every vendor on this project is approved for payment" (needs >= 1 vendor). */
  all_clear: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectSummaryRow {
  id: number;
  name: string;
  created_at?: string;
  updated_at?: string;
  vendor_count: number | null;
  approved_count: number | null;
  review_count: number | null;
  hold_count: number | null;
}

/**
 * Projects with a live readiness summary.
 *
 * vendor_count counts only vendors that still belong to this tenant, and the
 * three payment-status buckets sum to it exactly (a vendor whose link survived a
 * vendor deletion can never inflate the counts), so the client sees a total that
 * always adds up. A project with no vendors reads as 0/0/0.
 */
export const PROJECT_SUMMARY_SQL = `
  SELECT p.id, p.name, p.created_at, p.updated_at,
    COUNT(v.id) AS vendor_count,
    SUM(CASE WHEN v.id IS NOT NULL AND COALESCE(cs.payment_status, 'hold') = 'approved' THEN 1 ELSE 0 END) AS approved_count,
    SUM(CASE WHEN v.id IS NOT NULL AND COALESCE(cs.payment_status, 'hold') = 'review' THEN 1 ELSE 0 END) AS review_count,
    SUM(CASE WHEN v.id IS NOT NULL AND COALESCE(cs.payment_status, 'hold') = 'hold' THEN 1 ELSE 0 END) AS hold_count
  FROM projects p
  LEFT JOIN vendor_projects vp ON vp.project_id = p.id
  LEFT JOIN vendors v ON v.id = vp.vendor_id AND v.tenant_id = p.tenant_id
  LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
  WHERE p.tenant_id = $tenant_id
`;

/** Numbers come back as SQLite ints/null — normalize so the API shape is stable. */
export function shapeProjectSummary(row: ProjectSummaryRow): ProjectSummary {
  const vendorCount = Number(row.vendor_count ?? 0);
  const approved = Number(row.approved_count ?? 0);
  const review = Number(row.review_count ?? 0);
  const hold = Number(row.hold_count ?? 0);
  return {
    id: row.id,
    name: row.name,
    vendor_count: vendorCount,
    approved_count: approved,
    review_count: review,
    hold_count: hold,
    // "Everyone on this project is approved for payment" — only claimable when
    // the project actually has vendors and every one of them is approved.
    all_clear: vendorCount > 0 && approved === vendorCount && review === 0 && hold === 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** This tenant's projects, each with its live readiness summary (name order). */
export function listProjectSummaries(tenantId: number): ProjectSummary[] {
  const db = getDb();
  const rows = db.query(
    `${PROJECT_SUMMARY_SQL} GROUP BY p.id ORDER BY p.name COLLATE NOCASE ASC`
  ).all({ $tenant_id: tenantId }) as ProjectSummaryRow[];
  return rows.map(shapeProjectSummary);
}

/**
 * vendor_id → the tenant's projects that vendor is assigned to.
 *
 * Both sides are tenant-scoped: the join only ever walks this tenant's project
 * rows, and the vendor list is intersected with `vendors.tenant_id`. Restricting
 * to `vendorIds` keeps the dashboard's answer to one query instead of one per
 * project.
 */
export function projectAssignmentsForVendors(
  tenantId: number,
  vendorIds: number[],
): Array<{ project_id: number; vendor_id: number }> {
  if (vendorIds.length === 0) return [];
  const db = getDb();
  return db.query(`
    SELECT vp.project_id, vp.vendor_id
    FROM vendor_projects vp
    JOIN projects p ON p.id = vp.project_id AND p.tenant_id = $tenant_id
    WHERE vp.vendor_id IN (SELECT value FROM json_each($vendor_ids))
      AND vp.vendor_id IN (SELECT id FROM vendors WHERE tenant_id = $tenant_id)
  `).all({
    $tenant_id: tenantId,
    $vendor_ids: JSON.stringify(vendorIds),
  }) as Array<{ project_id: number; vendor_id: number }>;
}
