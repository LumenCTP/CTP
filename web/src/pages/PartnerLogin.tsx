import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth, needsPartnerSetup } from "../components/AuthContext";
import Logo from "../components/Logo";

export default function PartnerLogin() {
  const { user, loading, login, logout, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p style={{ textAlign: "center", color: "var(--text-muted)" }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Already signed in — partners go to their dashboard, everyone else to the app.
  if (user) {
    if (user.role === "partner") {
      return <Navigate to={needsPartnerSetup(user) ? "/app/partner/status" : "/app/partner/dashboard"} replace />;
    }
    return <Navigate to="/app" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }

    setSubmitting(true);
    const err = await login(email.trim(), password);
    if (err) {
      setSubmitting(false);
      setError(err);
      return;
    }

    // login() stores the user in localStorage — read it back to check the role.
    let role: string | null = null;
    try {
      const raw = localStorage.getItem("cleartopay_user");
      role = raw ? (JSON.parse(raw).role ?? null) : null;
    } catch {
      // ignore
    }

    if (role !== "partner") {
      // Non-partner account signing in at the partner portal — clear the session.
      logout();
      setSubmitting(false);
      setError("This account is not a partner account");
      return;
    }

    // Fetch partner-specific data (status, referral code) before entering the portal.
    await refreshUser();
    setSubmitting(false);
    navigate("/app/partner/dashboard", { replace: true });
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
          <h2>Partner Portal</h2>
          <p className="auth-subtitle">Sign in to your ClearToPay partner account</p>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@agency.com"
              autoComplete="email"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          <button type="submit" className="auth-btn" disabled={submitting}>
            {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p className="auth-footer">
          New to the partner program?{" "}
          <Link to="/app/partner/register">Apply to become a partner</Link>
        </p>
      </div>
    </div>
  );
}
