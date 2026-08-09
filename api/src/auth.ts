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

const app = new Hono();

// ── Auth Routes ─────────────────────────────────────────

app.post("/api/auth/register", async (c) => {
  try {
    const body = await c.req.json();
    const { full_name, company_name, email, password } = body;

    if (!full_name || typeof full_name !== "string" || full_name.trim().length === 0) {
      return c.json({ error: "Full name is required" }, 400);
    }
    if (!company_name || typeof company_name !== "string" || company_name.trim().length === 0) {
      return c.json({ error: "Company name is required" }, 400);
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return c.json({ error: "Valid email is required" }, 400);
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
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
      $full_name: full_name.trim(),
      $company_name: company_name.trim(),
      $email: email.trim().toLowerCase(),
      $password_hash: passwordHash,
    });

    const userId = Number(result.lastInsertRowid);
    const token = await createAuthToken({
      user_id: userId,
      email: email.trim().toLowerCase(),
      full_name: full_name.trim(),
    });

    // Auto-create tenant + setup wizard for the new user
    const tenant = createTenantForUser(db, userId, {
      name: company_name.trim(),
      subscription_status: "TRIAL",
    });
    logAudit(db, "tenant", tenant.id, "tenant_created", {
      name: tenant.name,
      owner_user_id: userId,
      source: "register",
    });
    const wizard = findWizard(db, tenant.id);

    return c.json({
      token,
      user: {
        id: userId,
        full_name: full_name.trim(),
        company_name: company_name.trim(),
        email: email.trim().toLowerCase(),
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subscription_status: tenant.subscription_status,
        payment_week_start_day: tenant.payment_week_start_day,
        wizard_status: wizard?.status || "NOT_STARTED",
      },
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
    inbox_address: tenant?.inbox_slug ? `cleartopay-compliance-0d8d884b+${tenant.inbox_slug}@ctomail.io` : null,
  });
});

export default app;
