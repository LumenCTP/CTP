import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb } from "./db";
import { startScheduler } from "./scheduler";
import { TENANT_DATA_PATHS, requireAuth, requireTenant, isQueueRoute } from "./middleware";
import authRoutes from "./auth";
import supportRoutes from "./routes/support";
import adminSupportRoutes from "./routes/admin-support";
import stripeRoutes from "./routes/stripe";
import setupRoutes from "./routes/setup";
import healthRoutes from "./routes/health";
import dashboardRoutes from "./routes/dashboard";
import csvRoutes from "./routes/csv";
import clientsRoutes from "./routes/clients";
import vendorsRoutes from "./routes/vendors";
import documentsRoutes from "./routes/documents";
import complianceRoutes from "./routes/compliance";
import reportsRoutes from "./routes/reports";
import auditRoutes from "./routes/audit";
import emailsRoutes from "./routes/emails";
import partnersRoutes from "./routes/partners";

const app = new Hono();

// Global JSON error handler — ensures all errors return JSON, not plaintext
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: err.message || "Internal server error" }, 500);
});

// Global 404 handler — returns JSON instead of Hono's plaintext default
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

app.use("/*", cors());

// All tenant-owned data endpoints require both authentication and a tenant.
// Keeping this as a path middleware prevents a newly-added data route from
// accidentally becoming a cross-tenant data leak.
//
// NOTE: this MUST be registered before the route modules below — Hono matches
// middleware and handlers from the same router in registration order, so
// middleware registered after a route would run after (or never before) it.
for (const pattern of TENANT_DATA_PATHS) {
  app.use(pattern, async (c, next) => {
    if (isQueueRoute(c)) return next();
    return requireAuth(c, () => requireTenant(c, next));
  });
}

// Mount route modules (internal paths carry the full /api/... prefix)
app.route("/", authRoutes);
app.route("/", supportRoutes);
app.route("/", adminSupportRoutes);
app.route("/", stripeRoutes);
app.route("/", setupRoutes);
app.route("/", healthRoutes);
app.route("/", dashboardRoutes);
app.route("/", csvRoutes);
app.route("/", clientsRoutes);
app.route("/", vendorsRoutes);
app.route("/", documentsRoutes);
app.route("/", complianceRoutes);
app.route("/", reportsRoutes);
app.route("/", auditRoutes);
app.route("/", emailsRoutes);
app.route("/", partnersRoutes);

// Initialize DB on startup
getDb();

// Start the email scheduler
startScheduler();

export default {
  port: 3001,
  fetch: app.fetch,
};
