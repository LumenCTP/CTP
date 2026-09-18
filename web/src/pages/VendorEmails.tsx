import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

/**
 * Vendor Emails — every vendor this client has an email address on file for,
 * plus the last vendor-facing email the system actually sent them.
 *
 * "On file" means either the vendor's own contact email or their insurance
 * agent's email is non-empty; these are the addresses the compliance inbox
 * accepts documents from, so it is the list to check when a document is not
 * arriving or a renewal reminder needs to go out.
 *
 * "Last Emailed" comes from GET /api/vendors (last_emailed_at /
 * last_email_type / last_email_status, already tenant-scoped server-side):
 * a vendor with no row shows "Not yet emailed" — we never imply outreach that
 * did not happen.
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
  last_emailed_at: string | null;
  last_email_type: string | null;
  last_email_status: string | null;
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

/** Plain-language name for a vendor-facing email type. */
function emailTypeLabel(type: string): string {
  switch (type) {
    case "renewal_reminder":
      return "renewal reminder";
    case "inbox_rejection":
      return "submission rejection";
    default:
      return type.replace(/_/g, " ");
  }
}

/**
 * email_log.sent_at is UTC "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now')); the
 * trailing "Z" makes the browser read it as UTC rather than local time. An
 * unparseable value falls back to the raw string instead of "Invalid Date".
 */
function formatSentAt(value: string): string {
  const d = new Date(value.includes("T") ? value : `${value}Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Aug 15, 2026, 04:32 PM — renewal reminder" or null when never emailed. */
function lastEmailedText(v: VendorRow): string | null {
  const sentAt = clean(v.last_emailed_at);
  if (!sentAt) return null;
  const type = clean(v.last_email_type);
  return type ? `${formatSentAt(sentAt)} — ${emailTypeLabel(type)}` : formatSentAt(sentAt);
}

/** Non-delivery marker: a queued/failed send does not mean the vendor was reached. */
function deliveryNote(status: string | null | undefined): string | null {
  const s = clean(status);
  if (!s || s === "sent") return null;
  if (s === "queued") return "not sent yet";
  if (s === "error") return "delivery failed";
  return s;
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
        reminders are sent to — plus the last email the system sent each vendor.
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
                  <th>Last Emailed</th>
                </tr>
              </thead>
              <tbody>
                {vendors.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}
                    >
                      No vendors with email addresses on file yet — add a contact email or insurance
                      agent email on a vendor to see it here.
                    </td>
                  </tr>
                ) : (
                  vendors.map((v) => {
                    const emailed = lastEmailedText(v);
                    const note = emailed ? deliveryNote(v.last_email_status) : null;
                    return (
                      <tr key={v.id}>
                        <td className="td-name">
                          <Link to={`/app/vendors/${v.id}`}>{v.name}</Link>
                        </td>
                        <td>{clean(v.contact_name) || "—"}</td>
                        <td>{clean(v.contact_email) || "—"}</td>
                        <td>{clean(v.insurance_agent_email) || "—"}</td>
                        <td style={{ color: emailed ? undefined : "var(--gray-500)" }}>
                          {emailed ? (
                            <>
                              {emailed}
                              {note && (
                                <span
                                  style={{ color: "#dc2626", fontSize: "12px", fontWeight: 600 }}
                                >
                                  {" "}
                                  ({note})
                                </span>
                              )}
                            </>
                          ) : (
                            "Not yet emailed"
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
