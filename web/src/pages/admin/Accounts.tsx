import { useEffect, useState, useMemo } from "react";
import { apiFetch } from "../../lib/api";
import { Badge, fmtDateTime, LoadingBlock, ErrorBlock } from "./common";

interface Account {
  id: number;
  name: string;
  subscription_status: string | null;
  payment_week_start_day: string | null;
  wizard_status: string | null;
  created_at: string;
  user_count: number;
  vendor_count: number;
}

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  trialing: "Trial",
  past_due: "Past Due",
  cancelled: "Cancelled",
  unpaid: "Unpaid",
  incomplete: "Incomplete",
  TRIAL: "Trial",
  ACTIVE: "Active",
  CANCELLED: "Cancelled",
};

const ACTIVE_STATUSES = new Set(["active", "trial", "trialing", "ACTIVE", "TRIAL"]);

export default function AdminAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "trial" | "cancelled">("all");

  useEffect(() => {
    apiFetch("/api/admin/accounts")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch accounts");
        return res.json();
      })
      .then((data) => {
        setAccounts((data.accounts ?? []) as Account[]);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const filteredAccounts = useMemo(() => {
    if (filter === "all") return accounts;
    return accounts.filter((a) => {
      const status = (a.subscription_status || "").toLowerCase();
      if (filter === "active") return ACTIVE_STATUSES.has(status);
      if (filter === "trial") return status === "trial" || status === "trialing";
      if (filter === "cancelled") return status === "cancelled" || status === "unpaid";
      return true;
    });
  }, [accounts, filter]);

  const activeCount = accounts.filter((a) => ACTIVE_STATUSES.has((a.subscription_status || "").toLowerCase())).length;

  return (
    <div className="dashboard">
      <h2 className="page-title">Client Accounts</h2>
      <p className="page-subtitle">All construction companies that signed up for ClearToPay.</p>

      {/* Summary bar */}
      {!loading && !error && (
        <div className="metrics-grid" style={{ marginTop: 16, marginBottom: 8 }}>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#1a56db" }}>👥</div>
            <div className="metric-body">
              <span className="metric-label">Total Accounts</span>
              <span className="metric-value" style={{ color: "#1a56db" }}>{accounts.length}</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#059669" }}>✓</div>
            <div className="metric-body">
              <span className="metric-label">Active / Trial</span>
              <span className="metric-value" style={{ color: "#059669" }}>{activeCount}</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#d97706" }}>📋</div>
            <div className="metric-body">
              <span className="metric-label">Total Vendors</span>
              <span className="metric-value" style={{ color: "#d97706" }}>{accounts.reduce((s, a) => s + a.vendor_count, 0)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      {!loading && !error && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, marginTop: 8 }}>
          {(["all", "active", "trial", "cancelled"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={filter === f ? "btn btn-primary btn-sm" : "btn btn-outline btn-sm"}
              style={{ padding: "4px 14px", fontSize: 13, borderRadius: 8 }}
            >
              {f === "all" ? "All" : f === "active" ? "Active" : f === "trial" ? "Trial" : "Cancelled"}
              {f !== "all" && ` (${filteredAccounts.length})`}
            </button>
          ))}
        </div>
      )}

      {loading && <LoadingBlock label="Loading accounts…" />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Company Name</th>
                <th>Payment Status</th>
                <th>Setup</th>
                <th>Vendors</th>
                <th>Users</th>
                <th>Signed Up</th>
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.length === 0 ? (
                <tr><td colSpan={6} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No accounts match this filter.</td></tr>
              ) : filteredAccounts.map((a) => (
                <tr key={a.id}>
                  <td className="td-name">{a.name}</td>
                  <td>
                    <Badge status={a.subscription_status} />
                    {a.subscription_status && STATUS_LABELS[a.subscription_status] && (
                      <span style={{ marginLeft: 6, fontSize: 12, color: "var(--text-muted)" }}>
                        {STATUS_LABELS[a.subscription_status]}
                      </span>
                    )}
                  </td>
                  <td><Badge status={a.wizard_status} /></td>
                  <td>{a.vendor_count}</td>
                  <td>{a.user_count}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
