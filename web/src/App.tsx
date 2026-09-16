import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth, needsSetup, needsPayment, getHomePath, needsPartnerSetup, type User } from "./components/AuthContext";
import Layout from "./components/Layout";
import PartnerShell from "./components/PartnerShell";
import Logo from "./components/Logo";
import AdminShell from "./components/AdminShell";
import Paywall from "./pages/Paywall";

// Route-level code splitting: every leaf page below is loaded on demand, so
// visitors only download the chunks for the routes they can actually reach
// (public auth pages, client app tree, partner portal, admin dashboard).
// Guards and shells stay eagerly imported — they drive every route decision.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Clients = lazy(() => import("./pages/Clients"));
const Vendors = lazy(() => import("./pages/Vendors"));
const VendorDetail = lazy(() => import("./pages/VendorDetail"));
const Documents = lazy(() => import("./pages/Documents"));
const DocumentDetail = lazy(() => import("./pages/DocumentDetail"));
const Reports = lazy(() => import("./pages/Reports"));
const NeedsReview = lazy(() => import("./pages/NeedsReview"));
const EmailLog = lazy(() => import("./pages/EmailLog"));
const Billing = lazy(() => import("./pages/Billing"));
const Login = lazy(() => import("./pages/Login"));
const Register = lazy(() => import("./pages/Register"));
const SetupWizard = lazy(() => import("./pages/SetupWizard"));
const SetPassword = lazy(() => import("./pages/SetPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const PartnerLogin = lazy(() => import("./pages/PartnerLogin"));
const PartnerRegister = lazy(() => import("./pages/PartnerRegister"));
const PartnerDashboard = lazy(() => import("./pages/PartnerDashboard"));
const PartnerRefer = lazy(() => import("./pages/PartnerRefer"));
const PartnerReferralCode = lazy(() => import("./pages/PartnerReferralCode"));
const PartnerReferrals = lazy(() => import("./pages/PartnerReferrals"));
const PartnerCommissions = lazy(() => import("./pages/PartnerCommissions"));
const PartnerPayouts = lazy(() => import("./pages/PartnerPayouts"));
const AdminDashboard = lazy(() => import("./pages/admin/Dashboard"));
const AdminPartners = lazy(() => import("./pages/admin/Partners"));
const AdminReferrals = lazy(() => import("./pages/admin/Referrals"));
const AdminCommissions = lazy(() => import("./pages/admin/Commissions"));
const AdminPayouts = lazy(() => import("./pages/admin/Payouts"));
const AdminAuditLog = lazy(() => import("./pages/admin/AuditLog"));
const AdminAccounts = lazy(() => import("./pages/admin/Accounts"));
const AdminQuestions = lazy(() => import("./pages/admin/Questions"));
const AdminCashflow = lazy(() => import("./pages/admin/Cashflow"));

function LoadingScreen() {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100vh", color: "var(--text-muted)", fontSize: "1rem",
    }}>
      Loading...
    </div>
  );
}

function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/app/login" replace />;
  }

  // Paywall gate: unpaid (PENDING/TRIAL/PAST_DUE) tenants must complete
  // payment before reaching the app, the setup wizard, or any other tenant UI.
  if (needsPayment(user)) {
    return <Paywall />;
  }

  return <Outlet />;
}

// Authenticated users with an unfinished setup wizard go to /app/setup;
// partners go to the partner portal; admins go to the admin dashboard;
// everyone else goes to the dashboard (/app).
function HomeRedirect() {
  const { user } = useAuth();
  if (user?.role === "admin") {
    return <Navigate to="/app/admin/dashboard" replace />;
  }
  if (user?.role === "partner") {
    return <Navigate to={needsPartnerSetup(user) ? "/app/partner/status" : "/app/partner/dashboard"} replace />;
  }
  if (user) {
    return <Navigate to={getHomePath(user)} replace />;
  }
  return <Navigate to="/app" replace />;
}

// Guards the main app shell: auth required, and the setup wizard must be
// completed before the dashboard and its sub-pages can be used. Partners are
// redirected to their own portal.
function AppShell() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/app/login" replace />;
  }

  if (user.role === "admin") {
    return <Navigate to="/app/admin/dashboard" replace />;
  }

  if (user.role === "partner") {
    return <Navigate to={needsPartnerSetup(user) ? "/app/partner/status" : "/app/partner/dashboard"} replace />;
  }

  if (needsSetup(user)) {
    return <Navigate to="/app/setup" replace />;
  }

  return <Layout />;
}

