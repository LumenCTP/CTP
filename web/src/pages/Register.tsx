import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth, getHomePath } from "../components/AuthContext";
import Logo from "../components/Logo";

export default function Register() {
  const { user, loading, register } = useAuth();
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [plan, setPlan] = useState<"monthly" | "annual">("monthly");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Optional partner referral code captured from ?ref= in the URL
  // (e.g. cleartopay-dev.ctonew.app/app/register?ref=CODE). Passed through to
  // /api/auth/register so signups are attributed to the referring partner.
  const referralCode = new URLSearchParams(window.location.search).get("ref") || undefined;

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p style={{ textAlign: "center", color: "var(--text-muted)" }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Already logged in: PENDING tenants land on the paywall (/app), everyone
  // else goes to the wizard or dashboard. Newly-registered users are redirected
  // to /checkout inside handleSubmit (see below) — not the wizard.
  if (user) {
    return <Navigate to={getHomePath(user)} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!companyName.trim()) {
      setError("Company name is required.");
      return;
    }
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    if (!password || password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    // The account profile name IS the company name — register passes the
    // company name as the profile name (the API ignores any separate name).
    const err = await register(companyName.trim(), companyName.trim(), email.trim(), password, referralCode, plan);
    setSubmitting(false);

    if (err) {
      setError(err);
      return;
    }

    // Account created with a PENDING tenant — the customer completes checkout
    // (card on file) to start the 30-day free trial. Send them to the marketing
    // /checkout page (same origin) with their chosen plan preselected.
    window.location.href = `/checkout?plan=${plan}&registered=1`;
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
          <h2>Create Your Account</h2>
          <p className="auth-subtitle">Get started with ClearToPay Construction</p>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="companyName">Company Name</label>
            <input
              id="companyName"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="ABC Construction"
              autoComplete="organization"
              autoFocus
            />
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
              Your company name is also your account profile name.
            </p>
          </div>

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label>Choose Your Plan</label>
            <div style={{ display: "flex", gap: 8 }}>
              {([
                { value: "monthly", label: "Monthly", price: "$149/mo" },
                { value: "annual", label: "Annual", price: "$1,200/yr" },
              ] as const).map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPlan(p.value)}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: `1.5px solid ${plan === p.value ? "var(--accent, #2563eb)" : "var(--border, #d1d5db)"}`,
                    background: plan === p.value ? "var(--accent-soft, #eff6ff)" : "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  <div style={{ fontWeight: 700, color: plan === p.value ? "var(--accent, #2563eb)" : "var(--text)" }}>
                    {p.label}
                  </div>
                  <div style={{ color: "var(--text-muted)" }}>{p.price}</div>
                </button>
              ))}
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
              {plan === "annual"
                ? "Annual: $1,200/year — billed once a year after your 30-day free trial, save $588 vs. monthly."
                : "Monthly: $149/month — billed monthly after your 30-day free trial, cancel anytime."}
            </p>
          </div>

          <button type="submit" className="auth-btn" disabled={submitting}>
            {submitting ? "Creating Account..." : "Create Account"}
          </button>

          <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", marginTop: -8 }}>
            Start your 30-day free trial — your card is entered at checkout but you won't
            be charged until your trial ends.
          </p>
        </form>

        <p className="auth-footer">
          Already have an account?{" "}
          <Link to="/app/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
