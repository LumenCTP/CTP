import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

const PARTNER_TYPES = [
  "Insurance Agent",
  "Insurance Agency",
  "CPA",
  "Bookkeeper",
  "Fractional CFO",
  "Construction Consultant",
  "Other",
];

const TAX_INFO_OPTIONS = [
  { value: "not_submitted", label: "Not submitted yet" },
  { value: "submitted", label: "Submitted (W-9 on file)" },
  { value: "exempt", label: "Tax exempt" },
];

const PAYOUT_METHODS = [
  { value: "ach", label: "ACH / Bank Transfer" },
  { value: "check", label: "Check" },
  { value: "paypal", label: "PayPal" },
  { value: "other", label: "Other" },
];

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
    tax_info_status: "not_submitted",
    preferred_payout_method: "ach",
  });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

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

    setSubmitting(true);
    try {
      const res = await apiFetch("/api/partners/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Application failed. Please try again.");
      } else {
        setSubmitted(true);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-header">
            <div className="auth-logo">CTP</div>
            <h2>Application Submitted!</h2>
            <p className="auth-subtitle">You'll receive an email when approved.</p>
          </div>
          <div className="auth-success">
            Your partner application is under review. Once approved you'll be
            able to sign in to your partner dashboard.
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
          <div className="auth-logo">CTP</div>
          <h2>Become a Partner</h2>
          <p className="auth-subtitle">
            Earn commissions for every construction company you refer to
            ClearToPay Construction
          </p>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
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

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="tax_info_status">Tax Info Status</label>
              <select
                id="tax_info_status"
                className="form-input"
                value={form.tax_info_status}
                onChange={(e) => update("tax_info_status", e.target.value)}
              >
                {TAX_INFO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="preferred_payout_method">Preferred Payout Method</label>
              <select
                id="preferred_payout_method"
                className="form-input"
                value={form.preferred_payout_method}
                onChange={(e) => update("preferred_payout_method", e.target.value)}
              >
                {PAYOUT_METHODS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
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