// Full-page status shown to partners whose application is pending/rejected/
// suspended — they must be approved before using the portal. Approved partners
// must never be parked here: the real status is re-checked on mount and the
// partner is sent straight into the portal as soon as the API says approved.
function PartnerStatusPage() {
  const { user, loading, refreshUser } = useAuth();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (user?.role !== "partner") {
      setChecking(false);
      return;
    }
    setChecking(true);
    refreshUser().finally(() => setChecking(false));
  }, [loading, user?.role, refreshUser]);

  if (loading || (checking && user?.role === "partner")) {
    return <LoadingScreen />;
  }

  // Only partners may see a partner status banner. A signed-out visitor or a
  // non-partner account reaching this route is redirected instead of being
  // shown a fabricated "Application Pending" status for an account that has no
  // partner application at all.
  if (user?.role !== "partner") {
    return <Navigate to={user ? "/app" : "/app/partner/login"} replace />;
  }

  if (!needsPartnerSetup(user)) {
    return <Navigate to="/app/partner/dashboard" replace />;
  }

  const status = user?.partner_status ?? "pending";

  const copy: Record<string, { title: string; message: string }> = {
    pending: {
      title: "Application Pending",
      message: "Your partner account is currently pending. Contact us at documents@cleartopayconstruction.com if you have questions.",
    },
    rejected: {
      title: "Application Not Approved",
      message: "We were unable to approve your partner application. If you think this is a mistake, contact us at documents@cleartopayconstruction.com.",
    },
    suspended: {
      title: "Account Suspended",
      message: "Your partner account has been suspended. Contact us at documents@cleartopayconstruction.com for more information.",
    },
    terminated: {
      title: "Account Terminated",
      message: "Your partner account has been terminated. Contact us at documents@cleartopayconstruction.com if you have questions.",
    },
  };
  const content = copy[status] ?? copy.pending;

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
          <h2>Partner Portal</h2>
        </div>
        <div className={`partner-status-banner partner-status-${status}`}>
          <strong>{content.title}</strong>
          <p>{content.message}</p>
        </div>
        <p className="auth-footer">
          <a href="/app/partner/login" style={{ color: "var(--blue)" }}>← Back to login</a>
        </p>
      </div>
    </div>
  );
}

// Guards the partner portal: only approved partners may pass. Anyone else is
// redirected away. Unless the cached status is already a definitive "approved",
// the status is re-fetched via /api/partner/me through refreshUser() before
// deciding — so a partner who was approved after their status was last cached
// (or whose cached status came from an API blip) still gets straight in.
function PartnerRoute() {
  const { user, loading, refreshUser } = useAuth();
  const [verifying, setVerifying] = useState(false);
  const mustVerify = user?.role === "partner" && user.partner_status !== "approved";

  useEffect(() => {
    if (mustVerify && !loading) {
      setVerifying(true);
      refreshUser().finally(() => setVerifying(false));
    }
  }, [mustVerify, loading, refreshUser]);

  if (loading || verifying) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/app/partner/login" replace />;
  }

  if (user.role !== "partner") {
    return <Navigate to="/app/login" replace />;
  }

  if (needsPartnerSetup(user)) {
    return <Navigate to="/app/partner/status" replace />;
  }

  return <Outlet />;
}

// Guards the admin dashboard: only users with role='admin' may pass. Admins
// have no tenant record, so no setup-wizard or tenant checks apply here.
function AdminRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/app/login" replace />;
  }

  if (user.role !== "admin") {
    return <Navigate to="/app/login" replace />;
  }

  return <Outlet />;
}

function PublicRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (user) {
    return <HomeRedirect />;
  }

  return <Outlet />;
}

// localStorage key the marketing /checkout page uses to stash the Stripe
// session id before redirecting to Stripe (so the confirm step works even if
// Stripe's ?session_id= query param is stripped by an intermediate redirect).
const CHECKOUT_SESSION_KEY = "cleartopay_checkout_session";

/**
 * Handles the return from Stripe Checkout on /app?checkout=success. Calls
 * POST /api/checkout/confirm with the session id (URL param first, then the
 * localStorage stash), then re-fetches /me so the app reflects the now-ACTIVE
 * tenant (wizard or dashboard). Safe to run more than once — the webhook may
 * have already activated the tenant; confirm is idempotent.
 */
