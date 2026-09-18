import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { logAudit } from "../middleware";
import { listVendorsForTenant } from "../lib/vendor-list";

const app = new Hono();

/**
 * Projects ("jobsites") — clients group vendors by project so they can ask
 * "is everyone on Project X clear to pay?".
 *
 * Tenant isolation is strict on every endpoint:
 *  - a project is only ever read/updated/deleted with `tenant_id = $tenant_id`
 *    (a foreign or unknown id is a 404, never a hint that it exists elsewhere);
 *  - a vendor may only be assigned when it belongs to the SAME tenant;
 *  - vendor_projects has no tenant_id of its own, so every link read/write joins
 *    through the tenant's own project row (and, on assign, the tenant's own
 *    vendor row).
 *
 * Readiness counts come from the same compliance_status table the dashboard and
 * weekly report use, so the project summary can never disagree with the vendor's
 * own payment status. It is a flagging aid: the client still verifies coverage.
 */

const MAX_NAME_LENGTH = 120;
const MAX_ASSIGN_BATCH = 500;

interface ProjectRow {
  id: number;
  tenant_id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

/** Trim + length-cap a project name; null when absent/blank (caller returns 400). */
function cleanProjectName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

/** The caller's own project, or undefined — a foreign id is indistinguishable from an unknown one. */
function findProject(tenantId: number, projectId: number): ProjectRow | undefined {
  const db = getDb();
  return db.query(
    "SELECT id, tenant_id, name, created_at, updated_at FROM projects WHERE id = $id AND tenant_id = $tenant_id"
  ).get({ $id: projectId, $tenant_id: tenantId }) as ProjectRow | undefined;
}

/** Non-negative integer id, else null (rejects NaN / floats / strings / <=0). */
function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Projects with a live readiness summary.
 *
 * vendor_count counts only vendors that still belong to this tenant, and the
 * three payment-status buckets sum to it exactly (a vendor whose link survived a
 * vendor deletion can never inflate the counts), so the client sees a total that
 * always adds up. A project with no vendors reads as 0/0/0.
 */
const PROJECT_SUMMARY_SQL = `
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

interface ProjectSummaryRow {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  vendor_count: number;
  approved_count: number;
  review_count: number;
  hold_count: number;
}

/** Numbers come back as SQLite ints/null — normalize so the API shape is stable. */
function shapeSummary(row: ProjectSummaryRow): Record<string, unknown> {
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

// ── GET /api/projects — list projects with vendor count + readiness summary ──
app.get("/api/projects", (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const rows = db.query(
      `${PROJECT_SUMMARY_SQL} GROUP BY p.id ORDER BY p.name COLLATE NOCASE ASC`
    ).all({ $tenant_id: tenantId }) as ProjectSummaryRow[];
    return c.json(rows.map(shapeSummary));
  } catch (err) {
    return serverError(c, err);
  }
});

// ── GET /api/projects/:id — one project with its readiness summary ───────────
app.get("/api/projects/:id", (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Project not found" }, 404);

    const row = db.query(
      `${PROJECT_SUMMARY_SQL} AND p.id = $id GROUP BY p.id`
    ).get({ $tenant_id: tenantId, $id: id }) as ProjectSummaryRow | undefined;
    if (!row) return c.json({ error: "Project not found" }, 404);

    return c.json(shapeSummary(row));
  } catch (err) {
    return serverError(c, err);
  }
});

// ── GET /api/projects/:id/vendors — the project's assigned vendors ───────────
// Same row shape as GET /api/vendors (client name, compliance + payment status,
// score, last vendor-facing email) so the UI can render one table component.
app.get("/api/projects/:id/vendors", (c) => {
  try {
    const tenantId = c.get("tenant_id") as number;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Project not found" }, 404);
    if (!findProject(tenantId, id)) return c.json({ error: "Project not found" }, 404);

    return c.json(listVendorsForTenant(tenantId, { projectId: id }));
  } catch (err) {
    return serverError(c, err);
  }
});

// ── POST /api/projects — create a project ────────────────────────────────────
app.post("/api/projects", async (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const name = cleanProjectName((body as { name?: unknown }).name);
    if (!name) {
      return c.json({ error: "Project name is required" }, 400);
    }

    // Case-insensitive duplicate check within THIS tenant — two projects called
    // "Maple St" would make the readiness view ambiguous.
    const dup = db.query(
      "SELECT id, name FROM projects WHERE tenant_id = $tenant_id AND name = $name COLLATE NOCASE"
    ).get({ $tenant_id: tenantId, $name: name }) as { id: number; name: string } | undefined;
    if (dup) {
      return c.json({ error: `A project named "${dup.name}" already exists` }, 409);
    }

    const result = db.query(
      "INSERT INTO projects (tenant_id, name) VALUES ($tenant_id, $name)"
    ).run({ $tenant_id: tenantId, $name: name });
    const newId = Number(result.lastInsertRowid);

    logAudit(db, "project", newId, "created", { name });

    return c.json({
      id: newId,
      name,
      vendor_count: 0,
      approved_count: 0,
      review_count: 0,
      hold_count: 0,
      all_clear: false,
    }, 201);
  } catch (err) {
    return serverError(c, err);
  }
});

// ── PUT /api/projects/:id — rename a project ─────────────────────────────────
app.put("/api/projects/:id", async (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Project not found" }, 404);

    const existing = findProject(tenantId, id);
    if (!existing) return c.json({ error: "Project not found" }, 404);

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const name = cleanProjectName((body as { name?: unknown }).name);
    if (!name) return c.json({ error: "Project name is required" }, 400);

    const dup = db.query(
      "SELECT id, name FROM projects WHERE tenant_id = $tenant_id AND name = $name COLLATE NOCASE AND id != $id"
    ).get({ $tenant_id: tenantId, $name: name, $id: id }) as { id: number; name: string } | undefined;
    if (dup) {
      return c.json({ error: `A project named "${dup.name}" already exists` }, 409);
    }

    db.query(
      "UPDATE projects SET name = $name, updated_at = datetime('now') WHERE id = $id AND tenant_id = $tenant_id"
    ).run({ $id: id, $tenant_id: tenantId, $name: name });

    logAudit(db, "project", id, "updated", { name, previous_name: existing.name });

    const row = db.query(`${PROJECT_SUMMARY_SQL} AND p.id = $id GROUP BY p.id`)
      .get({ $tenant_id: tenantId, $id: id }) as ProjectSummaryRow | undefined;
    return c.json(row ? shapeSummary(row) : { id, name });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── DELETE /api/projects/:id — delete a project and its links ────────────────
// The vendor rows themselves are untouched — a project is a grouping, so
// deleting it must never delete or change a vendor's compliance record.
app.delete("/api/projects/:id", (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Project not found" }, 404);

    const existing = findProject(tenantId, id);
    if (!existing) return c.json({ error: "Project not found" }, 404);

    // Explicit link cleanup (the FK also cascades when foreign_keys = ON): the
    // delete is correct either way, and never touches another tenant's rows
    // because the project id itself was matched inside this tenant.
    const removed = db.query("DELETE FROM vendor_projects WHERE project_id = $pid").run({ $pid: id });
    db.query("DELETE FROM projects WHERE id = $id AND tenant_id = $tenant_id").run({ $id: id, $tenant_id: tenantId });

    logAudit(db, "project", id, "deleted", { name: existing.name, links_removed: Number(removed.changes ?? 0) });

    return c.json({ success: true, id, links_removed: Number(removed.changes ?? 0) });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── POST /api/projects/:id/vendors — assign vendors to a project ─────────────
// Body: { vendor_ids: number[] }. Idempotent: re-assigning an already-linked
// vendor is a no-op (UNIQUE(vendor_id, project_id) + INSERT OR IGNORE) and is
// reported in `already_assigned` rather than erroring the whole batch.
app.post("/api/projects/:id/vendors", async (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Project not found" }, 404);
    if (!findProject(tenantId, id)) return c.json({ error: "Project not found" }, 404);

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const raw = (body as { vendor_ids?: unknown }).vendor_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return c.json({ error: "vendor_ids must be a non-empty array of vendor ids" }, 400);
    }
    if (raw.length > MAX_ASSIGN_BATCH) {
      return c.json({ error: `Assign at most ${MAX_ASSIGN_BATCH} vendors at a time` }, 400);
    }

    const vendorIds: number[] = [];
    for (const v of raw) {
      const parsed = parseId(v);
      if (parsed === null) {
        return c.json({ error: "vendor_ids must contain positive integer ids" }, 400);
      }
      if (!vendorIds.includes(parsed)) vendorIds.push(parsed);
    }

    // Every requested vendor must belong to THIS tenant. A cross-tenant id is
    // rejected as "Vendor not found" (404) — the same answer an unknown id gets.
    const owned = db.query(`
      SELECT id FROM vendors
      WHERE tenant_id = $tenant_id AND id IN (SELECT value FROM json_each($ids))
    `).all({ $tenant_id: tenantId, $ids: JSON.stringify(vendorIds) }) as Array<{ id: number }>;
    const ownedIds = new Set(owned.map((o) => o.id));
    const foreign = vendorIds.filter((v) => !ownedIds.has(v));
    if (foreign.length > 0) {
      return c.json({
        error: foreign.length === 1
          ? `Vendor not found: ${foreign[0]}`
          : `Vendors not found: ${foreign.join(", ")}`,
      }, 404);
    }

    const before = (db.query(
      "SELECT COUNT(*) AS c FROM vendor_projects WHERE project_id = $pid"
    ).get({ $pid: id }) as { c: number }).c;

    const insert = db.query(
      "INSERT OR IGNORE INTO vendor_projects (vendor_id, project_id) VALUES ($vendor_id, $project_id)"
    );
    for (const vendorId of vendorIds) insert.run({ $vendor_id: vendorId, $project_id: id });

    const after = (db.query(
      "SELECT COUNT(*) AS c FROM vendor_projects WHERE project_id = $pid"
    ).get({ $pid: id }) as { c: number }).c;

    logAudit(db, "project", id, "vendors_assigned", { vendor_ids: vendorIds, added: after - before });

    return c.json({
      success: true,
      project_id: id,
      vendor_ids: vendorIds,
      assigned: after - before,
      already_assigned: vendorIds.length - (after - before),
      vendor_count: after,
    });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── DELETE /api/projects/:id/vendors/:vendorId — unassign one vendor ─────────
// Removes the link only; documents, compliance status and history are untouched.
app.delete("/api/projects/:id/vendors/:vendorId", (c) => {
  try {
    const db = getDb();
    const tenantId = c.get("tenant_id") as number;
    const id = parseId(c.req.param("id"));
    const vendorId = parseId(c.req.param("vendorId"));
    if (id === null) return c.json({ error: "Project not found" }, 404);
    if (vendorId === null) return c.json({ error: "Vendor not found" }, 404);
    if (!findProject(tenantId, id)) return c.json({ error: "Project not found" }, 404);

    const vendor = db.query(
      "SELECT id, name FROM vendors WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: vendorId, $tenant_id: tenantId }) as { id: number; name: string } | undefined;
    if (!vendor) return c.json({ error: "Vendor not found" }, 404);

    const result = db.query(
      "DELETE FROM vendor_projects WHERE project_id = $pid AND vendor_id = $vid"
    ).run({ $pid: id, $vid: vendorId });
    if (Number(result.changes ?? 0) === 0) {
      return c.json({ error: "Vendor is not assigned to this project" }, 404);
    }

    logAudit(db, "project", id, "vendor_unassigned", { vendor_id: vendorId, vendor_name: vendor.name });

    return c.json({ success: true, project_id: id, vendor_id: vendorId });
  } catch (err) {
    return serverError(c, err);
  }
});

export default app;
