import { Hono } from "hono";
import { serverError } from "../errors";
import { getDb } from "../db";
import { requireAuth, requireAdmin, requirePartner, logAudit } from "../middleware";
import { calculateCommissions, runPartnerPayouts } from "../commissions";
import { getStripe, partnerConnectStatus, getPartnerStripeRow, PARTNER_PORTAL_CONNECT_URL } from "../stripe-connect";
import { sendEmail, buildSetupPasswordEmail } from "../email";
import { getAppBaseUrl } from "../app-base-url";
import { storagePut, storageGetStream, storageDelete } from "../storage";
import { validateAttachment, isHeicFile } from "../attachments";
import { rateLimitAuth } from "../rate-limit";

const app = new Hono();

// ── Partner Program ──────────────────────────────────────

// Partner-specific audit log (extends audit_logs with a reason field)
export function logPartnerAudit(db: ReturnType<typeof getDb>, partnerId: number, action: string, changes: Record<string, unknown> | null = null, reason: string | null = null, performedBy: string = "admin") {
  db.query(`
    INSERT INTO partner_audit_log (partner_id, action, changes, reason, performed_by)
    VALUES ($pid, $action, $changes, $reason, $by)
  `).run({
    $pid: partnerId,
    $action: action,
    $changes: changes ? JSON.stringify(changes) : null,
    $reason: reason,
    $by: performedBy,
  });
}

// Generate a unique uppercase referral code: LASTNAME + 3 random chars (e.g. SMITHX7K)
function generateReferralCode(db: ReturnType<typeof getDb>, lastName: string): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I for readability
  const base = (lastName || "PARTNER").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8) || "PARTNER";
  for (let attempt = 0; attempt < 100; attempt++) {
    let suffix = "";
    for (let i = 0; i < 3; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    const code = `${base}${suffix}`;
    const exists = db.query("SELECT id FROM partners WHERE referral_code = $code").get({ $code: code });
    if (!exists) return code;
  }
  return `${base}${Date.now().toString(36).toUpperCase().slice(-3)}`;
}

// ── W-9 upload helper (shared by unauthenticated apply-inline and the
//    auth-gated POST /api/partners/w9) ────────────────────
// Stores the W-9 in object storage under partners/<id>/w9-<ts>.<ext>, records
// the file key/filename/upload-time on the partners row, flips tax_info_status
// to 'submitted', and — the key rule — only NOW generates the referral code if
// it is still NULL (the code must not exist before a W-9 is on file).
async function ingestW9(
  db: ReturnType<typeof getDb>,
  partnerId: number,
  file: File,
  performedBy: string,
): Promise<{ ok: true; referral_code: string | null; w9_file_key: string; w9_filename: string; generated: boolean } | { ok: false; reason: string }> {
  const validation = validateAttachment({ filename: file.name, contentType: file.type, size: file.size });
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const extMatch = /\.([a-z0-9]{1,8})$/i.exec(file.name);
  const extFromName = extMatch ? extMatch[1].toLowerCase() : "";
  const extByType =
    file.type === "application/pdf" ? "pdf"
    : file.type === "image/png" ? "png"
    : file.type === "image/jpeg" ? "jpg"
    : "";
  const ext = extByType || (extFromName === "jpg" || extFromName === "jpeg" || extFromName === "png" || extFromName === "pdf" ? (extFromName === "jpeg" ? "jpg" : extFromName) : "pdf");

  const now = Date.now();
  const key = `partners/${partnerId}/w9-${now}.${ext}`;
  const content = new Uint8Array(await file.arrayBuffer());
  await storagePut(key, content, file.type || "application/pdf");

  const partner = db.query("SELECT id, last_name, referral_code FROM partners WHERE id = $id").get({ $id: partnerId }) as { id: number; last_name: string; referral_code: string | null } | undefined;
  if (!partner) {
    await storageDelete(key).catch(() => {});
    return { ok: false, reason: "Partner not found" };
  }

  let referralCode = partner.referral_code;
  let generated = false;
  if (!referralCode) {
    referralCode = generateReferralCode(db, partner.last_name);
    generated = true;
  }

  db.query(`
    UPDATE partners SET
      w9_file_key = $key,
      w9_filename = $filename,
      w9_uploaded_at = datetime('now'),
      tax_info_status = 'submitted',
      referral_code = $code,
      updated_at = datetime('now')
    WHERE id = $id
  `).run({ $key: key, $filename: file.name, $code: referralCode, $id: partnerId });

  logPartnerAudit(db, partnerId, "w9_uploaded", { w9_filename: file.name, w9_file_key: key, referral_code_generated: generated, tax_info_status: "submitted" }, null, performedBy);
  logAudit(db, "partner", partnerId, "w9_uploaded", { w9_filename: file.name, w9_file_key: key, referral_code_generated: generated });

  return { ok: true, referral_code: referralCode, w9_file_key: key, w9_filename: file.name, generated };
}

// TODO: revert to www.cleartopayconstruction.com once the domain is restored
const PARTNER_REFERRAL_LINK_BASE = "https://cleartopay.ctonew.app/get-started";

// ── Partner Application (public, no auth) ────────────────

