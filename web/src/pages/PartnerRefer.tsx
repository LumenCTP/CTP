import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../lib/api";

export default function PartnerRefer() {
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [form, setForm] = useState({
    company_name: "",
    contact_name: "",
    email: "",
    phone: "",
    notes: "",
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load the partner's referral code so the share link can be shown.
  useEffect(() => {
    apiFetch("/api/partner/me")
      .then((res) => (res.ok ? res.json() : { partner: null }))
      .then((data) => setReferralCode(data?.partner?.referral_code ?? null))
      .catch(() => setReferralCode(null));
  }, []);

  function update(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (!form.company_name.trim() && !form.contact_name.trim() && !form.email.trim()) {
      setError("Provide at least a company name, contact name, or email.");
      return;
    }
    if (form.email.trim() && !form.email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch("/api/partner/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to submit referral. Please try again.");
      } else {
        setSuccess(true);
        setForm({ company_name: "", contact_name: "", email: "", phone: "", notes: "" });
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    const link = `https://cleartopay.ctonew.app/get-started?ref=${referralCode}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  const shareLink = referralCode ? `cleartopay.ctonew.app/get-started?ref=${referralCode}` : null;

  return (
    <div className="dashboard">
      <h2 className="page-title">Refer a Client</h2>
      <p className="page-subtitle">
        Tell us about a construction company that should be using ClearToPay
        Compliance — we'll take it from there.
      </p>

      {shareLink && (
        <section className="referral-share-card">
          <span className="referral-share-label">Or share your link:</span>
          <code className="referral-share-link">{shareLink}</code>
          <button type="button" className="btn btn-outline btn-sm" onClick={copyLink}>
            {copied ? "Copied!" : "Copy Link"}
          </button>
        </section>
      )}

      {error && <div className="error-message" style={{ marginBottom: 16 }}>{error}</div>}
      {success && (
        <div className="success-message" style={{ marginBottom: 16 }}>
          Referral submitted! We'll notify you when they sign up.
        </div>
      )}

      <div className="table-wrapper" style={{ padding: "20px 24px" }}>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="company_name">Company Name</label>
            <input
              id="company_name"
              className="form-input"
              type="text"
              value={form.company_name}
              onChange={(e) => update("company_name", e.target.value)}
              placeholder="ABC Construction Co."
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="contact_name">Contact Name</label>
            <input
              id="contact_name"
              className="form-input"
              type="text"
              value={form.contact_name}
              onChange={(e) => update("contact_name", e.target.value)}
              placeholder="John Smith"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                className="form-input"
                type="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                placeholder="john@abcconstruction.com"
              />
            </div>
            <div className="form-group">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                className="form-input"
                type="tel"
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="(555) 123-4567"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="notes">Notes (optional)</label>
            <textarea
              id="notes"
              className="form-input"
              rows={3}
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
              placeholder="Anything we should know about this company?"
            />
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Submitting..." : "Submit Referral"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
