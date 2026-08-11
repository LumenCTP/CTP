import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

interface PartnerProfile {
  id?: number;
  first_name?: string;
  last_name?: string;
  company_name?: string | null;
  referral_code?: string | null;
  status?: string;
  stripe?: StripeConnectState;
  payouts?: PayoutRow[];
}

interface StripeConnectState {
  stripe_account_id?: string | null;
  details_submitted?: boolean;
  currently_due?: string;
  payouts_enabled?: boolean;
  charges_enabled?: boolean;
  disconnected_at?: string | null;
  connect_status?: "not_connected" | "onboarding" | "active";
}

interface PayoutRow {
  id: number;
  amount: number | null;
  status: string;
  payment_method: string | null;
  transaction_ref: string | null;
  payment_date: string | null;
  notes: string | null;
  created_at: string | null;
}

interface DashboardData {
  referral_code: string | null;
  referral_link: string | null;
  total_referrals: number;
  active_customers: number;
  pending_referrals: number;
  cancelled_customers: number;
  current_month_earnings: number;
  pending_commission: number;
  approved_commission: number;
  paid_commission: number;
  lifetime_earnings: number;
  next_expected_payout: number;
}

function money(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Small copy button that shows "Copied!" for 2 seconds after clicking.
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard unavailable — fall back to a temporary textarea
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button type="button" className="btn btn-outline btn-sm copy-btn" onClick={copy}>
      {copied ? "Copied!" : label}
    </button>
  );
}

