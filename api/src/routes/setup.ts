import { Hono } from "hono";
import { getDb } from "../db";
import { requireAuth, requireTenant, findWizard, logAudit } from "../middleware";
import type { TenantRow } from "../middleware";

const app = new Hono();

// ── Setup Wizard ────────────────────────────────────────

const PAYMENT_WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

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
        inbox_address: tenant.inbox_slug ? `cleartopay-compliance-0d8d884b+${tenant.inbox_slug}@ctomail.io` : null,
      },
      wizard: wizard
        ? {
            status: wizard.status,
            current_step: wizard.current_step,
            company_name: wizard.company_name,
            company_address: wizard.company_address,
            payment_week_start_day: wizard.payment_week_start_day,
            completed_at: wizard.completed_at,
          }
        : null,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/setup — saves setup wizard data; completes the wizard when all required fields are filled
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
          current_step = 'confirmation',
          updated_at = datetime('now')
      WHERE tenant_id = $tid
    `).run({
      $company_name: company_name || null,
      $company_address: company_address || null,
      $day: payment_week_start_day,
      $tid: tenantId,
    });

    // Update tenant name to company_name (if provided) + payment week start day
    if (company_name) {
      const slugBase = company_name.toLowerCase().replace(/[\s_-]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "company";
      const current = db.query("SELECT inbox_slug FROM tenants WHERE id=$id").get({$id:tenantId}) as {inbox_slug:string|null}|undefined;
      let slug = current?.inbox_slug || slugBase, suffix=2;
      while (!current?.inbox_slug && db.query("SELECT id FROM tenants WHERE inbox_slug=$slug AND id!=$id").get({$slug:slug,$id:tenantId})) slug = `${slugBase.slice(0, Math.max(1,40-String(suffix).length-1))}-${suffix++}`;
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

    if (allFilled) {
      db.query(`
        UPDATE setup_wizard
        SET status = 'COMPLETED', current_step = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE tenant_id = $tid
      `).run({ $tid: tenantId });
      logAudit(db, "tenant", tenantId, "setup_completed", {
        company_name: wizard.company_name,
        company_address: wizard.company_address,
        payment_week_start_day: wizard.payment_week_start_day,
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
      completed: allFilled,
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
        completed_at: wizard.completed_at,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;
