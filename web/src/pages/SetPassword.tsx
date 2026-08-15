import { apiFetch } from "../lib/api";
import Logo from "../components/Logo";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

// Two modes:
//  1. One-time setup link (token in the URL, emailed by /api/auth/send-setup-link):
//     show the password form; submit { email, token, new_password }.
//  2. No token yet: ask for the email and email a secure setup link. The
//     password is NEVER settable with just an email — the account-claim fix.
export default function SetPassword() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const locationEmail = (location.state as { email?: string } | undefined)?.email || searchParams.get("email") || "";

  const [email, setEmail] = useState(locationEmail);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, token, new_password: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not set password.");
        return;
      }
      setDone(true);
      setTimeout(() => navigate("/app/login", { state: { email } }), 700);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendLink(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim() || !email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/auth/send-setup-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not send the setup link.");
        return;
      }
      setSent(true);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const hasToken = token.length > 0;

  return <div className="auth-page"><div className="auth-card">
    <div className="auth-header"><div className="auth-logo-slot"><Logo size={48} /></div><h2>Set your password</h2><p className="auth-subtitle">Finish setting up your ClearToPay account</p></div>
    {error && <div className="auth-error">{error}</div>}
    {done ? <div className="auth-success">Password set. Redirecting to sign in...</div>
      : sent ? <div className="auth-success">If this account needs a password, a secure setup link is on its way. Check your email — the link expires in 1 hour.</div>
      : hasToken ? (
        <form onSubmit={submit} className="auth-form">
          <div className="form-group"><label htmlFor="setup-email">Email</label><input id="setup-email" type="email" required value={email} readOnly onChange={() => {}} autoComplete="email" /></div>
          <div className="form-group"><label htmlFor="setup-password">New password</label><input id="setup-password" type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></div>
          <div className="form-group"><label htmlFor="setup-confirm">Confirm password</label><input id="setup-confirm" type="password" required value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" /></div>
          <button type="submit" className="auth-btn" disabled={submitting}>{submitting ? "Setting password..." : "Set password"}</button>
        </form>
      ) : (
        <form onSubmit={sendLink} className="auth-form">
          <div className="form-group"><label htmlFor="setup-email">Email</label><input id="setup-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" placeholder="you@company.com" autoFocus /></div>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>For your security, we'll email you a one-time link to set your password. You'll need access to this email inbox.</p>
          <button type="submit" className="auth-btn" disabled={submitting}>{submitting ? "Sending..." : "Email me a setup link"}</button>
        </form>
      )}
    <p className="auth-footer"><Link to="/app/login">Back to sign in</Link></p>
  </div></div>;
}
