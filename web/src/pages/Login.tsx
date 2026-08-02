import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth, needsSetup } from "../components/AuthContext";

export default function Login() {
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState((location.state as { email?: string } | null)?.email || "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p style={{ textAlign: "center", color: "var(--text-muted)" }}>Loading...</p>
        </div>
      </div>
    );
  }

  if (user) {
    return <Navigate to={needsSetup(user) ? "/app/setup" : "/app"} replace />;
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
    setSubmitting(false);

    if (err) {
      setError(err);
      setNeedsPassword(err === "Account needs password setup");
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo">CTP</div>
          <h2>ClearToPay Compliance</h2>
          <p className="auth-subtitle">Sign in to your account</p>
        </div>

        {error && <div className="auth-error">{error}{needsPassword && <> <Link to="/app/set-password" state={{ email }}>Set up your password</Link></>}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
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
          Don't have an account?{" "}
          <Link to="/register">Create one</Link>
        </p>
      </div>
    </div>
  );
}