app.post("/api/partners/apply", async (c) => {
  try {
    // Accept either JSON (existing API consumers/tests) or multipart/form-data
    // (the SPA register form, which sends the optional W-9 file in the same
    // request). Text-field validation is identical for both shapes.
    const contentType = c.req.header("content-type") || "";
    let body: Record<string, unknown> = {};
    let w9File: File | null = null;
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData().catch(() => null);
      if (!form) return c.json({ error: "Invalid multipart body" }, 400);
      for (const key of ["first_name", "last_name", "company_name", "email", "phone", "address", "website", "states_served", "partner_type", "tax_info_status", "preferred_payout_method", "hear_about_us"]) {
        const v = form.get(key);
        if (v !== null) body[key] = String(v);
      }
      const f = form.get("w9");
      if (f instanceof File && f.size > 0) w9File = f;
    } else {
      body = await c.req.json().catch(() => ({}));
    }
    const { first_name, last_name, company_name, email, phone, address, website, states_served, partner_type, tax_info_status, preferred_payout_method, hear_about_us } = body as Record<string, string | undefined>;

    // Throttle partner applications (per IP + email) — 5/hour, same as signup.
    const applyDenied = rateLimitAuth(c, "partner-apply", email ?? "", 5, 5, 60 * 60 * 1000);
    if (applyDenied) return applyDenied;

    if (!first_name || typeof first_name !== "string" || !first_name.trim()) return c.json({ error: "first_name is required" }, 400);
    if (!last_name || typeof last_name !== "string" || !last_name.trim()) return c.json({ error: "last_name is required" }, 400);
    if (!email || typeof email !== "string" || !email.includes("@")) return c.json({ error: "Valid email is required" }, 400);
    if (!partner_type || typeof partner_type !== "string" || !partner_type.trim()) return c.json({ error: "partner_type is required" }, 400);

    const db = getDb();
    const normalizedEmail = email.trim().toLowerCase();

    const existing = db.query("SELECT id FROM users WHERE email = $email").get({ $email: normalizedEmail });
    if (existing) return c.json({ error: "A user with this email already exists" }, 409);

    // Create a user account with a random password — the partner sets their own
    // password via the emailed set-password link right after applying. Partners
    // are approved instantly (no manual admin step), so the portal opens for
    // them the moment they sign in.
    const randomPassword = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    const passwordHash = await Bun.password.hash(randomPassword);

    const fullName = `${first_name.trim()} ${last_name.trim()}`;
    const userResult = db.query(`
      INSERT INTO users (full_name, company_name, email, password_hash, role)
      VALUES ($full_name, $company_name, $email, $password_hash, 'partner')
    `).run({
      $full_name: fullName,
      $company_name: (company_name && company_name.trim()) || `${last_name.trim()} Agency`,
      $email: normalizedEmail,
      $password_hash: passwordHash,
    });
    const userId = Number(userResult.lastInsertRowid);

    // One-time password-setup token (same mechanism as forgot-password /
    // send-setup-link): random base64url bytes, valid for 1 hour. The token is
    // NEVER returned in this response — it is only emailed to the partner.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Buffer.from(bytes).toString("base64url");
    const tokenExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.query("UPDATE users SET reset_token = $token, reset_token_expires = $expires WHERE id = $id").run({
      $token: token,
      $expires: tokenExpires,
      $id: userId,
    });

    // Approved instantly. The referral code is deliberately NOT generated at
    // apply time — it only exists once a W-9 is uploaded (ingestW9 below or
    // POST /api/partners/w9 later). No W-9 ⇒ no code ⇒ referring is blocked.
    const partnerResult = db.query(`
      INSERT INTO partners (user_id, first_name, last_name, company_name, email, phone, address, website, states_served, partner_type, tax_info_status, preferred_payout_method, hear_about_us, status, referral_code)
      VALUES ($user_id, $first_name, $last_name, $company_name, $email, $phone, $address, $website, $states_served, $partner_type, $tax, $payout_method, $hear_about_us, 'approved', NULL)
    `).run({
      $user_id: userId,
      $first_name: first_name.trim(),
      $last_name: last_name.trim(),
      $company_name: (company_name && company_name.trim()) || null,
      $email: normalizedEmail,
      $phone: (phone && phone.trim()) || null,
      $address: (address && address.trim()) || null,
      $website: (website && website.trim()) || null,
      $states_served: (states_served && states_served.trim()) || null,
      $partner_type: partner_type.trim(),
      $tax: (tax_info_status && tax_info_status.trim()) || "not_submitted",
      $payout_method: (preferred_payout_method && preferred_payout_method.trim()) || null,
      $hear_about_us: (hear_about_us && hear_about_us.trim()) || null,
    });
    const partnerId = Number(partnerResult.lastInsertRowid);

    logPartnerAudit(db, partnerId, "application_submitted", { partner_type: partner_type.trim(), email: normalizedEmail, status: "approved", referral_code: null }, null, normalizedEmail);
    logPartnerAudit(db, partnerId, "application_approved", { referral_code: null, method: "instant" }, null, normalizedEmail);
    logAudit(db, "partner", partnerId, "partner_application", { email: normalizedEmail, partner_type: partner_type.trim(), status: "approved", referral_code: null });

    // Email the set-password link through the normal sendEmail path, which
    // walks the runtime fallback chain (Graph → SMTP → platform queue) so a
    // transient Graph failure still delivers inside the 2-minute window.
    // A delivery hiccup must not fail the application itself — the partner is
    // already approved, and can re-request a setup link if needed.
    try {
      const setupLink = `${getAppBaseUrl()}/app/set-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(normalizedEmail)}`;
      await sendEmail([normalizedEmail], "Set up your ClearToPay password", buildSetupPasswordEmail(fullName, setupLink), undefined, undefined, "password_reset");
    } catch (emailErr) {
      console.error(`[partners] Set-password email failed for partner ${partnerId} (${normalizedEmail}):`, emailErr);
    }

    // Owner application notification — internal, admin-only. The owner wants to
    // know the moment an application comes in, so they can see who signed up.
    // It carries only this applicant's own details; nothing about the platform
    // internals and nothing from other tenants/partners. Same try/catch pattern
    // as the set-password email: a delivery hiccup must never fail the
    // application itself, and no field is added to the apply response (the
    // applicant never sees the owner's address or any notification detail).
    try {
      const ownerNotifyEmail = process.env.OWNER_NOTIFY_EMAIL || "documents@cleartopayconstruction.com";
      const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
      const notifyBodyHtml =
        `<p>A new partner has applied to the ClearToPay Partner Program.</p>` +
        `<p>Name: ${esc(fullName)}<br/>` +
        `Company: ${esc((company_name && company_name.trim()) || "(not provided)")}<br/>` +
        `Email: ${esc(normalizedEmail)}<br/>` +
        `Phone: ${esc((phone && phone.trim()) || "(not provided)")}<br/>` +
        `Partner type: ${esc(partner_type.trim())}<br/>` +
        `States served: ${esc((states_served && states_served.trim()) || "(not provided)")}<br/>` +
        `Applied at: ${esc(new Date().toISOString())}</p>`;
      await sendEmail([ownerNotifyEmail], `New partner application: ${first_name.trim()} ${last_name.trim()}`, notifyBodyHtml, undefined, undefined, "partner_application_notify");
    } catch (notifyErr) {
      console.error(`[partners] Owner application-notification email failed for partner ${partnerId} (${normalizedEmail}):`, notifyErr);
    }

    // Inline W-9 from the register form — nice-to-have at apply time; a bad
    // file must not fail the application (the partner can retry in the portal
    // with a clear reason). If it succeeds, the referral code is now generated.
    let referralCode: string | null = null;
    let w9Uploaded = false;
    let w9Error: string | null = null;
    if (w9File) {
      const w9 = await ingestW9(db, partnerId, w9File, normalizedEmail);
      if (w9.ok) {
        referralCode = w9.referral_code;
        w9Uploaded = true;
      } else {
        w9Error = w9.reason;
      }
    }

    return c.json({
      partner: {
        id: partnerId,
        status: "approved",
        referral_code: referralCode,
        w9_uploaded: w9Uploaded,
        w9_error: w9Error,
        message: "You're approved! Check your inbox for a link to set your password, then sign in to your partner portal.",
      },
    }, 201);
  } catch (err) {
    return serverError(c, err);
  }
});

