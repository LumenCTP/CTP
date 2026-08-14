import { apiFetch } from "../lib/api";
import Logo from "../components/Logo";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

export default function SetPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError("");
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    const res = await apiFetch("/api/auth/set-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, new_password: password }) });
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Could not set password.");
    setDone(true);
    setTimeout(() => navigate("/app/login", { state: { email } }), 700);
  }
  return <div className="auth-page"><div className="auth-card">
    <div className="auth-header"><div className="auth-logo-slot"><Logo size={48} /></div><h2>Set your password</h2><p className="auth-subtitle">Finish setting up your ClearToPay account</p></div>
    {error && <div className="auth-error">{error}</div>}
    {done ? <div className="auth-success">Password set. Redirecting to sign in...</div> : <form onSubmit={submit} className="auth-form">
      <div className="form-group"><label htmlFor="setup-email">Email</label><input id="setup-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></div>
      <div className="form-group"><label htmlFor="setup-password">New password</label><input id="setup-password" type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></div>
      <div className="form-group"><label htmlFor="setup-confirm">Confirm password</label><input id="setup-confirm" type="password" required value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" /></div>
      <button type="submit" className="auth-btn">Set password</button>
    </form>}
    <p className="auth-footer"><Link to="/app/login">Back to sign in</Link></p>
  </div></div>;
}
