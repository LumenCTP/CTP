import { apiFetch } from "../lib/api";
import Logo from "../components/Logo";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    const res = await apiFetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, new_password: password }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Invalid or expired reset link");
    setDone(true);
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
          <h2>Reset your password</h2>
          <p className="auth-subtitle">Choose a new password for your ClearToPay account</p>
        </div>

        {!token && !done && (
          <>
            <div className="auth-error">Invalid or expired reset link</div>
            <p className="auth-footer"><Link to="/login">Back to sign in</Link></p>
          </>
        )}

        {token && !done && (
          <>
            {error && <div className="auth-error">{error}</div>}
            <form onSubmit={submit} className="auth-form">
              <div className="form-group">
                <label htmlFor="reset-password">New password</label>
                <input
                  id="reset-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  autoComplete="new-password"
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="reset-confirm">Confirm password</label>
                <input
                  id="reset-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>
              <button type="submit" className="auth-btn">Reset Password</button>
            </form>
            <p className="auth-footer"><Link to="/login">Back to sign in</Link></p>
          </>
        )}

        {done && (
          <>
            <div className="auth-success">Password reset! Sign in with your new password.</div>
            <p className="auth-footer"><Link to="/login">Sign in</Link></p>
          </>
        )}
      </div>
    </div>
  );
}
