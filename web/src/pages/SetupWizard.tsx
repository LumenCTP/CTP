import { apiFetch } from "../lib/api";
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../components/AuthContext";
import { openHelp } from "../components/HelpWidget";

const DAYS = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

interface WizardData {
  status?: string | null;
  current_step?: string | null;
  company_name?: string | null;
  company_address?: string | null;
  payment_week_start_day?: string | null;
}

const STEP_LABELS = ["Company Info", "Payment Week", "Confirmation"];

export default function SetupWizard() {
  const { user, loading, token, refreshUser } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [companyName, setCompanyName] = useState(user?.company_name || "");
  const [companyAddress, setCompanyAddress] = useState("");
  const [paymentWeekDay, setPaymentWeekDay] = useState("monday");
  const [loadingWizard, setLoadingWizard] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Load existing wizard state (so returning users can resume)
  useEffect(() => {
    if (!token) return;
    apiFetch("/api/setup", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.wizard) {
          const w = data.wizard as WizardData;
          if (w.company_name) setCompanyName(w.company_name);
          if (w.company_address) setCompanyAddress(w.company_address);
          if (w.payment_week_start_day) setPaymentWeekDay(w.payment_week_start_day);
          // Resume at the furthest completed step
          if (w.status === "IN_PROGRESS") {
            if (w.company_name || w.company_address) setStep(2);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingWizard(false));
  }, [token]);

  if (loading || loadingWizard) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p style={{ textAlign: "center", color: "var(--text-muted)" }}>Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.wizard_status === "COMPLETED") {
    return <Navigate to="/app" replace />;
  }

  function nextStep(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (step === 1) {
      if (!companyName.trim()) {
        setError("Company name is required.");
        return;
      }
      if (!companyAddress.trim()) {
        setError("Company address is required.");
        return;
      }
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    }
  }

  async function completeSetup() {
    setSubmitting(true);
    setError("");
    try {
      const res = await apiFetch("/api/setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          company_name: companyName.trim(),
          company_address: companyAddress.trim(),
          payment_week_start_day: paymentWeekDay,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to save setup. Please try again.");
        setSubmitting(false);
        return;
      }
      // Refresh user context so wizard_status flips to COMPLETED
      await refreshUser();
      navigate("/app", { replace: true });
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 560, width: "100%" }}>
        <div className="auth-header">
          <div className="auth-logo">CTP</div>
          <h2>Set Up Your Workspace</h2>
          <p className="auth-subtitle">
            A few details to configure your Clear-to-Pay monitoring
          </p>
        </div>

        {/* Progress indicator */}
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const active = n === step;
            const done = n < step;
            return (
              <div key={label} style={{ flex: 1, textAlign: "center" }}>
                <div
                  style={{
                    width: 28, height: 28, margin: "0 auto 6px", borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700,
                    background: done ? "var(--accent, #2563eb)" : active ? "var(--accent, #2563eb)" : "var(--border, #e2e8f0)",
                    color: done || active ? "#fff" : "var(--text-muted)",
                  }}
                >
                  {done ? "✓" : n}
                </div>
                <div style={{ fontSize: 12, color: active ? "var(--text)" : "var(--text-muted)" }}>
                  {label}
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="auth-error">{error}</div>}

        {step === 1 && (
          <form onSubmit={nextStep} className="auth-form">
            <div className="form-group">
              <label htmlFor="companyName">Company Name</label>
              <input
                id="companyName"
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="ABC Construction Inc."
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="companyAddress">Company Address</label>
              <input
                id="companyAddress"
                type="text"
                value={companyAddress}
                onChange={(e) => setCompanyAddress(e.target.value)}
                placeholder="1200 Builder Ave, Portland, OR 97201"
              />
            </div>
            <button type="submit" className="auth-btn">Continue</button>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={nextStep} className="auth-form">
            <div className="form-group">
              <label htmlFor="paymentWeekDay">Payment Week Starts On</label>
              <select
                id="paymentWeekDay"
                className="form-select"
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border, #d1d5db)", fontSize: 14 }}
                value={paymentWeekDay}
                onChange={(e) => setPaymentWeekDay(e.target.value)}
              >
                {DAYS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>
                Your Clear-to-Pay report covers each payment week. Choose the day your
                payment week starts — vendors must have valid documents through the
                end of the week (Sunday) to be approved for payment.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={() => setStep(1)}>
                Back
              </button>
              <button type="submit" className="auth-btn" style={{ flex: 2 }}>Continue</button>
            </div>
          </form>
        )}

        <button type="button" onClick={() => openHelp(`I need help with the ${STEP_LABELS[step - 1]} step`, "onboarding")} style={{ display: "block", margin: "20px auto 0", border: 0, background: "none", color: "var(--accent, #2563eb)", cursor: "pointer", fontSize: 13 }}>
          Stuck? Our Onboarding Officer can walk you through this.
        </button>

        {step === 3 && (
          <div>
            <div style={{ background: "var(--surface-2, #f8fafc)", borderRadius: 10, padding: 16, marginBottom: 20, border: "1px solid var(--border, #e2e8f0)" }}>
              <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Review your details</p>
              <p style={{ margin: "0 0 4px", fontSize: 14 }}>
                <strong>Company:</strong> {companyName.trim() || "—"}
              </p>
              <p style={{ margin: "0 0 4px", fontSize: 14 }}>
                <strong>Address:</strong> {companyAddress.trim() || "—"}
              </p>
              <p style={{ margin: 0, fontSize: 14 }}>
                <strong>Payment week starts:</strong>{" "}
                {DAYS.find((d) => d.value === paymentWeekDay)?.label || paymentWeekDay}
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={() => setStep(2)} disabled={submitting}>
                Back
              </button>
              <button type="button" className="auth-btn" style={{ flex: 2 }} onClick={completeSetup} disabled={submitting}>
                {submitting ? "Saving..." : "Confirm & Get Started"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