function CheckoutReturnHandler() {
  const { token, loading, refreshUser } = useAuth();
  const [activating, setActivating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (loading || !token) return;
    if (typeof window === "undefined") return;
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("checkout") !== "success") return;

    let sessionId = qs.get("session_id");
    if (!sessionId) {
      try {
        sessionId = localStorage.getItem(CHECKOUT_SESSION_KEY);
      } catch {
        sessionId = null;
      }
    }

    setActivating(true);
    (async () => {
      // The Stripe webhook may lag behind checkout completion. Re-run confirm
      // (idempotent) and re-check /me a few times over ~10s so a slow webhook
      // doesn't bounce a customer who just paid straight to the paywall.
      let activated = false;
      for (let attempt = 0; attempt < 5 && !activated; attempt++) {
        if (sessionId) {
          try {
            await fetch("/api/checkout/confirm", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ session_id: sessionId }),
            });
          } catch {
            // Network error — retry on the next attempt.
          }
        }
        try {
          const meRes = await fetch("/api/auth/me", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (meRes.ok) {
            const me = await meRes.json() as { subscription_status?: string | null };
            activated = me.subscription_status === "ACTIVE" || me.subscription_status === "TRIAL";
          }
        } catch {
          // retry on the next attempt
        }
        if (!activated && attempt < 4) {
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
      // Final refresh /me so the shell routes to the wizard/dashboard (or the
      // paywall, whose "check status" action can re-confirm if the webhook
      // still hasn't landed).
      try {
        await refreshUser();
      } catch {
        // fall through; /me will be refreshed on next mount
      }
      try {
        localStorage.removeItem(CHECKOUT_SESSION_KEY);
      } catch {
        // ignore
      }
      // Strip the ?checkout=success&session_id=... params so a reload doesn't
      // re-run confirmation.
      window.history.replaceState({}, "", "/app");
      setActivating(false);
      navigate("/app", { replace: true });
    })();
  }, [loading, token, refreshUser, navigate]);

  if (activating) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100vh", color: "var(--text-muted)", fontSize: "1rem",
        flexDirection: "column", gap: 12,
      }}>
        <Logo size={48} />
        Activating your account…
      </div>
    );
  }
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CheckoutReturnHandler />
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
          {/* Public routes */}
          <Route element={<PublicRoute />}>
            <Route path="app/login" element={<Login />} />
            <Route path="app/register" element={<Register />} />
            <Route path="app/set-password" element={<SetPassword />} />
            <Route path="app/reset-password" element={<ResetPassword />} />
            <Route path="app/partner/login" element={<PartnerLogin />} />
            <Route path="app/partner/register" element={<PartnerRegister />} />
          </Route>

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            {/* Setup wizard (full screen, no app shell) */}
            <Route path="app/setup" element={<SetupWizard />} />

            {/* Partner status page — visible to signed-in partners waiting for approval */}
            <Route path="app/partner/status" element={<PartnerStatusPage />} />

            {/* Main app shell — blocked until setup wizard is COMPLETED */}
            <Route path="app" element={<AppShell />}>
              <Route index element={<Dashboard />} />
              <Route path="clients" element={<Clients />} />
              <Route path="vendors" element={<Vendors />} />
              <Route path="vendors/:id" element={<VendorDetail />} />
              <Route path="documents" element={<Documents />} />
              <Route path="documents/:id" element={<DocumentDetail />} />
              <Route path="reports" element={<Reports />} />
              <Route path="needs-review" element={<NeedsReview />} />
              <Route path="email-log" element={<EmailLog />} />
              <Route path="billing" element={<Billing />} />
            </Route>

            {/* Partner portal — approved partners only */}
            <Route element={<PartnerRoute />}>
              <Route path="app/partner" element={<PartnerShell />}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<PartnerDashboard />} />
                <Route path="referral-code" element={<PartnerReferralCode />} />
                <Route path="refer" element={<PartnerRefer />} />
                <Route path="referrals" element={<PartnerReferrals />} />
                <Route path="commissions" element={<PartnerCommissions />} />
                <Route path="payouts" element={<PartnerPayouts />} />
              </Route>
            </Route>

            {/* Admin dashboard — admins only */}
            <Route element={<AdminRoute />}>
              <Route path="app/admin" element={<AdminShell />}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<AdminDashboard />} />
                <Route path="partners" element={<AdminPartners />} />
                <Route path="referrals" element={<AdminReferrals />} />
                <Route path="commissions" element={<AdminCommissions />} />
                <Route path="payouts" element={<AdminPayouts />} />
                <Route path="audit" element={<AdminAuditLog />} />
                <Route path="accounts" element={<AdminAccounts />} />
                <Route path="questions" element={<AdminQuestions />} />
                <Route path="cashflow" element={<AdminCashflow />} />
              </Route>
            </Route>
          </Route>

          {/* Fallbacks */}
          <Route path="/" element={<HomeRedirect />} />
          <Route path="*" element={<HomeRedirect />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}

// Re-export User type for consumers that need it
export type { User };
