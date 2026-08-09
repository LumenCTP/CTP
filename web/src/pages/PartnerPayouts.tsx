import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

interface Payout {
  id: number;
  amount: number | null;
  status: string;
  payment_method: string | null;
  transaction_ref: string | null;
  created_at: string | null;
}

function money(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function statusBadge(status: string) {
  const cls: Record<string, string> = {
    pending: "badge-lead",
    paid: "badge-active",
    cancelled: "badge-cancelled",
  };
  return <span className={`badge ${cls[status] ?? "badge-lead"}`}>{status.replace("_", " ")}</span>;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function PartnerPayouts() {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/partner/payouts")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch payouts");
        return res.json();
      })
      .then((data) => {
        setPayouts(data.payouts ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const totalPaid = payouts.filter((p) => p.status === "paid").reduce((s, p) => s + Number(p.amount ?? 0), 0);

  return (
    <div className="dashboard">
      <h2 className="page-title">My Payouts</h2>
      <p className="page-subtitle">Commission payouts sent to you.</p>

      {loading && <div className="loading">Loading payouts…</div>}
      {error && <div className="error-message">Error: {error}</div>}
      {!loading && !error && (
        <>
          <div className="partner-status-grid partner-summary-grid">
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
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payouts.length === 0 ? (
                  <tr><td colSpan={5} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No payouts yet — approved commissions are paid out on a regular schedule.</td></tr>
                ) : payouts.map((p) => (
                  <tr key={p.id}>
                    <td>{formatDate(p.created_at)}</td>
                    <td style={{ fontWeight: 600 }}>{money(p.amount)}</td>
                    <td>{p.payment_method || "—"}</td>
                    <td>{p.transaction_ref || "—"}</td>
                    <td>{statusBadge(p.status)}</td>
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
