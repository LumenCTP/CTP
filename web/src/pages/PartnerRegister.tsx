import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import Logo from "../components/Logo";

const PARTNER_TYPES = [
  "Insurance Agent",
  "Insurance Agency",
  "CPA",
  "Bookkeeper",
  "Fractional CFO",
  "Construction Consultant",
  "Other",
];

const HEAR_ABOUT_OPTIONS = ["Flyer", "Social Media", "Other Agency"];

// Payouts are ACH-only — no check / PayPal / other options.
const PAYOUT_METHODS = [{ value: "ach", label: "ACH / Bank Transfer" }];

export default function PartnerRegister() {
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    company_name: "",
    email: "",
    phone: "",
    address: "",
    website: "",
    states_served: "",
    partner_type: "",
    hear_about_us: "",
    preferred_payout_method: "ach",
  });
  const [w9File, setW9File] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [approved, setApproved] = useState<{ referral_code?: string | null; w9_uploaded?: boolean; w9_error?: string | null } | null>(null);

  function update(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError("First and last name are required.");
      return;
    }
    if (!form.email.trim() || !form.email.includes("@")) {
      setError("A valid email is required.");
      return;
    }
    if (!form.partner_type) {
      setError("Please select a partner type.");
      return;
    }
    if (w9File && w9File.size > 10 * 1024 * 1024) {
      setError("W-9 file is too large — the limit is 10MB.");
      return;
    }

    setSubmitting(true);
    try {
      // Multipart apply: text fields + the optional W-9 file in one request.
      // The server creates the partner (status='approved'), sends the
      // set-password email, and — if the W-9 is included and valid — generates
      // the referral code immediately. No auth token exists at apply time, so
      // the file must travel with the application itself.
      const formData = new FormData();
      Object.entries(form).forEach(([key, value]) => formData.append(key, value));
      if (w9File) formData.append("w9", w9File);

      const res = await apiFetch("/api/partners/apply", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Application failed. Please try again.");
      } else {
        setApproved(data.partner || null);
        setSubmitted(true);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    const code = approved?.referral_code;
    const w9Ok = approved?.w9_uploaded;
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-header">
            <div className="auth-logo-slot"><Logo size={48} /></div>
            <h2>You're approved!</h2>
            <p className="auth-subtitle">
              Welcome to the ClearToPay partner program.
            </p>
          </div>
          <div className="auth-success">
            {code ? (
              <p style={{ margin: "0 0 12px" }}>
                Your referral code is <strong>{code}</strong> — you're ready to
                refer clients.
              </p>
            ) : (
              <p style={{ margin: "0 0 12px" }}>
                <strong>One more step:</strong> upload your W-9 to unlock
                referring. Sign in and the dashboard will walk you through it.
              </p>
            )}
            {approved?.w9_error ? (
              <p style={{ margin: "0 0 12px", color: "#b45309" }}>
                Note: your application was accepted, but the W-9 file wasn't
                saved ({approved.w9_error}). You can upload it after signing in.
              </p>
            ) : null}
            {!code && w9Ok && <p style={{ margin: "0 0 12px" }}>Your W-9 was received.</p>}
            <p style={{ margin: "4px 0 0", fontWeight: 700 }}>
              Check your email to set up your account.
            </p>
            <p style={{ margin: "4px 0 0" }}>
              We sent you a secure link to create your username and password.
              Then sign in to your partner portal to get started.
            </p>
          </div>
          <p style={{ textAlign: "center", marginTop: 16 }}>
            <Link className="btn btn-primary" to="/app/partner/login">
              Go to Partner Login
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
          <h2>Partner Program</h2>
          <p className="auth-subtitle">
            Earn commissions for every construction company you refer to
            ClearToPay Construction
          </p>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form" encType="multipart/form-data">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="first_name">First Name *</label>
              <input
                id="first_name"
                type="text"
                value={form.first_name}
                onChange={(e) => update("first_name", e.target.value)}
                placeholder="Jane"
                autoComplete="given-name"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="last_name">Last Name *</label>
              <input
                id="last_name"
                type="text"
                value={form.last_name}
                onChange={(e) => update("last_name", e.target.value)}
                placeholder="Smith"
                autoComplete="family-name"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="company_name">Company Name</label>
            <input
              id="company_name"
              type="text"
              value={form.company_name}
              onChange={(e) => update("company_name", e.target.value)}
              placeholder="Smith Insurance Agency"
              autoComplete="organization"
            />
          </div>

          <div className="form-group">
            <label htmlFor="email">Email *</label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              placeholder="jane@smithagency.com"
              autoComplete="email"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                type="tel"
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="(555) 123-4567"
                autoComplete="tel"
              />
            </div>
            <div className="form-group">
              <label htmlFor="website">Website</label>
              <input
                id="website"
                type="url"
                value={form.website}
                onChange={(e) => update("website", e.target.value)}
                placeholder="https://smithagency.com"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="address">Address</label>
            <input
              id="address"
              type="text"
              value={form.address}
              onChange={(e) => update("address", e.target.value)}
              placeholder="123 Main St, Springfield, IL"
            />
          </div>

          <div className="form-group">
            <label htmlFor="states_served">States Served</label>
            <input
              id="states_served"
              type="text"
              value={form.states_served}
              onChange={(e) => update("states_served", e.target.value)}
              placeholder="IL, IN, WI"
            />
          </div>

          <div className="form-group">
            <label htmlFor="partner_type">Partner Type *</label>
            <select
              id="partner_type"
              className="form-input"
              value={form.partner_type}
              onChange={(e) => update("partner_type", e.target.value)}
            >
              <option value="">Select partner type…</option>
              {PARTNER_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="hear_about_us">How did you hear about us?</label>
            <select
              id="hear_about_us"
              className="form-input"
              value={form.hear_about_us}
              onChange={(e) => update("hear_about_us", e.target.value)}
            >
              <option value="">Select…</option>
              {HEAR_ABOUT_OPTIONS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="w9">W-9 (Required before referring)</label>
            <input
              id="w9"
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              onChange={(e) => setW9File(e.target.files?.[0] ?? null)}
            />
            <p className="form-hint" style={{ marginTop: 6, fontSize: 13, color: "#6b7280" }}>
              Upload now to start referring immediately, or upload it from your
              dashboard after you sign in. PDF, JPG, or PNG (max 10MB). Your W-9
              is stored securely and only visible to ClearToPay staff.
            </p>
            {w9File && (
              <p style={{ marginTop: 6, fontSize: 13, color: "#059669" }}>
                ✓ {w9File.name} ({(w9File.size / 1024).toFixed(1)} KB)
              </p>
            )}
          </div>

          <div className="form-group">
            <label>Preferred Payout Method</label>
            <p className="form-hint" style={{ margin: 0, fontSize: 14, color: "#374151", padding: "10px 0 2px" }}>
              Payouts are paid by <strong>ACH / bank transfer</strong> to your
              connected Stripe account.
            </p>
            <input type="hidden" name="preferred_payout_method" value={form.preferred_payout_method} />
          </div>

          <button type="submit" className="auth-btn" disabled={submitting}>
            {submitting ? "Submitting Application..." : "Submit Application"}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account?{" "}
          <Link to="/app/partner/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}