import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

interface Commission {
  id: number;
  customer_name: string | null;
  eligible_revenue: number | null;
  commission_percentage: number | null;
  commission_amount: number | null;
  earned_date: string | null;
  status: string;
}

function money(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function statusBadge(status: string) {
  const cls: Record<string, string> = {
    pending: "badge-lead",
    approved: "badge-active",
    scheduled: "badge-trial",
    paid: "badge-active",
    reversed: "badge-cancelled",
    disputed: "badge-cancelled",
  };
  return <span className={`badge ${cls[status] ?? "badge-lead"}`}>{status.replace("_", " ")}</span>;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function PartnerCommissions() {
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/partner/commissions")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch commissions");
        return res.json();
      })
      .then((data) => {
        setCommissions(data.commissions ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const totalPending = commissions.filter((c) => c.status === "pending").reduce((s, c) => s + Number(c.commission_amount ?? 0), 0);
  const totalApproved = commissions.filter((c) => c.status === "approved" || c.status === "scheduled").reduce((s, c) => s + Number(c.commission_amount ?? 0), 0);
  const totalPaid = commissions.filter((c) => c.status === "paid").reduce((s, c) => s + Number(c.commission_amount ?? 0), 0);

  return (
    <div className="dashboard">
      <h2 className="page-title">My Commissions</h2>
      <p className="page-subtitle">Commissions earned from referrals that signed up.</p>

      {loading && <div className="loading">Loading commissions…</div>}
      {error && <div className="error-message">Error: {error}</div>}
      {!loading && !error && (
        <>
          <div className="partner-status-grid partner-summary-grid">
            <div className="partner-status-card">
              <span className="partner-status-label">Total Pending</span>
              <span className="partner-status-value" style={{ color: "#d97706" }}>{money(totalPending)}</span>
            </div>
            <div className="partner-status-card">
              <span className="partner-status-label">Total Approved</span>
              <span className="partner-status-value" style={{ color: "#1a56db" }}>{money(totalApproved)}</span>
            </div>
            <div className="partner-status-card">
              <span className="partner-status-label">Total Paid</span>
              <span className="partner-status-value" style={{ color: "#059669" }}>{money(totalPaid)}</span>
            </div>
          </div>

          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Eligible Revenue</th>
                  <th>Percentage</th>
                  <th>Commission Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {commissions.length === 0 ? (
                  <tr><td colSpan={6} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No commissions yet — they appear once a referred company signs up.</td></tr>
                ) : commissions.map((c) => (
                  <tr key={c.id}>
                    <td>{formatDate(c.earned_date)}</td>
                    <td className="td-name">{c.customer_name || "—"}</td>
                    <td>{money(c.eligible_revenue)}</td>
                    <td>{Number(c.commission_percentage ?? 0)}%</td>
                    <td style={{ fontWeight: 600 }}>{money(c.commission_amount)}</td>
                    <td>{statusBadge(c.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
