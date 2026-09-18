import { getDb } from "../db";
import { refreshMissingScores } from "../compliance";

/**
 * The ONE vendor-list query behind both GET /api/vendors and
 * GET /api/projects/:id/vendors.
 *
 * Keeping it in one place means the project-grouped vendor view is guaranteed to
 * carry the same shape as the Vendors page: client name, compliance status,
 * payment status, derived score, and the last vendor-facing email on file.
 *
 * Tenant isolation: the query filters `vendors.tenant_id = $tenant_id` on the
 * outer table, the project filter goes through the tenant's OWN project row, and
 * the email_log sub-join re-checks the vendor belongs to this tenant (email_log
 * has no tenant_id column). A caller can therefore never see or reach another
 * tenant's vendor, even by passing a foreign id.
 */

// Email types that are addressed TO a vendor (an outreach the vendor received).
// renewal_reminder: expiring-document nudge (scheduler.ts + manual send in
// routes/emails.ts). inbox_rejection: "some documents you sent couldn't be
// read" reply from the compliance inbox. vendor_request: the client-initiated
// "Request updated docs" email sent from the vendor detail page. Any future
// vendor-facing type must be added here or it will not show up as outreach.
const VENDOR_FACING_EMAIL_TYPES = "'renewal_reminder', 'inbox_rejection', 'vendor_request'";

export interface VendorListFilters {
  /** Only vendors under this client (must belong to the same tenant). */
  clientId?: number | null;
  /** Only vendors assigned to this project (must belong to the same tenant). */
  projectId?: number | null;
}

export function listVendorsForTenant(
  tenantId: number,
  filters: VendorListFilters = {},
): Array<Record<string, unknown>> {
  const db = getDb();

  // Cheap self-healing backfill: fills the derived score columns for vendors
  // whose compliance row predates the score feature. One no-op SELECT once
  // every vendor has been scored.
  refreshMissingScores(tenantId);

  let sql = `
    SELECT v.id, v.client_id, c.name AS client_name,
      v.name, v.contact_name, v.contact_email, v.contact_phone,
      v.insurance_agent_email,
      COALESCE(cs.status, 'needs_review') AS compliance_status,
      COALESCE(cs.payment_status, 'hold') AS payment_status,
      cs.compliance_score, cs.score_label,
      le.sent_at AS last_emailed_at,
      le.email_type AS last_email_type,
      le.status AS last_email_status,
      v.created_at, v.updated_at
    FROM vendors v
    JOIN clients c ON v.client_id = c.id
    LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
    LEFT JOIN email_log le ON le.id = (
      SELECT el.id FROM email_log el
      WHERE el.vendor_id = v.id
        AND el.vendor_id IN (SELECT id FROM vendors WHERE tenant_id = $tenant_id)
        AND el.email_type IN (${VENDOR_FACING_EMAIL_TYPES})
      ORDER BY el.sent_at DESC, el.id DESC
      LIMIT 1
    )
  `;

  const params: Record<string, unknown> = { $tenant_id: tenantId };
  sql += " WHERE v.tenant_id = $tenant_id";

  if (filters.clientId) {
    sql += " AND v.client_id = $client_id";
    params.$client_id = filters.clientId;
  }

  if (filters.projectId) {
    // The sub-select is itself tenant-scoped, so a foreign project id simply
    // matches no rows (an empty list, never another tenant's vendors).
    sql += ` AND v.id IN (
      SELECT vp.vendor_id FROM vendor_projects vp
      WHERE vp.project_id = $project_id
        AND vp.project_id IN (SELECT id FROM projects WHERE tenant_id = $tenant_id)
    )`;
    params.$project_id = filters.projectId;
  }

  sql += " ORDER BY v.name ASC";

  return db.query(sql).all(params) as Array<Record<string, unknown>>;
}
