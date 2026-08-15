import { apiFetch } from "../lib/api";
import { useEffect, useState, type FormEvent, type CSSProperties } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../components/AuthContext";
import { openHelp } from "../components/HelpWidget";
import Logo from "../components/Logo";
import { DEFAULT_REQUIRED_DOCUMENTS, defaultCoverageFor, type RequiredDocument } from "@clear-to-pay/shared";

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
  compliance_client_id?: number | null;
}

const STEP_LABELS = ["Company Info", "Payment Week", "Compliance Requirements", "Confirmation"];

// Persisted current_step values → wizard step number (for exact-step resume).
const STEP_MAP: Record<string, number> = {
  company_info: 1,
  payment_week: 2,
  compliance: 3,
  confirmation: 4,
  completed: 4,
};

const STANDARD_DOC_TYPES = DEFAULT_REQUIRED_DOCUMENTS.map((d) => d.document_type);

export default function SetupWizard() {
  const { user, loading, token, refreshUser } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [companyName, setCompanyName] = useState(user?.company_name || "");
  const [companyAddress, setCompanyAddress] = useState("");
  const [paymentWeekDay, setPaymentWeekDay] = useState("monday");
  // Selected required documents (standard + custom), each with a coverage amount.
  const [reqDocs, setReqDocs] = useState<RequiredDocument[]>(
    DEFAULT_REQUIRED_DOCUMENTS.map((d) => ({ ...d }))
  );
  const [complianceClientId, setComplianceClientId] = useState<number | null>(null);
  // Custom requirement draft row
  const [customType, setCustomType] = useState("");
  const [customCoverage, setCustomCoverage] = useState("");
  const [loadingWizard, setLoadingWizard] = useState(true);
  const [savingDocs, setSavingDocs] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

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
          if (w.compliance_client_id) setComplianceClientId(w.compliance_client_id);
          // Resume at the exact persisted step (granular), with safety clamps
          // for legacy rows whose saved step is ahead of their actual data.
          if (w.status === "IN_PROGRESS") {
            let resumeStep = (w.current_step && STEP_MAP[w.current_step]) || 1;
            if (!(w.company_name && w.company_address)) resumeStep = Math.min(resumeStep, 1);
            else if (resumeStep >= 3 && !w.compliance_client_id) resumeStep = 3;
            setStep(resumeStep);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        setLoadingWizard(false);
        // Refresh the cached user from /api/auth/me so inbox_address (and any
        // profile-name sync) is current for the confirmation step and TopBar.
        void refreshUser();
      });
  }, [token]);

  // When resuming with a saved compliance client, load its configured requirements
  useEffect(() => {
    if (!token || !complianceClientId) return;
    apiFetch(`/api/clients/${complianceClientId}/documents-required`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((rows) => {
        if (Array.isArray(rows)) {
          setReqDocs(rows.map((r) => ({ document_type: r.document_type, coverage_requirement: r.coverage_requirement ?? null })));
        }
      })
      .catch(() => {});
  }, [token, complianceClientId]);

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
    return <Navigate to="/app/login" replace />;
  }

  if (user.wizard_status === "COMPLETED") {
    return <Navigate to="/app" replace />;
  }

  // ── Step 3 helpers ────────────────────────────────────
  function hasDoc(docType: string): boolean {
    return reqDocs.some((r) => r.document_type === docType);
  }
  function coverageFor(docType: string): string {
    return reqDocs.find((r) => r.document_type === docType)?.coverage_requirement ?? "";
  }
  function toggleDoc(docType: string) {
    setReqDocs((prev) =>
      hasDoc(docType)
        ? prev.filter((r) => r.document_type !== docType)
        : [...prev, { document_type: docType, coverage_requirement: defaultCoverageFor(docType) }]
    );
  }
  function setCoverage(docType: string, value: string) {
    setReqDocs((prev) => {
      const existing = prev.find((r) => r.document_type === docType);
      if (existing) {
        return prev.map((r) => (r.document_type === docType ? { ...r, coverage_requirement: value.trim() || null } : r));
      }
      return [...prev, { document_type: docType, coverage_requirement: value.trim() || null }];
    });
  }
  function addCustomRequirement() {
    const type = customType.trim();
    if (!type) return;
    if (hasDoc(type)) {
      setError("That requirement is already in your list.");
      return;
    }
    setReqDocs((prev) => [...prev, { document_type: type, coverage_requirement: customCoverage.trim() || null }]);
    setCustomType("");
    setCustomCoverage("");
    setError("");
  }
  function removeRequirement(docType: string) {
    setReqDocs((prev) => prev.filter((r) => r.document_type !== docType));
  }

  // Ensure the tenant has a client row to attach required docs to (the tenant's
  // own company), then save the requirement list to it.
  async function ensureComplianceClient(): Promise<number | null> {
    if (complianceClientId) return complianceClientId;
    try {
      const listRes = await apiFetch("/api/clients", { headers: { Authorization: `Bearer ${token}` } });
      const clients = listRes.ok ? await listRes.json() : [];
      const match = Array.isArray(clients) ? clients.find((c) => c.name === companyName.trim()) : undefined;
      if (match) {
        setComplianceClientId(match.id);
        return match.id;
      }
    } catch { /* fall through to create */ }
    const res = await apiFetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: companyName.trim(), address: companyAddress.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(res.status >= 500 ? "Something went wrong. Please try again." : (data.error || "Failed to create client record"));
    setComplianceClientId(data.id);
    return data.id as number;
  }

  async function saveComplianceStep() {
    setSavingDocs(true);
    setError("");
    try {
      const clientId = await ensureComplianceClient();
      if (!clientId) throw new Error("Could not resolve a client record for your company.");
      const docsRes = await apiFetch(`/api/clients/${clientId}/documents-required`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ document_types: reqDocs }),
      });
      if (!docsRes.ok) {
        const d = await docsRes.json();
        throw new Error(docsRes.status >= 500 ? "Something went wrong. Please try again." : (d.error || "Failed to save compliance requirements"));
      }
      const setupRes = await apiFetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          company_name: companyName.trim(),
          company_address: companyAddress.trim(),
          payment_week_start_day: paymentWeekDay,
          compliance_client_id: clientId,
          current_step: "confirmation",
        }),
      });
      if (!setupRes.ok) {
        const d = await setupRes.json();
        throw new Error(setupRes.status >= 500 ? "Something went wrong. Please try again." : (d.error || "Failed to save setup progress"));
      }
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save compliance requirements. Please try again.");
    } finally {
      setSavingDocs(false);
    }
  }

  // Persist wizard progress to the API so a reload resumes at the exact step.
  async function saveProgress(patch: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await apiFetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(res.status >= 500 ? "Something went wrong. Please try again." : (d.error || "Failed to save your progress. Please try again."));
        return false;
      }
      return true;
    } catch {
      setError("Failed to save your progress. Please try again.");
      return false;
    }
  }

  async function nextStep(e: FormEvent) {
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
      setSubmitting(true);
      const ok = await saveProgress({
        company_name: companyName.trim(),
        company_address: companyAddress.trim(),
        current_step: "payment_week",
      });
      setSubmitting(false);
      if (ok) setStep(2);
    } else if (step === 2) {
      setSubmitting(true);
      const ok = await saveProgress({
        payment_week_start_day: paymentWeekDay,
        current_step: "compliance",
      });
      setSubmitting(false);
      if (ok) setStep(3);
    }
  }

  // Back navigation is persisted too (M5): a reload after clicking Back must
  // resume at the step the user actually reached, not the last forward step.
  async function goBack(stepKey: string, target: number) {
    setError("");
    setSubmitting(true);
    const ok = await saveProgress({ current_step: stepKey });
    setSubmitting(false);
    if (ok) setStep(target);
  }

  async function completeSetup() {
    setSubmitting(true);
    setError("");
    if (!acknowledged) {
      setError("Please confirm that you have set your compliance criteria before completing setup.");
      setSubmitting(false);
      return;
    }
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
          compliance_client_id: complianceClientId,
          current_step: "completed",
          confirmed: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(res.status >= 500 ? "Something went wrong. Please try again." : (data.error || "Failed to save setup. Please try again."));
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

  const inputStyle: CSSProperties = {
    width: "100%", padding: "8px 10px", borderRadius: 8,
    border: "1px solid var(--border, #d1d5db)", fontSize: 13,
  };

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 620, width: "100%" }}>
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
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
            <button type="submit" className="auth-btn" disabled={submitting}>
              {submitting ? "Saving..." : "Continue"}
            </button>
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
              <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={() => goBack("company_info", 1)} disabled={submitting}>
                Back
              </button>
              <button type="submit" className="auth-btn" style={{ flex: 2 }} disabled={submitting}>
                {submitting ? "Saving..." : "Continue"}
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <div>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 12px" }}>
              These are the compliance documents vendors must provide — and the coverage
              amounts each policy must meet. Adjust the list and amounts to match your
              requirements.
            </p>
            {/* Standard requirement rows */}
            {DEFAULT_REQUIRED_DOCUMENTS.map((std) => {
              const checked = hasDoc(std.document_type);
              return (
                <div key={std.document_type} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 190, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDoc(std.document_type)}
                    />
                    <span>{std.document_type}</span>
                  </label>
                  <input
                    type="text"
                    style={{ ...inputStyle, flex: 1, opacity: checked ? 1 : 0.5 }}
                    placeholder={checked ? "Coverage amount (optional)" : "Select to add"}
                    value={coverageFor(std.document_type)}
                    disabled={!checked}
                    onChange={(e) => setCoverage(std.document_type, e.target.value)}
                  />
                </div>
              );
            })}
            {/* Custom requirement rows */}
            {reqDocs
              .filter((r) => !STANDARD_DOC_TYPES.includes(r.document_type))
              .map((r) => (
                <div key={r.document_type} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{ minWidth: 190, fontSize: 14, fontWeight: 600 }}>{r.document_type}</span>
                  <input
                    type="text"
                    style={{ ...inputStyle, flex: 1 }}
                    placeholder="Coverage amount (optional)"
                    value={r.coverage_requirement ?? ""}
                    onChange={(e) => setCoverage(r.document_type, e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={() => removeRequirement(r.document_type)}
                    title={`Remove ${r.document_type}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            {/* Add custom requirement */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, paddingTop: 12, borderTop: "1px dashed var(--border, #e2e8f0)", flexWrap: "wrap" }}>
              <input
                type="text"
                style={{ ...inputStyle, flex: 1, minWidth: "min(150px, 100%)" }}
                placeholder="Custom requirement (e.g. Builder's Risk)"
                value={customType}
                onChange={(e) => setCustomType(e.target.value)}
              />
              <input
                type="text"
                style={{ ...inputStyle, flex: 1, minWidth: "min(150px, 100%)" }}
                placeholder="Coverage amount (optional)"
                value={customCoverage}
                onChange={(e) => setCustomCoverage(e.target.value)}
              />
              <button type="button" className="btn btn-sm btn-outline" onClick={addCustomRequirement}>
                + Add
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 0 0" }}>
              Changes are saved when you click “Save &amp; Continue” — you can return to this step anytime.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={() => goBack("payment_week", 2)} disabled={savingDocs || submitting}>
                Back
              </button>
              <button type="button" className="auth-btn" style={{ flex: 2 }} onClick={saveComplianceStep} disabled={savingDocs}>
                {savingDocs ? "Saving..." : "Save & Continue"}
              </button>
            </div>
          </div>
        )}

        <button type="button" onClick={() => openHelp(`I need help with the ${STEP_LABELS[step - 1]} step`, "onboarding")} style={{ display: "block", margin: "20px auto 0", border: 0, background: "none", color: "var(--accent, #2563eb)", cursor: "pointer", fontSize: 13 }}>
          Stuck? Our Onboarding Officer can walk you through this.
        </button>

        {step === 4 && (
          <div>
            <div style={{ background: "var(--surface-2, #f8fafc)", borderRadius: 10, padding: 16, marginBottom: 20, border: "1px solid var(--border, #e2e8f0)" }}>
              <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Review your details</p>
              <p style={{ margin: "0 0 4px", fontSize: 14 }}>
                <strong>Company:</strong> {companyName.trim() || "—"}
              </p>
              <p style={{ margin: "0 0 4px", fontSize: 14 }}>
                <strong>Address:</strong> {companyAddress.trim() || "—"}
              </p>
              <p style={{ margin: "0 0 4px", fontSize: 14 }}>
                <strong>Payment week starts:</strong>{" "}
                {DAYS.find((d) => d.value === paymentWeekDay)?.label || paymentWeekDay}
              </p>
              <p style={{ margin: "6px 0 0", fontSize: 14 }}>
                <strong>Required compliance documents:</strong>
              </p>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
                {reqDocs.length === 0 && <li style={{ color: "var(--text-muted)" }}>No requirements configured</li>}
                {reqDocs.map((r) => (
                  <li key={r.document_type}>
                    {r.document_type}
                    {r.coverage_requirement ? ` — ${r.coverage_requirement}` : ""}
                  </li>
                ))}
              </ul>
            </div>
            {user?.inbox_address && (
              <div style={{ background: "var(--surface-2, #f8fafc)", borderRadius: 10, padding: 16, marginBottom: 20, border: "1px dashed var(--accent, #2563eb)" }}>
                <p style={{ margin: "0 0 8px", fontWeight: 700 }}>📥 Vendor Document Submission</p>
                <p style={{ margin: "0 0 6px", fontSize: 14, color: "var(--text-muted, #6b7280)" }}>
                  Have vendors email COIs and W-9s to:
                </p>
                <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 600, wordBreak: "break-all" }}>
                  {user.inbox_address}
                </p>
                <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted, #6b7280)" }}>
                  Documents will be automatically processed and matched.
                </p>
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted, #6b7280)" }}>
                  ClearToPay stores and tracks your documents; your customer (the contractor)
                  sets the compliance requirements. Contact them with questions about coverage.
                </p>
              </div>
            )}
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                margin: "0 0 16px",
                fontSize: 13,
                color: "var(--text-muted, #6b7280)",
                cursor: "pointer",
                lineHeight: 1.45,
              }}
            >
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                I confirm that I selected my company's document and coverage
                criteria. I understand that ClearToPay only flags records against
                those criteria and does not set or verify coverage adequacy.
                AI-extracted information may contain errors, so I will review
                source documents and consult my insurance agent or broker as
                appropriate before relying on a status or making a payment
                decision.
              </span>
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={() => goBack("compliance", 3)} disabled={submitting}>
                Back
              </button>
              <button type="button" className="auth-btn" style={{ flex: 2 }} onClick={completeSetup} disabled={submitting || !acknowledged}>
                {submitting ? "Saving..." : "Confirm & Get Started"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
