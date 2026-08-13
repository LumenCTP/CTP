import { Hono } from "hono";
import { getDb } from "./db";
import {
  createAuthToken,
  verifyAuthToken,
  findTenantForUser,
  findWizard,
  createTenantForUser,
  logAudit,
} from "./middleware";
import { sendEmail, buildPasswordResetEmail } from "./email";
import { buildInboxAddress } from "./lib/inbox";
import { logPartnerAudit } from "./routes/partners";

const app = new Hono();

// ── Auth Routes ─────────────────────────────────────────

app.post("/api/auth/register", async (c) => {
  try {
    const body = await c.req.json();
    const { full_name, company_name, email, password, referral_code, plan, subscription_plan } = body;

    if (!company_name || typeof company_name !== "string" || company_name.trim().length === 0) {
      return c.json({ error: "Company name is required" }, 400);
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return c.json({ error: "Valid email is required" }, 400);
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    // Owner requirement: the account profile name IS the company name. When the
    // company name is provided it becomes the user's full_name/profile name
    // (shown in the TopBar and used wherever full_name is used). A separately
    // supplied full_name is accepted but ignored for non-company callers.
    const profileName = company_name.trim();

    // Chosen subscription plan (monthly | annual) — recorded on the tenant so
    // the admin Clients table and commission engine see the real plan.
    const rawPlan = (plan ?? subscription_plan) === undefined || (plan ?? subscription_plan) === null
      ? ""
      : String(plan ?? subscription_plan).trim().toLowerCase();
    let chosenPlan: string | null = null;
    if (rawPlan !== "") {
      if (rawPlan !== "monthly" && rawPlan !== "annual") {
        return c.json({ error: "plan must be 'monthly' or 'annual'" }, 400);
      }
      chosenPlan = rawPlan;
    }

    const db = getDb();

    // Check if user already exists
    const existing = db.query("SELECT id FROM users WHERE email = $email").get({
      $email: email.trim().toLowerCase(),
    });
    if (existing) {
      return c.json({ error: "A user with this email already exists" }, 409);
    }

    const passwordHash = await Bun.password.hash(password);

    const result = db.query(`
      INSERT INTO users (full_name, company_name, email, password_hash)
      VALUES ($full_name, $company_name, $email, $password_hash)
    `).run({
      $full_name: profileName,
      $company_name: company_name.trim(),
      $email: email.trim().toLowerCase(),
      $password_hash: passwordHash,
    });

    const userId = Number(result.lastInsertRowid);
    const token = await createAuthToken({
      user_id: userId,
      email: email.trim().toLowerCase(),
      full_name: profileName,
    });

    // Auto-create tenant + setup wizard for the new user
    const tenant = createTenantForUser(db, userId, {
      name: company_name.trim(),
      subscription_status: "TRIAL",
      subscription_plan: chosenPlan,
    });
    logAudit(db, "tenant", tenant.id, "tenant_created", {
      name: tenant.name,
      owner_user_id: userId,
      source: "register",
    });
    const wizard = findWizard(db, tenant.id);

    // ── Referral attribution ─────────────────────────────
    // If a referral_code was supplied and matches an APPROVED partner, record a
    // referral linked to this tenant. A bad/unknown/non-approved code must never
    // block registration — it is silently ignored (only logged).
    let referredPartner: { id: number; name: string } | null = null;
    if (referral_code && typeof referral_code === "string" && referral_code.trim().length > 0) {
      const code = referral_code.trim().toUpperCase();
      try {
        const partner = db.query(
          "SELECT id, first_name, last_name, status FROM partners WHERE referral_code = $code COLLATE NOCASE"
        ).get({ $code: code }) as { id: number; first_name: string; last_name: string; status: string } | undefined;

        if (!partner || partner.status !== "approved") {
          console.log(`[referral] Signup for ${email.trim().toLowerCase()} used invalid/non-approved referral code "${code}" — ignoring`);
        } else {
          // Idempotency: never create a duplicate referral for the same tenant.
          const existing = db.query("SELECT id FROM referrals WHERE tenant_id = $tid").get({ $tid: tenant.id });
          if (existing) {
            console.log(`[referral] Referral already exists for tenant ${tenant.id} — skipping attribution`);
          } else {
            const refResult = db.query(`
              INSERT INTO referrals (partner_id, partner_code, referred_company, contact_name, contact_email, signup_date, subscription_plan, subscription_amount, customer_status, tenant_id, notes)
              VALUES ($pid, $code, $company, $contact_name, $email, datetime('now'), NULL, NULL, 'trial', $tid, 'auto-attributed via signup referral code')
            `).run({
              $pid: partner.id,
              $code: code,
              $company: company_name.trim(),
              $contact_name: profileName,
              $email: email.trim().toLowerCase(),
              $tid: tenant.id,
            });
            const referralId = Number(refResult.lastInsertRowid);
            logPartnerAudit(db, partner.id, "referral_auto_attributed", { referral_id: referralId, tenant_id: tenant.id, code }, null, email.trim().toLowerCase());
            console.log(`[referral] Auto-attributed signup ${email.trim().toLowerCase()} to partner ${partner.id} (${code}) → referral #${referralId}, tenant ${tenant.id}`);
            referredPartner = { id: partner.id, name: `${partner.first_name} ${partner.last_name}` };
          }
        }
      } catch (refErr) {
        // Never let a referral error break registration.
        console.log(`[referral] Attribution error for ${email.trim().toLowerCase()}, ignoring: ${String(refErr)}`);
      }
    }

    return c.json({
      token,
      user: {
        id: userId,
        full_name: profileName,
        company_name: company_name.trim(),
        email: email.trim().toLowerCase(),
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        subscription_plan: tenant.subscription_plan ?? null,
        payment_week_start_day: tenant.payment_week_start_day,
        wizard_status: wizard?.status || "NOT_STARTED",
      },
      referred_partner: referredPartner,
    }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/login", async (c) => {
  try {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    const db = getDb();
    const user = db.query(
      "SELECT id, full_name, company_name, email, password_hash, role FROM users WHERE email = $email"
    ).get({
      $email: email.trim().toLowerCase(),
    }) as { id: number; full_name: string; company_name: string; email: string; password_hash: string; role: string } | undefined;

    if (!user) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    const valid = await Bun.password.verify(password, user.password_hash).catch(() => false);
    if (!valid) {
      if (user.password_hash === "webhook_placeholder") {
        return c.json({ error: "Account needs password setup", needs_password: true, email: user.email }, 401);
      }
      return c.json({ error: "Invalid email or password" }, 401);
    }

    const token = await createAuthToken({
      user_id: user.id,
      email: user.email,
      full_name: user.full_name,
    });

    const tenant = findTenantForUser(db, user.id);
    const wizard = tenant ? findWizard(db, tenant.id) : undefined;

    return c.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        company_name: user.company_name,
        email: user.email,
        role: user.role || "user",
      },
      tenant: tenant ? {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        payment_week_start_day: tenant.payment_week_start_day,
        wizard_status: wizard?.status || "NOT_STARTED",
      } : null,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/set-password", async (c) => {
  try {
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    if (!email || !email.includes("@") || newPassword.length < 6) {
      return c.json({ error: "Valid email and a password of at least 6 characters are required" }, 400);
    }
    const db = getDb();
    const user = db.query("SELECT id FROM users WHERE email = $email").get({ $email: email }) as { id: number } | undefined;
    if (!user) return c.json({ error: "User not found" }, 404);
    const passwordHash = await Bun.password.hash(newPassword);
    db.query("UPDATE users SET password_hash = $password_hash WHERE id = $id").run({ $password_hash: passwordHash, $id: user.id });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/send-setup-link", async (c) => {
  try {
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return c.json({ error: "Email is required" }, 400);
    const db = getDb();
    const user = db.query("SELECT password_hash FROM users WHERE email = $email").get({ $email: email }) as { password_hash: string } | undefined;
    if (!user) return c.json({ needs_password: false });
    return c.json({ needs_password: user.password_hash === "webhook_placeholder" });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/forgot-password", async (c) => {
  try {
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return c.json({ error: "Email is required" }, 400);
    const db = getDb();
    const user = db.query("SELECT id, full_name FROM users WHERE email = $email").get({ $email: email }) as { id: number; full_name: string } | undefined;

    if (user) {
      // Generate a reset token: base64url random bytes, valid for 1 hour.
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const token = Buffer.from(bytes).toString("base64url");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.query("UPDATE users SET reset_token = $token, reset_token_expires = $expires WHERE id = $id").run({
        $token: token,
        $expires: expiresAt,
        $id: user.id,
      });
      const resetLink = `https://cleartopay.ctonew.app/app/reset-password?token=${encodeURIComponent(token)}`;
      sendEmail([email], "Reset your ClearToPay password", buildPasswordResetEmail(user.full_name, resetLink), undefined, undefined, "password_reset");
    }

    // Always return success — never reveal whether the email exists.
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
app.post("/api/auth/reset-password", async (c) => {
  try {
    const body = await c.req.json();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    if (!token || newPassword.length < 6) {
      return c.json({ error: "A valid token and a password of at least 6 characters are required" }, 400);
    }
    const db = getDb();
    const user = db.query(
      "SELECT id FROM users WHERE reset_token = $token AND reset_token_expires > $now"
    ).get({ $token: token, $now: new Date().toISOString() }) as { id: number } | undefined;
    if (!user) {
      return c.json({ error: "Invalid or expired reset link" }, 400);
    }
    const passwordHash = await Bun.password.hash(newPassword);
    db.query("UPDATE users SET password_hash = $password_hash, reset_token = NULL, reset_token_expires = NULL WHERE id = $id").run({
      $password_hash: passwordHash,
      $id: user.id,
    });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
app.post("/api/auth/logout", (c) => {
  // JWT is stateless — just return success
  return c.json({ success: true });
});

app.get("/api/auth/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = authHeader.slice(7);
  const user = await verifyAuthToken(token);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = getDb();
  const dbUser = db.query(
    "SELECT id, full_name, company_name, email, role, created_at FROM users WHERE id = $id"
  ).get({ $id: user.user_id }) as { id: number; full_name: string; company_name: string; email: string; role: string; created_at: string } | undefined;

  if (!dbUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const tenant = findTenantForUser(db, user.user_id);
  const wizard = tenant ? findWizard(db, tenant.id) : undefined;

  return c.json({
    id: dbUser.id,
    full_name: dbUser.full_name,
    company_name: dbUser.company_name,
    email: dbUser.email,
    role: dbUser.role || "user",
    created_at: dbUser.created_at,
    tenant_id: tenant?.id ?? null,
    tenant_name: tenant?.name ?? null,
    subscription_status: tenant?.subscription_status ?? null,
    payment_week_start_day: tenant?.payment_week_start_day ?? "monday",
    wizard_status: wizard?.status ?? null,
    inbox_slug: tenant?.inbox_slug ?? null,
    inbox_address: buildInboxAddress(tenant?.inbox_slug ?? null),
  });
});

export default app;
