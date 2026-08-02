import { useEffect, useState, useCallback } from "react";

interface EmailLogEntry {
  id: number;
  client_id: number | null;
  vendor_id: number | null;
  email_type: string;
  recipient_email: string;
  subject: string;
  sent_at: string;
  status: string;
  error_message: string | null;
  client_name: string | null;
  vendor_name: string | null;
}

function formatDateTime(dt: string): string {
  const d = new Date(dt + "Z");
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function emailTypeLabel(type: string): string {
  switch (type) {
    case "weekly_report": return "Weekly Report";
    case "monthly_report": return "Monthly Report";
    case "renewal_reminder": return "Renewal Reminder";
    default: return type;
  }
}

function emailTypeColor(type: string): string {
  switch (type) {
    case "weekly_report": return "#1a56db";
    case "monthly_report": return "#059669";
    case "renewal_reminder": return "#d97706";
    default: return "#6b7280";
  }
}

export default function EmailLog() {
  const [logs, setLogs] = useState<EmailLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clientFilter, setClientFilter] = useState("");
  const [clients, setClients] = useState<Array<{ id: number; name: string }>>([]);

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true);
      let url = "/api/emails/log?limit=200";
      if (clientFilter) url += `&client_id=${clientFilter}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch email log");
      const data: EmailLogEntry[] = await res.json();
      setLogs(data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [clientFilter]);

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch("/api/clients");
      if (!res.ok) return;
      const data = await res.json();
      setClients(data.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name })));
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return (
    <div className="page-container">
      <div className="page-header">
        <h2 className="page-title">Email Log</h2>
      </div>

      <p className="page-subtitle">
        View all emails sent by the system, including weekly reports, monthly reports, and renewal reminders.
      </p>

      {/* ── Filter ── */}
      <div style={{ marginBottom: "16px", display: "flex", gap: "8px", alignItems: "center" }}>
        <label htmlFor="client-filter" style={{ fontWeight: 500, fontSize: "14px" }}>Client:</label>
        <select
          id="client-filter"
          className="form-input"
          style={{ width: "220px" }}
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
        >
          <option value="">All Clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="loading">Loading email log…</div>
      ) : error ? (
        <div className="error-message">Error: {error}</div>
      ) : logs.length === 0 ? (
        <p className="text-muted">No emails have been sent yet.</p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Client</th>
                <th>Vendor</th>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(entry.sent_at)}</td>
                  <td>
                    <span
                      className="doc-tag"
                      style={{
                        backgroundColor: emailTypeColor(entry.email_type) + "18",
                        color: emailTypeColor(entry.email_type),
                        borderColor: emailTypeColor(entry.email_type) + "40",
                      }}
                    >
                      {emailTypeLabel(entry.email_type)}
                    </span>
                  </td>
                  <td>{entry.client_name || "—"}</td>
                  <td>{entry.vendor_name || "—"}</td>
                  <td style={{ maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {entry.recipient_email}
                  </td>
                  <td style={{ maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {entry.subject}
                  </td>
                  <td>
                    <span
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        color: entry.status === "sent" ? "#059669" : "#dc2626",
                      }}
                    >
                      {entry.status === "sent" ? "✓ Sent" : "✗ Error"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
