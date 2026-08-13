import { Hono } from "hono";
import { getDb } from "../db";
import { requireAuth, requireTenant, findWizard, logAudit } from "../middleware";
import { buildInboxAddress, companyNameToSlug } from "../lib/inbox";
import type { TenantRow } from "../middleware";

const app = new Hono();

// ── Setup Wizard ────────────────────────────────────────

const PAYMENT_WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// Wizard steps, persisted granularly so a reload resumes at the exact step.
const WIZARD_STEPS = ["company_info", "payment_week", "compliance", "confirmation", "completed"];

// GET /api/setup — current setup wizard state for the authenticated user's tenant
app.get("/api/setup", requireAuth, requireTenant, (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const tenant = db.query("SELECT * FROM tenants WHERE id = $id").get({ $id: tenantId }) as TenantRow;
    const wizard = findWizard(db, tenantId);

    return c.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        payment_week_start_day: tenant.payment_week_start_day,
        inbox_slug: tenant.inbox_slug,
        inbox_address: buildInboxAddress(tenant.inbox_slug),
      },
      wizard: wizard
        ? {
            status: wizard.status,
            current_step: wizard.current_step,
            company_name: wizard.company_name,
            company_address: wizard.company_address,
            payment_week_start_day: wizard.payment_week_start_day,
            compliance_client_id: wizard.compliance_client_id ?? null,
            completed_at: wizard.completed_at,
          }
        : null,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/setup — saves setup wizard data. The wizard is only marked
// COMPLETED when the final Confirmation step is actually completed (body.confirmed
// === true). Step progress is persisted granularly in current_step so a reload
// resumes at the exact step instead of skipping ahead.
app.post("/api/setup", requireAuth, requireTenant, async (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const body = await c.req.json();

    const company_name = typeof body.company_name === "string" ? body.company_name.trim() : "";
    const company_address = typeof body.company_address === "string" ? body.company_address.trim() : "";
    let payment_week_start_day = typeof body.payment_week_start_day === "string"
      ? body.payment_week_start_day.trim().toLowerCase()
      : "monday";
    if (!PAYMENT_WEEK_DAYS.includes(payment_week_start_day)) {
      return c.json({ error: `payment_week_start_day must be one of: ${PAYMENT_WEEK_DAYS.join(", ")}` }, 400);
    }
    // Explicit step the client is on — persisted so resume is exact.
    let current_step: string | null = null;
    if (typeof body.current_step === "string" && WIZARD_STEPS.includes(body.current_step.trim().toLowerCase())) {
      current_step = body.current_step.trim().toLowerCase();
    }
    // Explicit confirmation: the final step's "Confirm & Get Started" button.
    const confirmed = body.confirmed === true || body.confirmed === "true";
    // Optional: the tenant's own client row that the Compliance Requirements step
    // attached its required docs to (used by the wizard resume logic).
    let compliance_client_id: number | null = null;
    if (body.compliance_client_id != null) {
      const cid = Number(body.compliance_client_id);
      const owned = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tid").get({ $id: cid, $tid: tenantId });
      if (!owned) return c.json({ error: "compliance_client_id does not belong to this tenant" }, 400);
      compliance_client_id = cid;
    }

    let wizard = findWizard(db, tenantId);
    if (!wizard) {
      db.query("INSERT INTO setup_wizard (tenant_id) VALUES ($tid)").run({ $tid: tenantId });
      wizard = findWizard(db, tenantId)!;
    }

    // Save wizard data (only overwrite non-empty values)
    db.query(`
      UPDATE setup_wizard
      SET company_name = COALESCE($company_name, company_name),
          company_address = COALESCE($company_address, company_address),
          payment_week_start_day = $day,
          compliance_client_id = COALESCE($compliance_client_id, compliance_client_id),
          current_step = COALESCE($current_step, current_step),
          updated_at = datetime('now')
      WHERE tenant_id = $tid
    `).run({
      $company_name: company_name || null,
      $company_address: company_address || null,
      $day: payment_week_start_day,
      $compliance_client_id: compliance_client_id,
      $current_step: current_step,
      $tid: tenantId,
    });

    // Update tenant name to company_name (if provided) + payment week start day.
    // The user's profile name (full_name) stays in sync with the company name:
    // the account profile name IS the company name.
    if (company_name) {
      const authUser = c.get("user") as { user_id: number } | undefined;
      if (authUser?.user_id) {
        db.query("UPDATE users SET full_name = $name, company_name = $name WHERE id = $uid").run({
          $name: company_name,
          $uid: authUser.user_id,
        });
      }
      // Per-company slug: company name with all non-alphanumeric characters
      // removed, case preserved ("ABC Company" → "ABCCompany"). Only generated
      // when the tenant has no slug yet; existing slugs (incl. backfilled ones)
      // are kept so the submission address stays stable.
      const slugBase = companyNameToSlug(company_name);
      const current = db.query("SELECT inbox_slug FROM tenants WHERE id=$id").get({$id:tenantId}) as {inbox_slug:string|null}|undefined;
      let slug = current?.inbox_slug || slugBase, suffix=2;
      while (!current?.inbox_slug && db.query("SELECT id FROM tenants WHERE inbox_slug=$slug COLLATE NOCASE AND id!=$id").get({$slug:slug,$id:tenantId})) slug = `${slugBase.slice(0, Math.max(1, 60 - String(suffix).length))}${suffix++}`;
      db.query(`
        UPDATE tenants SET name = $name, inbox_slug = $slug, payment_week_start_day = $day, updated_at = datetime('now')
        WHERE id = $id
      `).run({ $name: company_name, $slug: slug, $day: payment_week_start_day, $id: tenantId });
    } else {
      db.query(`
        UPDATE tenants SET payment_week_start_day = $day, updated_at = datetime('now')
        WHERE id = $id
      `).run({ $day: payment_week_start_day, $id: tenantId });
    }

    wizard = findWizard(db, tenantId)!;
    const allFilled = !!(wizard.company_name && wizard.company_address && wizard.payment_week_start_day);

    // COMPLETED is only reached by explicitly confirming the final step.
    // Saving earlier steps (even with every field filled) keeps the wizard
    // IN_PROGRESS so a reload resumes at the exact step.
    if (confirmed && allFilled) {
      db.query(`
        UPDATE setup_wizard
        SET status = 'COMPLETED', current_step = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE tenant_id = $tid
      `).run({ $tid: tenantId });
      logAudit(db, "tenant", tenantId, "setup_completed", {
        company_name: wizard.company_name,
        company_address: wizard.company_address,
        payment_week_start_day: wizard.payment_week_start_day,
        confirmed: true,
      });
    } else {
      db.query(`
        UPDATE setup_wizard SET status = 'IN_PROGRESS', updated_at = datetime('now')
        WHERE tenant_id = $tid
      `).run({ $tid: tenantId });
    }

    wizard = findWizard(db, tenantId)!;
    const tenant = db.query("SELECT * FROM tenants WHERE id = $id").get({ $id: tenantId }) as TenantRow;

    return c.json({
      success: true,
      completed: wizard.status === "COMPLETED",
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        payment_week_start_day: tenant.payment_week_start_day,
      },
      wizard: {
        status: wizard.status,
        current_step: wizard.current_step,
        company_name: wizard.company_name,
        company_address: wizard.company_address,
        payment_week_start_day: wizard.payment_week_start_day,
        compliance_client_id: wizard.compliance_client_id ?? null,
        completed_at: wizard.completed_at,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;
