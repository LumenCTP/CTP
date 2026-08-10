import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { AuthProvider, useAuth, needsSetup, needsPartnerSetup, type User } from "./components/AuthContext";
import Layout from "./components/Layout";
import PartnerShell from "./components/PartnerShell";
import Dashboard from "./pages/Dashboard";
import Clients from "./pages/Clients";
import Vendors from "./pages/Vendors";
import VendorDetail from "./pages/VendorDetail";
import Documents from "./pages/Documents";
import DocumentDetail from "./pages/DocumentDetail";
import Reports from "./pages/Reports";
import NeedsReview from "./pages/NeedsReview";
import EmailLog from "./pages/EmailLog";
import Login from "./pages/Login";
import Register from "./pages/Register";
import SetupWizard from "./pages/SetupWizard";
import SetPassword from "./pages/SetPassword";
import ResetPassword from "./pages/ResetPassword";
import PartnerLogin from "./pages/PartnerLogin";
import PartnerRegister from "./pages/PartnerRegister";
import PartnerDashboard from "./pages/PartnerDashboard";
import PartnerRefer from "./pages/PartnerRefer";
import PartnerReferrals from "./pages/PartnerReferrals";
import PartnerCommissions from "./pages/PartnerCommissions";
import PartnerPayouts from "./pages/PartnerPayouts";
import AdminShell from "./components/AdminShell";
import AdminDashboard from "./pages/admin/Dashboard";
import AdminPartners from "./pages/admin/Partners";
import AdminReferrals from "./pages/admin/Referrals";
import AdminCommissions from "./pages/admin/Commissions";
import AdminPayouts from "./pages/admin/Payouts";
import AdminAuditLog from "./pages/admin/AuditLog";
import AdminAccounts from "./pages/admin/Accounts";

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
  if (user && needsSetup(user)) {
    return <Navigate to="/app/setup" replace />;
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
// suspended — they must be approved before using the portal.
function PartnerStatusPage() {
  const { user } = useAuth();
  const status = user?.partner_status ?? "pending";

  const copy: Record<string, { title: string; message: string }> = {
    pending: {
      title: "Application Pending Approval",
      message: "Your partner application is under review. You'll receive an email as soon as your account is approved. Check back soon!",
    },
    rejected: {
      title: "Application Not Approved",
      message: "We were unable to approve your partner application. If you think this is a mistake, contact us at support@cleartopay.com.",
    },
    suspended: {
      title: "Account Suspended",
      message: "Your partner account has been suspended. Contact us at support@cleartopay.com for more information.",
    },
    terminated: {
      title: "Account Terminated",
      message: "Your partner account has been terminated. Contact us at support@cleartopay.com if you have questions.",
    },
  };
  const content = copy[status] ?? copy.pending;

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo">CTP</div>
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
// redirected away. If partner status isn't loaded yet (e.g. right after login),
// it is fetched via /api/partner/me through refreshUser() before deciding.
function PartnerRoute() {
  const { user, loading, refreshUser } = useAuth();
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (user?.role === "partner" && !user.partner_status && !loading) {
      setVerifying(true);
      refreshUser().finally(() => setVerifying(false));
    }
  }, [user, loading, refreshUser]);

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

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
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
            </Route>

            {/* Partner portal — approved partners only */}
            <Route element={<PartnerRoute />}>
              <Route path="app/partner" element={<PartnerShell />}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<PartnerDashboard />} />
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
              </Route>
            </Route>
          </Route>

          {/* Fallbacks */}
          <Route path="/" element={<HomeRedirect />} />
          <Route path="*" element={<HomeRedirect />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

// Re-export User type for consumers that need it
export type { User };