// POST /api/partners/w9 — upload/replace the partner's W-9 (auth-gated: the
// partner themself OR any admin, who may pass partner_id to upload for a
// specific partner). Accepts multipart/form-data with the file under "w9"
// (or "file" for convenience). Validates type/size (PDF/JPG/PNG, ≤10MB — same
// rules as document uploads), stores the object in R2 under
// partners/<id>/w9-<ts>.<ext>, records it, and generates the referral code
// if it was still NULL. W-9 presence is the gate to referring.
app.post("/api/partners/w9", requireAuth, async (c) => {
  try {
    const db = getDb();
    const user = c.get("user") as { user_id: number; email: string };
    const roleRow = db.query("SELECT role FROM users WHERE id = ?").get(user.user_id) as { role: string } | null;
    const isAdmin = roleRow?.role === "admin";

    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "multipart/form-data body expected with a 'w9' file field" }, 400);
    let file = form.get("w9");
    if (!(file instanceof File) || file.size === 0) {
      const alt = form.get("file");
      if (alt instanceof File && alt.size > 0) file = alt;
    }
    if (!(file instanceof File) || file.size === 0) return c.json({ error: "W-9 file is required (PDF, JPG, or PNG)" }, 400);

    // Resolve the target partner: admin may specify partner_id; otherwise the
    // authenticated user's own partner row (approved partners only).
    let partnerId: number | null = null;
    const pidRaw = form.get("partner_id");
    if (isAdmin && pidRaw !== null && String(pidRaw).trim() !== "") {
      partnerId = Number(pidRaw);
      if (!Number.isInteger(partnerId)) return c.json({ error: "Invalid partner_id" }, 400);
    } else {
      const mine = db.query("SELECT id, status FROM partners WHERE user_id = $uid").get({ $uid: user.user_id }) as { id: number; status: string } | undefined;
      if (!mine) return c.json({ error: "Partner account required" }, 403);
      if (mine.status !== "approved") return c.json({ error: "Partner account not yet approved" }, 403);
      partnerId = mine.id;
    }

    const exists = db.query("SELECT id FROM partners WHERE id = $id").get({ $id: partnerId }) as { id: number } | undefined;
    if (!exists) return c.json({ error: "Partner not found" }, 404);

    const w9 = await ingestW9(db, partnerId, file, isAdmin ? `admin:${user.email}` : user.email);
    if (!w9.ok) return c.json({ error: w9.reason }, 400);

    return c.json({
      partner: {
        id: partnerId,
        w9_uploaded: true,
        w9_filename: w9.w9_filename,
        referral_code: w9.referral_code,
        referral_link: w9.referral_code ? `${PARTNER_REFERRAL_LINK_BASE}?ref=${w9.referral_code}` : null,
        tax_info_status: "submitted",
        message: w9.generated ? "W-9 received — you're ready to refer!" : "W-9 updated.",
      },
    }, 200);
  } catch (err) {
    return serverError(c, err);
  }
});

// GET /api/partners/:id/w9 — ADMIN-ONLY download of the stored W-9 object.
// Partners/clients never see the file or its storage key anywhere else.
app.get("/api/partners/:id/w9", requireAuth, requireAdmin, async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid partner id" }, 400);
    const db = getDb();
    const partner = db.query("SELECT id, w9_file_key, w9_filename FROM partners WHERE id = $id").get({ $id: id }) as { id: number; w9_file_key: string | null; w9_filename: string | null } | undefined;
    if (!partner) return c.json({ error: "Partner not found" }, 404);
    if (!partner.w9_file_key) return c.json({ error: "No W-9 on file for this partner" }, 404);

    const obj = await storageGetStream(partner.w9_file_key);
    if (!obj) return c.json({ error: "W-9 file missing from storage" }, 404);

    logPartnerAudit(db, id, "w9_downloaded", { w9_filename: partner.w9_filename }, null, c.get("user").email);
    logAudit(db, "partner", id, "w9_downloaded", { w9_filename: partner.w9_filename });

    const filename = partner.w9_filename || `partner-${id}-w9`;
    c.header("Content-Type", obj.contentType || "application/pdf");
    c.header("Content-Disposition", `attachment; filename="${filename.replace(/["\\]/g, "")}"`);
    return c.body(obj.stream as unknown as BodyInit);
  } catch (err) {
    return serverError(c, err);
  }
});

// ── Admin: Partner Management ────────────────────────────

app.get("/api/partners", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const status = c.req.query("status");
  const baseSql = `
    SELECT p.id, p.first_name, p.last_name, p.company_name, p.email, p.partner_type, p.status,
           p.referral_code, p.commission_percentage, p.created_at,
           p.w9_filename, (p.w9_file_key IS NOT NULL) as w9_uploaded, p.tax_info_status, p.hear_about_us,
           u.username,
           (SELECT COUNT(*) FROM referrals r WHERE r.partner_id = p.id) as total_referrals
    FROM partners p
    LEFT JOIN users u ON u.id = p.user_id
  `;
  const rows = status
    ? db.query(`${baseSql} WHERE p.status = $status ORDER BY p.created_at DESC, p.id DESC`).all({ $status: status })
    : db.query(`${baseSql} ORDER BY p.created_at DESC, p.id DESC`).all();
  return c.json({ partners: rows });
});

