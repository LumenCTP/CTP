import { useEffect, useState } from "react";
import type { DashboardStats } from "@clear-to-pay/shared";

interface MetricCard {
  key: keyof DashboardStats;
  label: string;
  icon: string;
  color: string;
}

const metricCards: MetricCard[] = [
  { key: "total_clients", label: "Total Clients", icon: "▦", color: "#1a56db" },
  { key: "total_vendors", label: "Total Vendors", icon: "👥", color: "#1a56db" },
  { key: "vendors_approved", label: "Approved for Payment", icon: "✓", color: "#059669" },
  { key: "vendors_review", label: "Review Before Payment", icon: "🔍", color: "#d97706" },
  { key: "vendors_hold", label: "Hold Payment", icon: "🚫", color: "#dc2626" },
  { key: "expiring_this_week", label: "Expiring This Week", icon: "⏰", color: "#d97706" },
  { key: "needs_review", label: "Needs Review", icon: "⚠", color: "#dc2626" },
];

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch stats");
        return res.json();
      })
      .then((data: DashboardStats) => {
        setStats(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="dashboard">
        <h2 className="page-title">Dashboard</h2>
        <div className="loading">Loading metrics…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard">
        <h2 className="page-title">Dashboard</h2>
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <h2 className="page-title">Dashboard</h2>
      <div className="metrics-grid">
        {metricCards.map((card) => (
          <div key={card.key} className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: card.color }}>
              {card.icon}
            </div>
            <div className="metric-body">
              <span className="metric-label">{card.label}</span>
              <span className="metric-value" style={{ color: card.color }}>
                {stats ? stats[card.key] : 0}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
