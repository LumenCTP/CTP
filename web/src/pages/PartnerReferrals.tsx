import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

interface Referral {
  id: number;
  referred_company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  referral_date: string | null;
  customer_status: string;
  notes?: string | null;
}

// Status badge colors: lead=yellow, trial=blue, active=green,
// past_due=orange, cancelled/refunded=red.
function statusBadge(status: string) {
  const cls: Record<string, string> = {
    lead: "badge-lead",
    trial: "badge-trial",
    active: "badge-active",
    past_due: "badge-past_due",
    cancelled: "badge-cancelled",
    refunded: "badge-refunded",
  };
  return <span className={`badge ${cls[status] ?? "badge-lead"}`}>{status.replace("_", " ")}</span>;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function PartnerReferrals() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/partner/referrals")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch referrals");
        return res.json();
      })
      .then((data) => {
        const rows = (data.referrals ?? []) as Referral[];
        // Sort by referral date descending (newest first).
        rows.sort((a, b) => {
          const ta = a.referral_date ? new Date(a.referral_date).getTime() : 0;
          const tb = b.referral_date ? new Date(b.referral_date).getTime() : 0;
          return tb - ta;
        });
        setReferrals(rows);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <div className="dashboard">
      <h2 className="page-title">My Referrals</h2>
      <p className="page-subtitle">Everyone you've referred to ClearToPay Compliance.</p>

      {loading && <div className="loading">Loading referrals…</div>}
      {error && <div className="error-message">Error: {error}</div>}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Email</th>
                <th>Referral Date</th>
                <th>Customer Status</th>
              </tr>
            </thead>
            <tbody>
              {referrals.length === 0 ? (
                <tr><td colSpan={5} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No referrals yet — share your link or submit your first referral.</td></tr>
              ) : referrals.map((r) => (
                <tr key={r.id}>
                  <td className="td-name">{r.referred_company || "—"}</td>
                  <td>{r.contact_name || "—"}</td>
                  <td>{r.contact_email || "—"}</td>
                  <td>{formatDate(r.referral_date)}</td>
                  <td>{statusBadge(r.customer_status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