app.get("/api/partners/:id", requireAuth, requireAdmin, (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid partner id" }, 400);
  const db = getDb();
  const partner = db.query(`
    SELECT p.*, (SELECT username FROM users WHERE id = p.user_id) as username
    FROM partners p WHERE p.id = $id
  `).get({ $id: id }) as Record<string, unknown> | undefined;
  if (!partner) return c.json({ error: "Partner not found" }, 404);

  const totalReferrals = (db.query("SELECT COUNT(*) as c FROM referrals WHERE partner_id = $id").get({ $id: id }) as { c: number }).c;
  const commissionTotals = db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN status NOT IN ('reversed','disputed') THEN commission_amount ELSE 0 END), 0) as lifetime_earnings,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount ELSE 0 END), 0) as paid_earnings,
      COALESCE(SUM(CASE WHEN status IN ('pending','approved','scheduled') THEN commission_amount ELSE 0 END), 0) as outstanding_earnings,
      COUNT(*) as commission_count
    FROM commissions WHERE partner_id = $id
  `).get({ $id: id });

  return c.json({ partner: { ...partner, total_referrals: totalReferrals, commission_totals: commissionTotals } });
});

app.put("/api/partners/:id/status", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const id = Number(c.req.param("id"));
    const { status, reason } = body;
    const VALID_STATUSES = ["pending", "approved", "suspended", "rejected", "terminated"];
    if (!Number.isInteger(id)) return c.json({ error: "Invalid partner id" }, 400);
    if (!VALID_STATUSES.includes(status)) return c.json({ error: "Invalid status" }, 400);

    const db = getDb();
    const partner = db.query("SELECT * FROM partners WHERE id = $id").get({ $id: id }) as { id: number; last_name: string; referral_code: string | null } | undefined;
    if (!partner) return c.json({ error: "Partner not found" }, 404);

    // Referral code is NOT minted on approval — it is only generated when the
    // partner uploads a W-9 (POST /api/partners/w9), so an approved partner
    // with no W-9 on file cannot refer. W-9 upload is the sole gate.
    db.query("UPDATE partners SET status = $status, updated_at = datetime('now') WHERE id = $id").run({ $status: status, $id: id });
    const changes: Record<string, unknown> = { status, previous_status: partner.status };
    if (status === "approved" && !partner.referral_code) {
      changes.referral_code = null;
      changes.note = "referral_code stays NULL until the partner uploads a W-9";
    }

    logPartnerAudit(db, id, "status_changed", changes, (reason && String(reason).trim()) || null, c.get("user").email);
    logAudit(db, "partner", id, "partner_status_changed", changes);

    return c.json({ success: true, partner: db.query("SELECT * FROM partners WHERE id = $id").get({ $id: id }) });
  } catch (err) {
    return serverError(c, err);
  }
});

app.put("/api/partners/:id/commission", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const id = Number(c.req.param("id"));
    const pct = Number(body.commission_percentage);
    if (!Number.isInteger(id)) return c.json({ error: "Invalid partner id" }, 400);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return c.json({ error: "commission_percentage must be a number between 0 and 100" }, 400);

    const db = getDb();
    const partner = db.query("SELECT * FROM partners WHERE id = $id").get({ $id: id }) as { id: number; commission_percentage: number } | undefined;
    if (!partner) return c.json({ error: "Partner not found" }, 404);

    db.query("UPDATE partners SET commission_percentage = $pct, updated_at = datetime('now') WHERE id = $id").run({ $pct: pct, $id: id });
    logPartnerAudit(db, id, "commission_percentage_changed", { from: partner.commission_percentage, to: pct }, (body.reason && String(body.reason).trim()) || null, c.get("user").email);

    return c.json({ success: true, partner_id: id, commission_percentage: pct });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── Partner Portal ───────────────────────────────────────

// Partner's own profile. Unlike requirePartner-protected endpoints (which 403
// until the partner is approved), this returns the record for ANY status so the
// frontend can distinguish pending / rejected / suspended from approved. It is
// still auth-gated and only ever returns the authenticated user's own row.
// Extended (delegation B) with the Stripe Connect state and payout history so
// the portal's "Stripe Connect" card can render from one call.
app.get("/api/partner/me", requireAuth, (c) => {
  const db = getDb();
  const user = c.get("user") as { user_id: number };
  const raw = db.query("SELECT * FROM partners WHERE user_id = $uid").get({ $uid: user.user_id }) as Record<string, unknown> | undefined;
  if (!raw) return c.json({ error: "Partner account required" }, 403);
  // Strip the storage key — the W-9 file is admin-only. The partner gets a
  // boolean + filename so they know what's on file.
  const { w9_file_key: _w9Key, ...partner } = raw;
  const userRow = db.query("SELECT username FROM users WHERE id = $uid").get({ $uid: user.user_id }) as { username: string | null } | undefined;
  const totalReferrals = (db.query("SELECT COUNT(*) as c FROM referrals WHERE partner_id = $id").get({ $id: partner.id }) as { c: number }).c;
  const stripeRow = getPartnerStripeRow(db, Number(partner.id));
  const stripe = {
    stripe_account_id: stripeRow.stripe_account_id ?? null,
    details_submitted: Number(stripeRow.stripe_details_submitted) === 1,
    currently_due: stripeRow.stripe_currently_due ?? "[]",
    payouts_enabled: Number(stripeRow.stripe_payouts_enabled) === 1,
    charges_enabled: Number(stripeRow.stripe_charges_enabled) === 1,
    disconnected_at: stripeRow.stripe_disconnected_at ?? null,
    connect_status: partnerConnectStatus(stripeRow),
  };
  const payouts = db.query(`
    SELECT id, amount, status, payment_date, payment_method, transaction_ref, notes, created_at
    FROM payouts WHERE partner_id = $pid
    ORDER BY created_at DESC, id DESC
  `).all({ $pid: partner.id });
  return c.json({
    partner: {
      ...partner,
      username: userRow?.username ?? null,
      // W-9 file is admin-only — partners see a boolean + the original filename
      // (so they know what's on file) but NEVER the storage key/location.
      w9_uploaded: !!raw.w9_file_key,
      w9_filename: partner.w9_filename ?? null,
      w9_uploaded_at: partner.w9_uploaded_at ?? null,
      total_referrals: totalReferrals,
      stripe,
      payouts,
    },
  });
});

// ── Stripe Connect onboarding (delegation B) ─────────────

// POST /api/partners/:id/connect — admin OR the partner themself may start
// Connect Express onboarding. Creates the Express account if the partner has
// none, then returns an account_link url for the SPA to redirect to. If Stripe
// is not configured → 503 {"error":"Stripe not configured"}.
app.post("/api/partners/:id/connect", requireAuth, async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid partner id" }, 400);
    const db = getDb();
    const partner = db.query("SELECT * FROM partners WHERE id = $id").get({ $id: id }) as
      | { id: number; user_id: number; first_name: string; last_name: string; company_name: string | null; email: string; stripe_account_id: string | null }
      | undefined;
    if (!partner) return c.json({ error: "Partner not found" }, 404);

    const user = c.get("user") as { user_id: number; email: string };
    const roleRow = db.query("SELECT role FROM users WHERE id = ?").get(user.user_id) as { role: string } | null;
    const isAdmin = roleRow?.role === "admin";
    const isSelf = partner.user_id === user.user_id;
    if (!isAdmin && !isSelf) return c.json({ error: "You can only connect your own Stripe account" }, 403);

    const stripe = getStripe();
    if (!stripe) return c.json({ error: "Stripe not configured" }, 503);

    let accountId = partner.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: partner.email,
        metadata: { partner_id: String(partner.id), partner_name: partner.company_name || `${partner.first_name} ${partner.last_name}`.trim() },
      });
      accountId = account.id;
      db.query("UPDATE partners SET stripe_account_id = $aid, stripe_disconnected_at = NULL, updated_at = datetime('now') WHERE id = $id").run({ $aid: accountId, $id: partner.id });
      logPartnerAudit(db, partner.id, "stripe_connect_account_created", { stripe_account_id: accountId }, null, user.email);
      logAudit(db, "partner", partner.id, "stripe_connect_account_created", { stripe_account_id: accountId });
      console.log(`[partners] Connect Express account ${accountId} created for partner ${partner.id}`);
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: PARTNER_PORTAL_CONNECT_URL,
      return_url: PARTNER_PORTAL_CONNECT_URL,
    });
    logPartnerAudit(db, partner.id, "stripe_connect_onboarding_started", { stripe_account_id: accountId }, null, user.email);
    return c.json({ url: link.url });
  } catch (err) {
    console.error("[partners] Stripe Connect onboarding error:", err);
    return serverError(c, err);
  }
});

// Partner's Connect status + payout history (same data /api/partner/me
// returns, kept as a separate endpoint for the portal card's own refresh).
app.get("/api/partner/connect-status", requireAuth, requirePartner, (c) => {
  const db = getDb();
  const partnerId = c.get("partner_id") as number;
  const stripeRow = getPartnerStripeRow(db, partnerId);
  const payouts = db.query(`
    SELECT id, amount, status, payment_date, payment_method, transaction_ref, notes, created_at
    FROM payouts WHERE partner_id = $pid
    ORDER BY created_at DESC, id DESC LIMIT 20
  `).all({ $pid: partnerId });
  return c.json({
    stripe: {
      stripe_account_id: stripeRow.stripe_account_id ?? null,
      details_submitted: Number(stripeRow.stripe_details_submitted) === 1,
      currently_due: stripeRow.stripe_currently_due ?? "[]",
      payouts_enabled: Number(stripeRow.stripe_payouts_enabled) === 1,
      charges_enabled: Number(stripeRow.stripe_charges_enabled) === 1,
      disconnected_at: stripeRow.stripe_disconnected_at ?? null,
      connect_status: partnerConnectStatus(stripeRow),
    },
    payouts,
  });
});

app.get("/api/partner/dashboard", requireAuth, requirePartner, (c) => {
  const db = getDb();
  const partnerId = c.get("partner_id") as number;
  const partner = db.query("SELECT id, referral_code, w9_file_key, w9_filename, email FROM partners WHERE id = $id").get({ $id: partnerId }) as { id: number; referral_code: string | null; w9_file_key: string | null; w9_filename: string | null; email: string };

  const countBy = (where: string, params: Record<string, unknown> = {}) =>
    (db.query(`SELECT COUNT(*) as c FROM referrals WHERE partner_id = $pid AND ${where}`).get({ $pid: partnerId, ...params }) as { c: number }).c;

  const totalReferrals = countBy("1=1");
  const activeCustomers = countBy("customer_status = 'active'");
  const pendingReferrals = countBy("customer_status IN ('lead','trial')");
  const cancelledCustomers = countBy("customer_status IN ('cancelled','refunded')");

  const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
  const sumBy = (where: string, params: Record<string, unknown> = {}) =>
    (db.query(`SELECT COALESCE(SUM(commission_amount), 0) as s FROM commissions WHERE partner_id = $pid AND ${where}`).get({ $pid: partnerId, ...params }) as { s: number }).s;

  const currentMonthEarnings = sumBy("status NOT IN ('reversed','disputed') AND strftime('%Y-%m', earned_date) = $month", { $month: monthKey });
  const pendingCommission = sumBy("status = 'pending'");
  const approvedCommission = sumBy("status IN ('approved','scheduled')");
  const paidCommission = sumBy("status = 'paid'");
  const lifetimeEarnings = sumBy("status NOT IN ('reversed','disputed')");
  const nextExpectedPayout = sumBy("status IN ('approved','scheduled')");

  const w9Uploaded = !!partner.w9_file_key;
  const referringEnabled = !!partner.referral_code;
  // Demo-partner flag so the portal UI can label sample figures as such
  // (created exclusively by the demo seed scripts — never a real partner).
  const demo = /@cleartopaydemo\.com$/i.test(partner.email) || partner.referral_code === "DEMOPART";
  return c.json({
    demo,
    referral_code: partner.referral_code,
    referral_link: partner.referral_code ? `${PARTNER_REFERRAL_LINK_BASE}?ref=${partner.referral_code}` : null,
    // Explicit W-9 gate flags for the portal UI: referring is disabled until a
    // W-9 is on file (which is also when the referral code is generated).
    referring_enabled: referringEnabled,
    w9_required: !w9Uploaded,
    w9_uploaded: w9Uploaded,
    w9_filename: partner.w9_filename,
    total_referrals: totalReferrals,
    active_customers: activeCustomers,
    pending_referrals: pendingReferrals,
    cancelled_customers: cancelledCustomers,
    current_month_earnings: currentMonthEarnings,
    pending_commission: pendingCommission,
    approved_commission: approvedCommission,
    paid_commission: paidCommission,
    lifetime_earnings: lifetimeEarnings,
    next_expected_payout: nextExpectedPayout,
  });
});

app.post("/api/partner/referrals", requireAuth, requirePartner, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { company_name, contact_name, email, phone, notes } = body;
    if (!company_name && !contact_name && !email) {
      return c.json({ error: "Provide at least a company name, contact name, or email" }, 400);
    }

    const db = getDb();
    const partnerId = c.get("partner_id") as number;
    const partner = db.query("SELECT id, referral_code, w9_file_key FROM partners WHERE id = $id").get({ $id: partnerId }) as { id: number; referral_code: string | null; w9_file_key: string | null };
    // W-9 gate: no W-9 on file ⇒ no referral code ⇒ referring is blocked.
    // (The code only ever exists once a W-9 has been uploaded, but both checks
    // guard against any legacy row that has a code but no W-9.)
    if (!partner.w9_file_key || !partner.referral_code) {
      return c.json({ error: "Upload your W-9 before referring" }, 403);
    }
    const code = partner.referral_code;

    const result = db.query(`
      INSERT INTO referrals (partner_id, partner_code, referred_company, contact_name, contact_email, contact_phone, notes, customer_status)
      VALUES ($pid, $code, $company, $contact_name, $email, $phone, $notes, 'lead')
    `).run({
      $pid: partnerId,
      $code: code,
      $company: (company_name && company_name.trim()) || null,
      $contact_name: (contact_name && contact_name.trim()) || null,
      $email: (email && email.trim()) || null,
      $phone: (phone && phone.trim()) || null,
      $notes: (notes && notes.trim()) || null,
    });
    const referralId = Number(result.lastInsertRowid);

    // Notification hook — logged for now; email delivery wired in a later phase.
    console.log(`[partners] New referral #${referralId} from partner ${partnerId} (${partner.referral_code || "no code"}) — ${company_name || contact_name || email}`);
    logPartnerAudit(db, partnerId, "referral_created", { referral_id: referralId, company_name: company_name || null, contact_name: contact_name || null, contact_email: email || null }, null, c.get("user").email);

    return c.json({ referral: db.query("SELECT * FROM referrals WHERE id = $id").get({ $id: referralId }) }, 201);
  } catch (err) {
    return serverError(c, err);
  }
});

