import { useEffect, useState } from "react";
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

export default function AdminAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="dashboard">
      <h2 className="page-title">Client Accounts</h2>
      <p className="page-subtitle">All construction companies that signed up for ClearToPay.</p>

      {loading && <LoadingBlock label="Loading accounts…" />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Company Name</th>
                <th>Subscription Status</th>
                <th>Wizard Status</th>
                <th>Vendors</th>
                <th>Users</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr><td colSpan={6} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No client accounts yet.</td></tr>
              ) : accounts.map((a) => (
                <tr key={a.id}>
                  <td className="td-name">{a.name}</td>
                  <td><Badge status={a.subscription_status} /></td>
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
