import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { LoadingBlock, ErrorBlock } from "./common";

interface CashflowSummary {
  active_accounts: number;
  trial_accounts: number;
  cancelled_accounts: number;
  mrr: number;
  projected_12mo: number;
  partner_payouts_outstanding: number;
  partner_payouts_paid: number;
  projected_payouts_12mo: number;
  net_projected_12mo: number;
}

interface MonthRow {
  month: string;
  revenue: number;
  payouts: number;
  net: number;
  cumulative: number;
}

interface CashflowData {
  summary: CashflowSummary;
  months: MonthRow[];
  assumptions: { monthly_rate: number; annual_monthly_equivalent: number; payout_note?: string };
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function AdminCashflow() {
  const [data, setData] = useState<CashflowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/cashflow")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch cash flow forecast");
        return res.json();
      })
      .then((d: CashflowData) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const summary = data?.summary;
  const months = data?.months ?? [];
  const maxNet = months.reduce((m, r) => Math.max(m, Math.abs(r.net)), 0);
  const hasAccounts = !!summary && summary.active_accounts + summary.trial_accounts + summary.cancelled_accounts > 0;

  return (
    <div className="dashboard">
      <h2 className="page-title">Cash Flow</h2>
      <p className="page-subtitle">
        12-month cash flow projection — projected revenue minus partner payouts — based on the current book of client
        accounts.
      </p>

      {/* Summary bar */}
      {!loading && !error && summary && (
        <div className="metrics-grid" style={{ marginTop: 16, marginBottom: 8 }}>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#1a56db" }}>🏢</div>
            <div className="metric-body">
              <span className="metric-label">Active Accounts</span>
              <span className="metric-value" style={{ color: "#1a56db" }}>{summary.active_accounts}</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#059669" }}>💰</div>
            <div className="metric-body">
              <span className="metric-label">Monthly Recurring Revenue</span>
              <span className="metric-value" style={{ color: "#059669" }}>{fmtMoney(summary.mrr)}</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#7c3aed" }}>📈</div>
            <div className="metric-body">
              <span className="metric-label">Projected 12-Month Revenue</span>
              <span className="metric-value" style={{ color: "#7c3aed" }}>{fmtMoney(summary.projected_12mo)}</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#dc2626" }}>🤝</div>
            <div className="metric-body">
              <span className="metric-label">Partner Payouts (projected)</span>
              <span className="metric-value" style={{ color: "#dc2626" }}>{fmtMoney(summary.projected_payouts_12mo)}</span>
            </div>
          </div>
          {/* Primary card: net after payouts */}
          <div
            className="metric-card"
            style={{ background: "linear-gradient(135deg, #1a56db 0%, #7c3aed 100%)", boxShadow: "0 4px 14px rgba(26, 86, 219, 0.35)" }}
          >
            <div className="metric-icon" style={{ backgroundColor: "rgba(255,255,255,0.22)" }}>💵</div>
            <div className="metric-body">
              <span className="metric-label" style={{ color: "rgba(255,255,255,0.78)" }}>Net 12-Mo (after payouts)</span>
              <span className="metric-value" style={{ color: "#fff" }}>{fmtMoney(summary.net_projected_12mo)}</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#d97706" }}>🧪</div>
            <div className="metric-body">
              <span className="metric-label">Trial Accounts (Potential)</span>
              <span className="metric-value" style={{ color: "#d97706" }}>{summary.trial_accounts}</span>
            </div>
          </div>
        </div>
      )}

      {loading && <LoadingBlock label="Loading cash flow forecast…" />}
      {error && <ErrorBlock message={error} />}

      {!loading && !error && hasAccounts && (
        <div className="table-wrapper" style={{ marginTop: 16 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Revenue</th>
                <th>Payouts</th>
                <th style={{ width: "30%" }}>Net</th>
                <th>Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td className="td-name" style={{ whiteSpace: "nowrap" }}>{m.month}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtMoney(m.revenue)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtMoney(m.payouts)}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div
                        style={{
                          flex: 1,
                          maxWidth: 220,
                          height: 10,
                          borderRadius: 5,
                          backgroundColor: "var(--gray-200, #e5e7eb)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: maxNet > 0 ? `${Math.max(4, (Math.abs(m.net) / maxNet) * 100)}%` : "0%",
                            borderRadius: 5,
                            backgroundColor: m.net < 0 ? "#dc2626" : "#059669",
                          }}
                        />
                      </div>
                      <span style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                        {fmtMoney(m.net)}
                      </span>
                    </div>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtMoney(m.cumulative)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="page-subtitle" style={{ marginTop: 12, fontSize: 12.5 }}>
            Partner Payouts Outstanding: <strong>{fmtMoney(summary?.partner_payouts_outstanding ?? 0)}</strong>{" "}
            (committed, unpaid) &nbsp;·&nbsp; Paid to date:{" "}
            <strong>{fmtMoney(summary?.partner_payouts_paid ?? 0)}</strong>
          </p>
        </div>
      )}

      {!loading && !error && !hasAccounts && (
        <div style={{ marginTop: 24, padding: 32, textAlign: "center", color: "var(--gray-500)", border: "1px dashed var(--gray-300, #d1d5db)", borderRadius: 12 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
          <div style={{ fontWeight: 600, color: "var(--text, #111827)", marginBottom: 4 }}>No accounts yet</div>
          <div>Once construction companies sign up and subscribe, a 12-month cash flow forecast will appear here.</div>
        </div>
      )}

      {!loading && !error && data && (
        <p className="page-subtitle" style={{ marginTop: 20, fontSize: 12.5 }}>
          Assumptions: Projection uses ${data.assumptions.monthly_rate}/mo (monthly) or $
          {data.assumptions.annual_monthly_equivalent}/mo (annual) per active account, flat over 12 months.{" "}
          {data.assumptions.payout_note ? `${data.assumptions.payout_note} ` : ""}
          Based on current accounts only — a projection, not a guarantee.
        </p>
      )}
    </div>
  );
}