app.get("/api/partner/referrals", requireAuth, requirePartner, (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM referrals WHERE partner_id = $pid ORDER BY created_at DESC, id DESC").all({ $pid: c.get("partner_id") });
  return c.json({ referrals: rows });
});

app.get("/api/partner/commissions", requireAuth, requirePartner, (c) => {
  const db = getDb();
  const status = c.req.query("status");
  const partnerId = c.get("partner_id") as number;
  const rows = status
    ? db.query(`
        SELECT c.*, r.referred_company as customer_name
        FROM commissions c
        LEFT JOIN referrals r ON r.id = c.referral_id
        WHERE c.partner_id = $pid AND c.status = $status
        ORDER BY c.earned_date DESC, c.id DESC
      `).all({ $pid: partnerId, $status: status })
    : db.query(`
        SELECT c.*, r.referred_company as customer_name
        FROM commissions c
        LEFT JOIN referrals r ON r.id = c.referral_id
        WHERE c.partner_id = $pid
        ORDER BY c.earned_date DESC, c.id DESC
      `).all({ $pid: partnerId });
  return c.json({ commissions: rows });
});

app.get("/api/partner/payouts", requireAuth, requirePartner, (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM payouts WHERE partner_id = $pid ORDER BY created_at DESC, id DESC").all({ $pid: c.get("partner_id") });
  return c.json({ payouts: rows });
});

// ── Public: Referral Tracking (signup page) ──────────────

app.get("/api/referrals/track", (c) => {
  const code = (c.req.query("code") || "").trim().toUpperCase();
  if (!code) return c.json({ error: "code is required" }, 400);
  const db = getDb();
  const partner = db.query("SELECT id, first_name, last_name, company_name, status FROM partners WHERE referral_code = $code COLLATE NOCASE").get({ $code: code }) as { id: number; first_name: string; last_name: string; company_name: string | null; status: string } | undefined;
  if (!partner || partner.status !== "approved") return c.json({ error: "Invalid referral code" }, 404);
  return c.json({ partner: { id: partner.id, name: `${partner.first_name} ${partner.last_name}`, company_name: partner.company_name, referral_code: code } });
});

