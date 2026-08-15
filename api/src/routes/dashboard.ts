import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { calculatePaymentWeek, getTenantPaymentWeekStartDay } from "../compliance";

const app = new Hono();

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
    const rows = db.query(`
      SELECT v.id AS vendor_id, v.name AS vendor_name,
             cl.id AS client_id, cl.name AS client_name,
             cs.status, cs.payment_status
      FROM compliance_status cs
      JOIN vendors v ON v.id = cs.vendor_id
      JOIN clients cl ON cl.id = cs.client_id
      WHERE cs.payment_status IN ('approved', 'review', 'hold')
        AND v.tenant_id = $tenant_id AND cl.tenant_id = $tenant_id
      ORDER BY cs.payment_status, v.name COLLATE NOCASE
    `).all({ $tenant_id: tenantId }) as Array<{
      vendor_id: number; vendor_name: string; client_id: number; client_name: string;
      status: string; payment_status: string;
    }>;

    const vendors = rows.map((row) => {
      const required = db.query(
        "SELECT document_type FROM client_required_documents WHERE client_id = $client_id ORDER BY document_type"
      ).all({ $client_id: row.client_id }) as Array<{ document_type: string }>;
      const present = db.query(`
        SELECT DISTINCT d.document_type
        FROM documents d
        WHERE d.vendor_id = $vendor_id AND d.tenant_id = $tenant_id
      `).all({ $vendor_id: row.vendor_id, $tenant_id: tenantId }) as Array<{ document_type: string }>;
      const presentTypes = new Set(present.map((doc) => doc.document_type));
      const missingDocuments = required.map((doc) => doc.document_type).filter((type) => !presentTypes.has(type));
      const expiring = db.query(`
        SELECT de.expiration_date, COALESCE(de.document_type, d.document_type) AS document_type
        FROM document_extractions de
        JOIN documents d ON d.id = de.document_id
        WHERE d.vendor_id = $vendor_id AND d.tenant_id = $tenant_id
          AND de.expiration_date IS NOT NULL
        ORDER BY de.expiration_date ASC LIMIT 1
      `).get({ $vendor_id: row.vendor_id, $tenant_id: tenantId }) as { expiration_date: string; document_type: string } | null;

      return {
        vendor_id: row.vendor_id,
        vendor_name: row.vendor_name,
        client_id: row.client_id,
        client_name: row.client_name,
        compliance_status: missingDocuments.length > 0 ? "missing" : row.status,
        payment_status: row.payment_status,
        missing_documents: missingDocuments,
        earliest_expiring_date: expiring?.expiration_date ?? null,
        earliest_expiring_type: expiring?.document_type ?? null,
      };
    });

    return c.json({ vendors });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