export default function PartnerDashboard() {
  const [profile, setProfile] = useState<PartnerProfile | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch("/api/partner/me").then((res) => (res.ok ? res.json() : { partner: null })),
      apiFetch("/api/partner/dashboard").then((res) => (res.ok ? res.json() : null)),
    ])
      .then(([me, dash]) => {
        const partner = (me as { partner?: PartnerProfile })?.partner ?? null;
        setProfile(partner);
        setData(dash as DashboardData | null);
        if (!dash) setError("Unable to load partner dashboard data.");
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load dashboard");
        setLoading(false);
      });
  }, []);

  const handleConnect = useCallback(async () => {
    if (!profile?.id) return;
    setConnectBusy(true);
    setConnectError(null);
    try {
      const res = await apiFetch(`/api/partners/${profile.id}/connect`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setConnectError(json?.error || `Request failed (HTTP ${res.status})`);
        return;
      }
      if (json?.url) {
        window.location.href = json.url; // redirect to Stripe's onboarding page
        return;
      }
      setConnectError("No onboarding URL returned by Stripe.");
    } catch (err: any) {
      setConnectError(err?.message || "Failed to start Stripe Connect onboarding");
    } finally {
      setConnectBusy(false);
    }
  }, [profile?.id]);

  if (loading) {
    return <div className="dashboard"><h2 className="page-title">Partner Dashboard</h2><div className="loading">Loading metrics…</div></div>;
  }

  if (error) {
    return <div className="dashboard"><h2 className="page-title">Partner Dashboard</h2><div className="error-message">Error: {error}</div></div>;
  }

  const name = profile?.first_name || profile?.last_name
    ? `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim()
    : null;
  const company = profile?.company_name || null;
  const referralCode = data?.referral_code || profile?.referral_code || null;
  const referralLink = data?.referral_link || (referralCode ? `https://cleartopay.ctonew.app/get-started?ref=${referralCode}` : null);

  const stats = [
    { key: "total_referrals", label: "Total Referrals", icon: "👥", color: "#1a56db", value: data?.total_referrals ?? 0 },
    { key: "active_customers", label: "Active Customers", icon: "✓", color: "#059669", value: data?.active_customers ?? 0 },
    { key: "current_month", label: "Current Month Earnings", icon: "📅", color: "#1a56db", value: money(data?.current_month_earnings) },
    { key: "lifetime", label: "Lifetime Earnings", icon: "💰", color: "#059669", value: money(data?.lifetime_earnings) },
  ];

  const statusCards = [
    { key: "pending_referrals", label: "Pending Referrals", value: String(data?.pending_referrals ?? 0), color: "#d97706" },
    { key: "cancelled", label: "Cancelled Customers", value: String(data?.cancelled_customers ?? 0), color: "#dc2626" },
    { key: "pending_comm", label: "Pending Commission", value: money(data?.pending_commission), color: "#d97706" },
    { key: "approved_comm", label: "Approved Commission", value: money(data?.approved_commission), color: "#1a56db" },
    { key: "paid_comm", label: "Paid Commission", value: money(data?.paid_commission), color: "#059669" },
    { key: "next_payout", label: "Next Expected Payout", value: money(data?.next_expected_payout), color: "#059669" },
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-heading">
        <div>
          <h2 className="page-title">Partner Dashboard</h2>
          {name && <p className="page-subtitle">{name}{company ? ` · ${company}` : ""}</p>}
        </div>
        <Link to="/app/partner/refer" className="btn btn-primary">Refer a Client</Link>
      </div>

      {referralCode && (
        <section className="referral-code-card">
          <div className="referral-code-info">
            <span className="referral-code-label">Your referral code</span>
            <span className="referral-code">{referralCode}</span>
          </div>
          <div className="referral-code-actions">
            <CopyButton text={referralCode} label="Copy Code" />
            {referralLink && <CopyButton text={referralLink} label="Copy Link" />}
          </div>
          {referralLink && <p className="referral-code-link">Share your link: <span className="referral-link-text">{referralLink}</span></p>}
        </section>
      )}

      <StripeConnectCard
        stripe={profile?.stripe}
        payouts={profile?.payouts}
        busy={connectBusy}
        error={connectError}
        onConnect={handleConnect}
      />

      <div className="metrics-grid">
        {stats.map((card) => (
          <div key={card.key} className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: card.color }}>{card.icon}</div>
            <div className="metric-body">
              <span className="metric-label">{card.label}</span>
              <span className="metric-value" style={{ color: card.color }}>{card.value}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="partner-status-grid">
        {statusCards.map((card) => (
          <div key={card.key} className="partner-status-card">
            <span className="partner-status-label">{card.label}</span>
            <span className="partner-status-value" style={{ color: card.color }}>{card.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stripe Connect card (delegation B) ────────────────────
// Shows connect status (Not connected / Onboarding / Active), a button that
// starts Connect Express onboarding (redirects to Stripe), and recent payout
// history with transfer references.
function StripeConnectCard({
  stripe, payouts, busy, error, onConnect,
}: {
  stripe?: StripeConnectState;
  payouts?: PayoutRow[];
  busy: boolean;
  error: string | null;
  onConnect: () => void;
}) {
  const status = stripe?.connect_status ?? "not_connected";
  const badge =
    status === "active" ? <span className="badge badge-active">Active</span>
    : status === "onboarding" ? <span className="badge badge-pending">Onboarding</span>
    : <span className="badge badge-rejected">Not connected</span>;

  const recent = (payouts ?? []).slice(0, 5);

  return (
    <section className="referral-code-card stripe-connect-card">
      <div className="stripe-connect-header">
        <div className="stripe-connect-title">
          <span style={{ fontSize: "20px", marginRight: "8px" }}>🏦</span>
          <span className="referral-code-label">Stripe Connect payouts</span>
          {badge}
        </div>
        {status !== "active" && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onConnect} disabled={busy}>
            {busy ? "Connecting…" : "Connect Stripe account"}
          </button>
        )}
      </div>
      {error && <p className="error-message" style={{ marginTop: "8px" }}>Error: {error}</p>}
      {status !== "active" && (
        <p className="stripe-connect-hint">
          Connect a Stripe account to receive your commission payouts by direct transfer.
          {status === "onboarding" ? " Your account exists but isn't fully onboarded yet — finish the Stripe steps or click connect again." : ""}
        </p>
      )}
      {status === "active" && stripe?.stripe_account_id && (
        <p className="stripe-connect-hint">
          Payouts are transferred to your connected Stripe account (<code>{stripe.stripe_account_id}</code>).
        </p>
      )}
      <div className="table-wrapper" style={{ marginTop: "12px" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Transfer ref</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: "center", color: "#6b7280" }}>No payouts yet.</td></tr>
            )}
            {recent.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.payment_date || p.created_at)}</td>
                <td>{money(p.amount)}</td>
                <td>{p.status.replace("_", " ")}</td>
                <td>{p.transaction_ref ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(payouts ?? []).length > 5 && (
        <p style={{ marginTop: "8px" }}><Link to="/app/partner/payouts" className="btn btn-outline btn-sm">View all payouts</Link></p>
      )}
    </section>
  );
}