// ── Admin: Referral Management ───────────────────────────

app.get("/api/referrals", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const partnerId = c.req.query("partner_id");
  const customerStatus = c.req.query("customer_status");
  const start = c.req.query("start");
  const end = c.req.query("end");

  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (partnerId) { where.push("partner_id = $partner_id"); params.$partner_id = Number(partnerId); }
  if (customerStatus) { where.push("customer_status = $customer_status"); params.$customer_status = customerStatus; }
  if (start) { where.push("referral_date >= $start"); params.$start = start; }
  if (end) { where.push("referral_date <= $end"); params.$end = end; }

  const sql = `
    SELECT r.*, (p.first_name || ' ' || p.last_name) as partner_name
    FROM referrals r
    LEFT JOIN partners p ON p.id = r.partner_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY r.created_at DESC, r.id DESC
  `;
  const rows = db.query(sql).all(params);
  return c.json({ referrals: rows });
});

app.put("/api/referrals/:id", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid referral id" }, 400);
    const reason = body.reason && String(body.reason).trim();
    if (!reason) return c.json({ error: "reason is required for referral corrections" }, 400);

    const db = getDb();
    const referral = db.query("SELECT * FROM referrals WHERE id = $id").get({ $id: id }) as Record<string, unknown> | undefined;
    if (!referral) return c.json({ error: "Referral not found" }, 404);

    const changes: Record<string, unknown> = {};
    if (body.partner_id !== undefined && body.partner_id !== null) {
      const newPartnerId = Number(body.partner_id);
      const newPartner = db.query("SELECT id, referral_code FROM partners WHERE id = $id").get({ $id: newPartnerId }) as { id: number; referral_code: string | null } | undefined;
      if (!newPartner) return c.json({ error: "partner_id does not reference an existing partner" }, 400);
      changes.partner_id = newPartnerId;
      changes.partner_code = newPartner.referral_code || "";
    }
    if (body.customer_status !== undefined && body.customer_status !== null) {
      const VALID = ["lead", "trial", "active", "past_due", "cancelled", "refunded"];
      if (!VALID.includes(body.customer_status)) return c.json({ error: "Invalid customer_status" }, 400);
      changes.customer_status = body.customer_status;
    }
    if (body.notes !== undefined) {
      changes.notes = body.notes === null ? null : String(body.notes);
    }
    if (Object.keys(changes).length === 0) return c.json({ error: "Nothing to update — provide partner_id, customer_status, or notes" }, 400);

    const setClause = Object.keys(changes).map((k) => `${k} = $${k}`).join(", ");
    const updParams: Record<string, unknown> = { $id: id };
    for (const [k, v] of Object.entries(changes)) updParams[`$${k}`] = v;
    db.query(`UPDATE referrals SET ${setClause}, updated_at = datetime('now') WHERE id = $id`).run(updParams);

    const updated = db.query("SELECT * FROM referrals WHERE id = $id").get({ $id: id });
    logAudit(db, "referral", id, "referral_updated", { ...changes, reason });
    logPartnerAudit(db, Number(referral.partner_id), "referral_corrected", { referral_id: id, ...changes }, reason, c.get("user").email);

    return c.json({ success: true, referral: updated });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── Admin: Commission Management ─────────────────────────

app.post("/api/commissions", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { partner_id, referral_id, tenant_id, billing_period, eligible_revenue, commission_percentage } = body;

    if (!partner_id || !Number.isFinite(Number(eligible_revenue))) {
      return c.json({ error: "partner_id and eligible_revenue are required" }, 400);
    }
    const partnerId = Number(partner_id);
    const revenue = Number(eligible_revenue);
    if (revenue < 0) return c.json({ error: "eligible_revenue cannot be negative" }, 400);

    const db = getDb();
    const partner = db.query("SELECT id, commission_percentage FROM partners WHERE id = $id").get({ $id: partnerId }) as { id: number; commission_percentage: number } | undefined;
    if (!partner) return c.json({ error: "Partner not found" }, 404);

    const pct = commission_percentage !== undefined && commission_percentage !== null ? Number(commission_percentage) : (partner.commission_percentage ?? 25.0);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return c.json({ error: "commission_percentage must be between 0 and 100" }, 400);
    const amount = Math.round(revenue * (pct / 100) * 100) / 100;

    if (referral_id !== undefined && referral_id !== null) {
      const referral = db.query("SELECT id FROM referrals WHERE id = $id").get({ $id: Number(referral_id) });
      if (!referral) return c.json({ error: "referral_id does not reference an existing referral" }, 400);
    }

    const result = db.query(`
      INSERT INTO commissions (partner_id, referral_id, tenant_id, billing_period, eligible_revenue, commission_percentage, commission_amount, status)
      VALUES ($pid, $ref_id, $tenant_id, $period, $revenue, $pct, $amount, 'pending')
    `).run({
      $pid: partnerId,
      $ref_id: referral_id !== undefined && referral_id !== null ? Number(referral_id) : null,
      $tenant_id: tenant_id !== undefined && tenant_id !== null ? Number(tenant_id) : null,
      $period: billing_period || null,
      $revenue: revenue,
      $pct: pct,
      $amount: amount,
    });
    const commissionId = Number(result.lastInsertRowid);
    logPartnerAudit(db, partnerId, "commission_created", { commission_id: commissionId, eligible_revenue: revenue, commission_percentage: pct, commission_amount: amount, billing_period: billing_period || null }, null, c.get("user").email);

    return c.json({ commission: db.query("SELECT * FROM commissions WHERE id = $id").get({ $id: commissionId }) }, 201);
  } catch (err) {
    return serverError(c, err);
  }
});

app.get("/api/commissions", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const partnerId = c.req.query("partner_id");
  const status = c.req.query("status");
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (partnerId) { where.push("c.partner_id = $partner_id"); params.$partner_id = Number(partnerId); }
  if (status) { where.push("c.status = $status"); params.$status = status; }
  const sql = `
    SELECT c.*,
           (p.first_name || ' ' || p.last_name) as partner_name,
           r.referred_company as customer_name
    FROM commissions c
    LEFT JOIN partners p ON p.id = c.partner_id
    LEFT JOIN referrals r ON r.id = c.referral_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY c.earned_date DESC, c.id DESC
  `;
  return c.json({ commissions: db.query(sql).all(params) });
});

