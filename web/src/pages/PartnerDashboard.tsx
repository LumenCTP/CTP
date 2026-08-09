import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

interface PartnerProfile {
  first_name?: string;
  last_name?: string;
  company_name?: string | null;
  referral_code?: string | null;
  status?: string;
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
