import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../components/AuthContext";

interface BillingStatus {
  plan: string | null;
  status: string;
  period_start: string | null;
  period_end: string | null;
  trial_end: string | null;
  next_billing_date: string | null;
  cancel_at_period_end: boolean;
  stripe_customer_present: boolean;
  stripe_subscription_present: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  TRIAL: "Free Trial",
  PENDING: "Pending",
  PAST_DUE: "Past Due",
  CANCELLED: "Cancelled",
  INCOMPLETE: "Incomplete",
};

function statusColor(status: string): string {
  switch (status) {
    case "ACTIVE": return "#059669";
    case "TRIAL": return "#2563eb";
    case "PAST_DUE": return "#d97706";
    case "CANCELLED": return "#dc2626";
    default: return "#6b7280";
  }
}

function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d + (d.length === 10 ? "T00:00:00" : "Z"));
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export default function Billing() {
  const { user, refreshUser } = useAuth();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"portal" | "cancel" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch("/api/billing/status");
      if (!res.ok) throw new Error("Failed to load billing status");
      const data: BillingStatus = await res.json();
      setBilling(data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Fall back to /me data when the status endpoint is unreachable.
  const status = billing?.status ?? user?.subscription_status ?? "PENDING";
  const plan = billing?.plan ?? user?.subscription_plan ?? null;
  const trialEnd = billing?.trial_end ?? user?.subscription_trial_end ?? null;
  const nextBilling = billing?.next_billing_date ?? null;
  const cancelAtPeriodEnd = billing?.cancel_at_period_end ?? user?.cancel_at_period_end ?? false;
  const isTrial = status === "TRIAL";
  const isActive = status === "ACTIVE" || isTrial;

  const openPortal = async () => {
    setBusy("portal");
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch("/api/billing/portal", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.message || json.error || "Could not open the billing portal.");
        setBusy(null);
        return;
      }
      if (json.url) {
        window.location.href = json.url;
        return; // navigating away — busy state stays until reload
      }
      setError("The billing portal did not return a URL.");
      setBusy(null);
    } catch {
      setError("Unable to reach the billing portal. Please try again.");
      setBusy(null);
    }
  };

  const cancelSubscription = async () => {
    const endDate = isTrial && trialEnd ? formatDate(trialEnd) : formatDate(nextBilling || billing?.period_end);
    const ok = window.confirm(
      `Cancel your ClearToPay subscription?\n\nYour account stays active until ${endDate}, then your subscription ends. You can also manage your plan in the Stripe billing portal.`
    );
    if (!ok) return;
    setBusy("cancel");
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch("/api/billing/cancel", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.message || json.error || "Could not cancel the subscription.");
        setBusy(null);
        return;
      }
      setMessage(json.cancels_on
        ? `Your subscription will end on ${formatDate(json.cancels_on)}. You won't be charged again.`
        : "Your subscription is set to cancel at the end of the current period.");
      setBusy(null);
      refreshUser();
      fetchStatus();
    } catch {
      setError("Unable to reach the billing server. Please try again.");
      setBusy(null);
    }
  };

  const planLabel = plan === "annual" ? "Annual" : plan === "monthly" ? "Month-to-Month" : "—";

  return (
    <div className="page-container">
      <div className="page-header">
        <h2 className="page-title">Subscription &amp; Billing</h2>
      </div>
      <p className="page-subtitle">
        Manage your ClearToPay plan, payment method, and subscription. Your card is
        kept on file securely with Stripe and is only charged at the start of each
        billing period (or when your free trial ends).
      </p>

      {loading ? (
        <div className="loading">Loading billing information…</div>
      ) : (
        <div style={{ maxWidth: 640 }}>
          <div
            style={{
              border: "1px solid var(--border, #d1d5db)",
              borderRadius: 12,
              padding: "20px 24px",
              background: "#fff",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{planLabel || "No plan selected"}</span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "4px 12px",
                  borderRadius: 999,
                  color: "#fff",
                  background: statusColor(status),
                }}
              >
                {STATUS_LABEL[status] ?? status}
              </span>
            </div>

            <div style={{ marginTop: 16, display: "grid", gap: 10, fontSize: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                <span style={{ color: "var(--text-muted)" }}>Plan</span>
                <span style={{ fontWeight: 600 }}>
                  {plan === "annual" ? "$1,200/year ($100/mo)" : plan === "monthly" ? "$149/month" : "—"}
                </span>
              </div>
              {isTrial && trialEnd && (
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                  <span style={{ color: "var(--text-muted)" }}>Free trial ends</span>
                  <span style={{ fontWeight: 600 }}>{formatDate(trialEnd)}</span>
                </div>
              )}
              {!isTrial && nextBilling && (
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                  <span style={{ color: "var(--text-muted)" }}>{cancelAtPeriodEnd ? "Subscription ends" : "Next billing date"}</span>
                  <span style={{ fontWeight: 600 }}>{formatDate(nextBilling)}</span>
                </div>
              )}
              {cancelAtPeriodEnd && (
                <div
                  style={{
                    marginTop: 4,
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "#fef3c7",
                    color: "#92400e",
                    fontSize: 13,
                  }}
                >
                  Your subscription is set to cancel at the end of the current period. You
                  won't be charged again.
                </div>
              )}
              {isTrial && (
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
                  You're on your 30-day free trial — you haven't been charged. Your card is
                  entered at checkout but you won't be charged until your trial ends.
                </p>
              )}
            </div>

            <div style={{ marginTop: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: "10px 16px", borderRadius: 8, fontWeight: 700 }}
                onClick={openPortal}
                disabled={busy !== null || !billing?.stripe_customer_present}
                title={billing?.stripe_customer_present ? undefined : "Complete checkout first to manage billing"}
              >
                {busy === "portal" ? "Opening…" : "Manage subscription"}
              </button>
              <button
                type="button"
                className="btn"
                style={{ padding: "10px 16px", borderRadius: 8, fontWeight: 700, color: "#dc2626", borderColor: "#fca5a5" }}
                onClick={cancelSubscription}
                disabled={busy !== null || cancelAtPeriodEnd || !billing?.stripe_subscription_present}
              >
                {busy === "cancel" ? "Cancelling…" : cancelAtPeriodEnd ? "Cancellation scheduled" : "Cancel subscription"}
              </button>
            </div>

            {!billing?.stripe_customer_present && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 12 }}>
                No payment method is on file yet. Complete checkout to add your card — it
                won't be charged until your 30-day trial ends.
              </p>
            )}
            {message && (
              <p style={{ marginTop: 12, fontSize: 13, color: "#059669", fontWeight: 600 }}>{message}</p>
            )}
            {error && (
              <p style={{ marginTop: 12, fontSize: 13, color: "#dc2626" }}>{error}</p>
            )}
          </div>

          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 14 }}>
            Payments are processed by Stripe. We never see or store your card details.
            Need help? Email <a href="mailto:support@cleartopay.com" style={{ color: "var(--blue)" }}>support@cleartopay.com</a>.
          </p>
        </div>
      )}
    </div>
  );
}