app.put("/api/commissions/:id", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid commission id" }, 400);
    const { status, reason } = body;
    const VALID = ["pending", "approved", "scheduled", "paid", "reversed", "disputed"];
    if (!VALID.includes(status)) return c.json({ error: "Invalid status" }, 400);

    const db = getDb();
    const commission = db.query("SELECT * FROM commissions WHERE id = $id").get({ $id: id }) as { id: number; partner_id: number; status: string } | undefined;
    if (!commission) return c.json({ error: "Commission not found" }, 404);

    db.query("UPDATE commissions SET status = $status WHERE id = $id").run({ $status: status, $id: id });
    const changes = { from: commission.status, to: status };
    logPartnerAudit(db, commission.partner_id, "commission_status_changed", { commission_id: id, ...changes }, (reason && String(reason).trim()) || null, c.get("user").email);
    logAudit(db, "commission", id, "commission_status_changed", { ...changes, reason: reason || null });

    return c.json({ success: true, commission: db.query("SELECT * FROM commissions WHERE id = $id").get({ $id: id }) });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── Admin: Payout Management ─────────────────────────────

app.post("/api/payouts", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const partnerId = Number(body.partner_id);
    const amount = Number(body.amount);
    if (!Number.isInteger(partnerId) || !Number.isFinite(amount) || amount < 0) {
      return c.json({ error: "partner_id and a non-negative amount are required" }, 400);
    }

    const db = getDb();
    const partner = db.query("SELECT id FROM partners WHERE id = $id").get({ $id: partnerId });
    if (!partner) return c.json({ error: "Partner not found" }, 404);

    const result = db.query(`
      INSERT INTO payouts (partner_id, amount, status, payment_method, transaction_ref, notes)
      VALUES ($pid, $amount, 'pending', $method, $txn, $notes)
    `).run({
      $pid: partnerId,
      $amount: amount,
      $method: (body.payment_method && String(body.payment_method).trim()) || null,
      $txn: (body.transaction_ref && String(body.transaction_ref).trim()) || null,
      $notes: (body.notes && String(body.notes).trim()) || null,
    });
    const payoutId = Number(result.lastInsertRowid);

    // Mark all approved commissions for this partner as paid and link them to this payout.
    const updated = db.query("UPDATE commissions SET status = 'paid', payout_id = $payout_id WHERE partner_id = $pid AND status = 'approved'").run({ $payout_id: payoutId, $pid: partnerId });
    logPartnerAudit(db, partnerId, "payout_created", { payout_id: payoutId, amount, commissions_linked: Number(updated.changes) }, (body.notes && String(body.notes).trim()) || null, c.get("user").email);

    return c.json({ payout: db.query("SELECT * FROM payouts WHERE id = $id").get({ $id: payoutId }) }, 201);
  } catch (err) {
    return serverError(c, err);
  }
});

app.get("/api/payouts", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const partnerId = c.req.query("partner_id");
  const baseSql = `
    SELECT po.*, (p.first_name || ' ' || p.last_name) as partner_name
    FROM payouts po
    LEFT JOIN partners p ON p.id = po.partner_id
  `;
  const rows = partnerId
    ? db.query(`${baseSql} WHERE po.partner_id = $pid ORDER BY po.created_at DESC, po.id DESC`).all({ $pid: Number(partnerId) })
    : db.query(`${baseSql} ORDER BY po.created_at DESC, po.id DESC`).all();
  return c.json({ payouts: rows });
});

// Admin payouts view (delegation B): every payout joined with partner
// name/email, amount, status, payment_date, transaction_ref, notes.
app.get("/api/admin/payouts", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const rows = db.query(`
    SELECT po.id, po.partner_id, po.amount, po.status, po.payment_date, po.payment_method,
           po.transaction_ref, po.notes, po.created_at,
           (p.first_name || ' ' || p.last_name) as partner_name,
           p.email as partner_email
    FROM payouts po
    LEFT JOIN partners p ON p.id = po.partner_id
    ORDER BY po.created_at DESC, po.id DESC
  `).all();
  return c.json({ payouts: rows });
});
// ── Admin: Manual run triggers for the automated engine ──
// Same code paths the scheduler calls (daily commissions, end-of-month
// payout run), exposed so ops can trigger/verify a run on demand. Both are
// idempotent: commissions skip when (partner, tenant, period) already exists,
// and the payout run keeps its once-per-month + day-of-month gates.
app.post("/api/admin/commissions/run", requireAuth, requireAdmin, (c) => {
  try {
    const result = calculateCommissions();
    return c.json({ success: true, ...result, note: "Daily commission auto-creation (same as scheduler tick)" });
  } catch (err) {
    return serverError(c, err);
  }
});
app.post("/api/admin/payouts/run", requireAuth, requireAdmin, (c) => {
  try {
    const result = runPartnerPayouts();
    return c.json({
      success: true,
      ...result,
      note: "End-of-month payout run (same as scheduler tick). Money is NOT transferred in this delegation — payout stays pending until Stripe Connect is wired.",
    });
  } catch (err) {
    return serverError(c, err);
  }
});

// ── Admin: Dashboard + Audit Log (Phase 3) ────────────────

// System-wide aggregate stats for the admin dashboard.
app.get("/api/admin/dashboard", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const count = (sql: string, params: Record<string, unknown> = {}) =>
    (db.query(`SELECT COUNT(*) as c ${sql}`).get(params) as { c: number }).c;

  const totalPartners = count("FROM partners");
  const pendingApplications = count("FROM partners WHERE status = 'pending'");
  const activePartners = count("FROM partners WHERE status = 'approved'");
  const totalReferrals = count("FROM referrals");
  const activeReferredCustomers = count("FROM referrals WHERE customer_status = 'active'");
  const referralConversionRate = totalReferrals > 0 ? Math.round((activeReferredCustomers / totalReferrals) * 1000) / 10 : 0;
  const referredMonthlyRevenue = (db.query("SELECT COALESCE(SUM(subscription_amount), 0) as s FROM referrals WHERE customer_status = 'active'").get() as { s: number }).s;

  const pendingAgg = db.query("SELECT COUNT(*) as c, COALESCE(SUM(commission_amount), 0) as s FROM commissions WHERE status = 'pending'").get() as { c: number; s: number };
  const approvedAgg = db.query("SELECT COUNT(*) as c, COALESCE(SUM(commission_amount), 0) as s FROM commissions WHERE status IN ('approved','scheduled')").get() as { c: number; s: number };
  const upcomingPayouts = (db.query("SELECT COALESCE(SUM(commission_amount), 0) as s FROM commissions WHERE status IN ('approved','scheduled')").get() as { s: number }).s;
  const lifetimeCommissionsPaid = (db.query("SELECT COALESCE(SUM(commission_amount), 0) as s FROM commissions WHERE status = 'paid'").get() as { s: number }).s;

  return c.json({
    total_partners: totalPartners,
    pending_applications: pendingApplications,
    active_partners: activePartners,
    total_referrals: totalReferrals,
    active_referred_customers: activeReferredCustomers,
    referral_conversion_rate: referralConversionRate,
    referred_monthly_revenue: referredMonthlyRevenue,
    pending_commissions: { count: pendingAgg.c, amount: pendingAgg.s },
    approved_commissions: { count: approvedAgg.c, amount: approvedAgg.s },
    upcoming_payouts: upcomingPayouts,
    lifetime_commissions_paid: lifetimeCommissionsPaid,
  });
});

