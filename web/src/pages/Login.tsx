import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth, needsSetup } from "../components/AuthContext";
import Logo from "../components/Logo";
import { apiFetch } from "../lib/api";

export default function Login() {
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState((location.state as { email?: string } | undefined)?.email || "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);

  // Forgot-password state
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState("");

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

  async function handleForgotSubmit(e: FormEvent) {
    e.preventDefault();
    setForgotError("");
    setForgotSent(false);

    if (!forgotEmail.trim() || !forgotEmail.includes("@")) {
      setForgotError("Enter a valid email address.");
      return;
    }

    setForgotSubmitting(true);
    try {
      const res = await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setForgotError(data.error || "Something went wrong. Please try again.");
      } else {
        setForgotSent(true);
      }
    } catch {
      setForgotError("Something went wrong. Please try again.");
    } finally {
      setForgotSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
          <h2>ClearToPay Construction</h2>
          <p className="auth-subtitle">{showForgot ? "Reset your password" : "Sign in to your account"}</p>
        </div>

        {!showForgot && error && <div className="auth-error">{error}{needsPassword && <> <Link to="/app/set-password" state={{ email }}>Set up your password</Link></>}</div>}
        {showForgot && forgotError && <div className="auth-error">{forgotError}</div>}
        {showForgot && forgotSent && (
          <div className="auth-success">If that email exists, a reset link has been sent.</div>
        )}

        {!showForgot ? (
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
        ) : (
          <form onSubmit={handleForgotSubmit} className="auth-form">
            <div className="form-group">
              <label htmlFor="forgot-email">Email</label>
              <input
                id="forgot-email"
                type="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                autoFocus
              />
            </div>
            <button type="submit" className="auth-btn" disabled={forgotSubmitting}>
              {forgotSubmitting ? "Sending..." : "Send Reset Link"}
            </button>
          </form>
        )}

        <p className="auth-forgot">
          {showForgot ? (
            <button type="button" className="auth-link-btn" onClick={() => { setShowForgot(false); setForgotSent(false); setForgotError(""); }}>
              ← Back to sign in
            </button>
          ) : (
            <button type="button" className="auth-link-btn" onClick={() => setShowForgot(true)}>
              Forgot password?
            </button>
          )}
        </p>

        {!showForgot && (
          <p className="auth-footer">
            Don't have an account?{" "}
            <Link to="/register">Create one</Link>
          </p>
        )}
      </div>
    </div>
  );
}
