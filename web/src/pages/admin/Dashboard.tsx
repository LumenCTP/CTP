import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { money, LoadingBlock, ErrorBlock } from "./common";

interface AdminStats {
  total_partners: number;
  pending_applications: number;
  active_partners: number;
  total_referrals: number;
  active_referred_customers: number;
  referral_conversion_rate: number;
  referred_monthly_revenue: number;
  pending_commissions: { count: number; amount: number };
  approved_commissions: { count: number; amount: number };
  upcoming_payouts: number;
  lifetime_commissions_paid: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/dashboard")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load admin dashboard");
        return res.json();
      })
      .then((data) => {
        setStats(data as AdminStats);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load admin dashboard");
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div className="dashboard"><h2 className="page-title">Admin Dashboard</h2><LoadingBlock label="Loading metrics…" /></div>;
  }
  if (error || !stats) {
    return <div className="dashboard"><h2 className="page-title">Admin Dashboard</h2><ErrorBlock message={error || "No data"} /></div>;
  }

  const countCards = [
    { key: "total_partners", label: "Total Partners", icon: "🤝", color: "#1a56db", value: String(stats.total_partners) },
    { key: "pending_applications", label: "Pending Applications", icon: "⏳", color: "#d97706", value: String(stats.pending_applications) },
    { key: "active_partners", label: "Active Partners", icon: "✓", color: "#059669", value: String(stats.active_partners) },
    { key: "total_referrals", label: "Total Referrals", icon: "👥", color: "#1a56db", value: String(stats.total_referrals) },
    { key: "active_customers", label: "Active Referred Customers", icon: "✓", color: "#059669", value: String(stats.active_referred_customers) },
    { key: "conversion", label: "Referral Conversion Rate", icon: "📈", color: "#7c3aed", value: `${stats.referral_conversion_rate.toFixed(1)}%` },
  ];

  const moneyCards = [
    { key: "monthly_rev", label: "Referred Monthly Subscription Revenue", color: "#059669", value: money(stats.referred_monthly_revenue) },
    { key: "pending_comm", label: `Pending Commissions (${stats.pending_commissions.count})`, color: "#d97706", value: money(stats.pending_commissions.amount) },
    { key: "approved_comm", label: `Approved Commissions (${stats.approved_commissions.count})`, color: "#1a56db", value: money(stats.approved_commissions.amount) },
    { key: "upcoming", label: "Upcoming Payouts", color: "#1a56db", value: money(stats.upcoming_payouts) },
    { key: "lifetime", label: "Lifetime Commissions Paid", color: "#059669", value: money(stats.lifetime_commissions_paid) },
  ];

  return (
    <div className="dashboard">
      <h2 className="page-title">Admin Dashboard</h2>
      <p className="page-subtitle">System-wide partner program overview.</p>

      <div className="metrics-grid">
        {countCards.map((card) => (
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
        {moneyCards.map((card) => (
          <div key={card.key} className="partner-status-card">
            <span className="partner-status-label">{card.label}</span>
            <span className="partner-status-value" style={{ color: card.color }}>{card.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
