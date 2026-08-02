import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { AuthProvider, useAuth, needsSetup, type User } from "./components/AuthContext";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Clients from "./pages/Clients";
import Vendors from "./pages/Vendors";
import Documents from "./pages/Documents";
import Reports from "./pages/Reports";
import NeedsReview from "./pages/NeedsReview";
import EmailLog from "./pages/EmailLog";
import Login from "./pages/Login";
import Register from "./pages/Register";
import SetupWizard from "./pages/SetupWizard";
import SetPassword from "./pages/SetPassword";

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
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

// Authenticated users with an unfinished setup wizard go to /app/setup;
// everyone else goes to the dashboard (/app).
function HomeRedirect() {
  const { user } = useAuth();
  if (user && needsSetup(user)) {
    return <Navigate to="/app/setup" replace />;
  }
  return <Navigate to="/app" replace />;
}

// Guards the main app shell: auth required, and the setup wizard must be
// completed before the dashboard and its sub-pages can be used.
function AppShell() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (needsSetup(user)) {
    return <Navigate to="/app/setup" replace />;
  }

  return <Layout />;
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
            <Route path="login" element={<Login />} />
            <Route path="register" element={<Register />} />
            <Route path="app/set-password" element={<SetPassword />} />
          </Route>

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            {/* Setup wizard (full screen, no app shell) */}
            <Route path="app/setup" element={<SetupWizard />} />

            {/* Main app shell — blocked until setup wizard is COMPLETED */}
            <Route path="app" element={<AppShell />}>
              <Route index element={<Dashboard />} />
              <Route path="clients" element={<Clients />} />
              <Route path="vendors" element={<Vendors />} />
              <Route path="documents" element={<Documents />} />
              <Route path="reports" element={<Reports />} />
              <Route path="needs-review" element={<NeedsReview />} />
              <Route path="email-log" element={<EmailLog />} />
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