// Admin audit log — partner_audit_log rows joined with the partner's name.
app.get("/api/admin/audit-log", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const partnerId = c.req.query("partner_id");
  const action = c.req.query("action");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (partnerId && partnerId !== "all") { where.push("pal.partner_id = $partner_id"); params.$partner_id = Number(partnerId); }
  if (action && action !== "all") { where.push("pal.action = $action"); params.$action = action; }
  if (from) { where.push("pal.created_at >= $from"); params.$from = from; }
  if (to) { where.push("pal.created_at <= $to"); params.$to = to; }

  const sql = `
    SELECT pal.id, pal.partner_id,
           COALESCE(p.company_name, (p.first_name || ' ' || p.last_name)) as partner_name,
           pal.action, pal.changes, pal.reason, pal.performed_by, pal.created_at
    FROM partner_audit_log pal
    LEFT JOIN partners p ON p.id = pal.partner_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY pal.created_at DESC, pal.id DESC
    LIMIT 200
  `;
  return c.json({ entries: db.query(sql).all(params) });
});

// All tenant accounts (construction companies that signed up) — admin only.
// wizard_status lives on setup_wizard (tenants has no such column), so we
// LEFT JOIN and alias it to keep the response shape: { id, name,
// subscription_status, subscription_plan, subscription_period_start,
// payment_week_start_day, wizard_status, created_at, user_count,
// vendor_count, owner_name, owner_email, unanswered_count }.
// owner_* come from the tenant's owner user; unanswered_count is the number
// of support questions still open (status = 'open') for that tenant.
app.get("/api/admin/accounts", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const rows = db.query(`
    SELECT t.id, t.name, t.subscription_status, t.subscription_plan,
           t.subscription_period_start, t.payment_week_start_day,
           COALESCE(sw.status, 'NOT_STARTED') as wizard_status, t.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) as user_count,
      (SELECT COUNT(*) FROM vendors v WHERE v.tenant_id = t.id) as vendor_count,
      (SELECT u.full_name FROM users u WHERE u.id = t.owner_user_id) as owner_name,
      (SELECT u.email FROM users u WHERE u.id = t.owner_user_id) as owner_email,
      (SELECT COUNT(*) FROM support_messages sm WHERE sm.tenant_id = t.id AND sm.status = 'open') as unanswered_count
    FROM tenants t
    LEFT JOIN setup_wizard sw ON sw.tenant_id = t.id
    ORDER BY t.created_at DESC
  `).all();
  return c.json({ accounts: rows });
});

// 12-month cash flow forecast from the current tenant book — admin only.
// ACTIVE tenants contribute MRR: plan 'monthly' → $149/mo, 'annual' →
// $100/mo (monthly equivalent of $1,200/yr), NULL/unknown plan →
// $149/mo default. TRIAL and CANCELLED tenants are counted in the summary
// but contribute $0. The projection is a flat MRR over 12 months.
// Partner payouts are projected only for ACTIVE tenants that are linked to
// an APPROVED partner referral: monthly payout = tenant MRR × (partner
// commission_percentage / 100), defaulting to 25% when the percentage is
// NULL. A referred tenant whose partner is not approved creates no
// projected obligation. partner_payouts_outstanding / partner_payouts_paid
// are straight SUM()s of real rows (no projection).
app.get("/api/admin/cashflow", requireAuth, requireAdmin, (c) => {
  const db = getDb();
  const MONTHLY_RATE = 149;
  const ANNUAL_MONTHLY_EQUIVALENT = 100;
  const DEFAULT_COMMISSION_PERCENT = 25.0;
  const rows = db.query("SELECT id, subscription_status, subscription_plan FROM tenants").all() as {
    id: number;
    subscription_status: string | null;
    subscription_plan: string | null;
  }[];
  // Approved-partner referral per tenant (tenant_id → commission rate).
  // A tenant with no row here has no real payout obligation.
  const refRows = db.query(`
    SELECT r.tenant_id, COALESCE(p.commission_percentage, $default) AS commission_percentage
    FROM referrals r
    JOIN partners p ON p.id = r.partner_id
    WHERE r.tenant_id IS NOT NULL AND p.status = 'approved'
  `).all({ $default: DEFAULT_COMMISSION_PERCENT }) as {
    tenant_id: number;
    commission_percentage: number;
  }[];
  const commissionRateByTenant = new Map<number, number>();
  for (const rr of refRows) {
    commissionRateByTenant.set(Number(rr.tenant_id), Number(rr.commission_percentage));
  }
  let active = 0;
  let trial = 0;
  let cancelled = 0;
  let mrr = 0;
  let monthlyPayout = 0;
  for (const r of rows) {
    const status = (r.subscription_status || "").toUpperCase();
    if (status === "ACTIVE") {
      active++;
      const plan = (r.subscription_plan || "").toLowerCase();
      const rev = plan === "annual" ? ANNUAL_MONTHLY_EQUIVALENT : MONTHLY_RATE;
      mrr += rev;
      const rate = commissionRateByTenant.get(Number(r.id));
      if (rate !== undefined) {
        monthlyPayout += (rev * rate) / 100;
      }
    } else if (status === "TRIAL" || status === "TRIALING") {
      trial++;
    } else if (status === "CANCELLED" || status === "CANCELED") {
      cancelled++;
    }
  }
  mrr = Math.round(mrr * 100) / 100;
  monthlyPayout = Math.round(monthlyPayout * 100) / 100;
  const projected12mo = Math.round(mrr * 12 * 100) / 100;
  const projectedPayouts12mo = Math.round(monthlyPayout * 12 * 100) / 100;
  const netProjected12mo = Math.round((projected12mo - projectedPayouts12mo) * 100) / 100;
  // Real committed / paid partner money — no projection, no assumptions.
  const outstandingRow = db.query(
    "SELECT COALESCE(SUM(commission_amount), 0) AS total FROM commissions WHERE status IN ('pending','approved','scheduled')"
  ).get() as { total: number };
  const paidRow = db.query(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM payouts WHERE status = 'paid'"
  ).get() as { total: number };
  const payoutsOutstanding = Math.round(Number(outstandingRow.total) * 100) / 100;
  const payoutsPaid = Math.round(Number(paidRow.total) * 100) / 100;
  // 12 months starting from the current month (server local time).
  const now = new Date();
  const months: { month: string; revenue: number; payouts: number; net: number; cumulative: number }[] = [];
  let cumulative = 0;
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const net = Math.round((mrr - monthlyPayout) * 100) / 100;
    cumulative = Math.round((cumulative + net) * 100) / 100;
    months.push({
      month: d.toLocaleString("en-US", { month: "short", year: "numeric" }),
      revenue: mrr,
      payouts: monthlyPayout,
      net,
      cumulative,
    });
  }
  return c.json({
    summary: {
      active_accounts: active,
      trial_accounts: trial,
      cancelled_accounts: cancelled,
      mrr,
      projected_12mo: projected12mo,
      partner_payouts_outstanding: payoutsOutstanding,
      partner_payouts_paid: payoutsPaid,
      projected_payouts_12mo: projectedPayouts12mo,
      net_projected_12mo: netProjected12mo,
    },
    months,
    assumptions: {
      monthly_rate: MONTHLY_RATE,
      annual_monthly_equivalent: ANNUAL_MONTHLY_EQUIVALENT,
      payout_note:
        "Partner payouts projected only for active referred tenants at the partner's commission rate; flat over 12 months.",
    },
  });
});

export default app;
