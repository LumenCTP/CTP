import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

/**
 * Vendor Emails — every vendor this client has an email address on file for.
 *
 * "On file" means either the vendor's own contact email or their insurance
 * agent's email is non-empty; these are the addresses the compliance inbox
 * accepts documents from, so it is the list to check when a document is not
 * arriving or a renewal reminder needs to go out.
 */
interface VendorRow {
  id: number;
  client_id: number;
  client_name: string | null;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  insurance_agent_email: string | null;
}

/** Trimmed, non-empty string or null. */
function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasReachableEmail(v: VendorRow): boolean {
  return Boolean(clean(v.contact_email) || clean(v.insurance_agent_email));
}

export default function VendorEmails() {
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch("/api/vendors")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch vendors");
        return res.json();
      })
      .then((data) => {
        const rows: VendorRow[] = Array.isArray(data) ? data : (data?.vendors ?? []);
        setVendors(rows.filter(hasReachableEmail));
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || "Failed to fetch vendors");
        setLoading(false);
      });
  }, []);

  useEffect(load, [load]);

  return (
    <div className="dashboard">
      <h2 className="page-title">Vendor Emails</h2>
      <p className="page-subtitle">
        Vendors with an email address on file — these are the addresses documents and renewal
        reminders are sent to.
      </p>

      {loading && <div className="loading">Loading vendors…</div>}
      {error && <div className="error-message">Error: {error}</div>}
      {error && (
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={load}>
          Try again
        </button>
      )}
      {!loading && !error && (
        <>
          {vendors.length > 0 && (
            <p className="page-subtitle" style={{ marginTop: 0 }}>
              {vendors.length} vendor{vendors.length === 1 ? "" : "s"} with an email address on file.
            </p>
          )}
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Contact</th>
                  <th>Contact Email</th>
                  <th>Insurance Agent Email</th>
                </tr>
              </thead>
              <tbody>
                {vendors.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}
                    >
                      No vendors with email addresses on file yet — add a contact email or insurance
                      agent email on a vendor to see it here.
                    </td>
                  </tr>
                ) : (
                  vendors.map((v) => (
                    <tr key={v.id}>
                      <td className="td-name">
                        <Link to={`/app/vendors/${v.id}`}>{v.name}</Link>
                      </td>
                      <td>{clean(v.contact_name) || "—"}</td>
                      <td>{clean(v.contact_email) || "—"}</td>
                      <td>{clean(v.insurance_agent_email) || "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
