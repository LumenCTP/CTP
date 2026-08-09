import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { fmtDateTime, LoadingBlock, ErrorBlock } from "./common";

interface AuditEntry {
  id: number;
  partner_id: number;
  partner_name: string | null;
  action: string;
  changes: string | null;
  reason: string | null;
  performed_by: string | null;
  created_at: string;
}

interface Partner {
  id: number;
  first_name: string;
  last_name: string;
  company_name: string | null;
}

// Derive (entityType, entityId) from the action + changes JSON when possible.
// e.g. action "commission_status_changed" with changes {commission_id: 3} → ("Commission", 3)
const ENTITY_KEY_HINTS: Array<[string, string]> = [
  ["referral_id", "Referral"],
  ["commission_id", "Commission"],
  ["payout_id", "Payout"],
  ["partner_id", "Partner"],
];

function parseChanges(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function entityOf(action: string, changes: Record<string, unknown> | null): { type: string; id: string } {
  if (changes) {
    for (const [key, hint] of ENTITY_KEY_HINTS) {
      if (changes[key] !== undefined && changes[key] !== null) return { type: hint, id: String(changes[key]) };
    }
  }
  // Fall back to parsing the action prefix: "referral_created" → Referral
  const prefix = action.split("_")[0];
  const map: Record<string, string> = { referral: "Referral", commission: "Commission", payout: "Payout", partner: "Partner", application: "Application" };
  return { type: map[prefix] ?? "Partner", id: "—" };
}

function fmtChanges(changes: Record<string, unknown> | null): Array<[string, string]> {
  if (!changes) return [];
  return Object.entries(changes).map(([k, v]) => {
    const val = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");
    return [k, val];
  });
}

export default function AdminAuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fPartner, setFPartner] = useState("");
  const [fAction, setFAction] = useState("");
  const [fStart, setFStart] = useState("");
  const [fEnd, setFEnd] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (fPartner) params.set("partner_id", fPartner);
    if (fAction) params.set("action", fAction);
    if (fStart) params.set("from", `${fStart} 00:00:00`);
    if (fEnd) params.set("to", `${fEnd} 23:59:59`);
    const qs = params.toString();
    apiFetch(`/api/admin/audit-log${qs ? `?${qs}` : ""}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch audit log");
        return res.json();
      })
      .then((data) => {
        setEntries((data.entries ?? []) as AuditEntry[]);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(load, [fPartner, fAction, fStart, fEnd]);

  useEffect(() => {
    apiFetch("/api/partners")
      .then((res) => (res.ok ? res.json() : { partners: [] }))
      .then((data) => setPartners((data.partners ?? []) as Partner[]))
      .catch(() => {});
  }, []);

  const actionTypes = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.action);
    return Array.from(set).sort();
  }, [entries]);

  return (
    <div className="dashboard">
      <h2 className="page-title">Audit Log</h2>
      <p className="page-subtitle">Every partner-program action, recorded for the trail.</p>

      <div className="filter-bar" style={{ flexWrap: "wrap" }}>
        <select className="form-select" value={fPartner} onChange={(e) => setFPartner(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">All partners</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>{`${p.first_name} ${p.last_name}`.trim()}{p.company_name ? ` — ${p.company_name}` : ""}</option>
          ))}
        </select>
        <select className="form-select" value={fAction} onChange={(e) => setFAction(e.target.value)}>
          <option value="">All actions</option>
          {actionTypes.map((a) => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
        </select>
        <label>From <input className="form-input" type="date" value={fStart} onChange={(e) => setFStart(e.target.value)} /></label>
        <label>To <input className="form-input" type="date" value={fEnd} onChange={(e) => setFEnd(e.target.value)} /></label>
        {(fPartner || fAction || fStart || fEnd) && (
          <button className="btn btn-outline btn-sm" onClick={() => { setFPartner(""); setFAction(""); setFStart(""); setFEnd(""); }}>Clear</button>
        )}
      </div>

      {loading && <LoadingBlock label="Loading audit log…" />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Partner</th>
                <th>Action</th>
                <th>Entity Type</th>
                <th>Entity ID</th>
                <th>Changes</th>
                <th>Performed By</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr><td colSpan={8} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No audit entries found.</td></tr>
              ) : entries.map((e) => {
                const changes = parseChanges(e.changes);
                const entity = entityOf(e.action, changes);
                const pairs = fmtChanges(changes);
                const isExpanded = expanded === e.id;
                return (
                  <tr key={e.id} onClick={() => setExpanded(isExpanded ? null : e.id)} style={{ cursor: "pointer", verticalAlign: "top" }}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(e.created_at)}</td>
                    <td className="td-name">{e.partner_name || `Partner #${e.partner_id}`}</td>
                    <td><span className="badge badge-pending">{e.action.replace(/_/g, " ")}</span></td>
                    <td>{entity.type}</td>
                    <td>{entity.id}</td>
                    <td>
                      {pairs.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : isExpanded ? (
                        <div style={{ maxWidth: 320 }}>
                          {pairs.map(([k, v]) => (
                            <div key={k} style={{ fontSize: "0.8rem", lineHeight: 1.5 }}>
                              <span style={{ color: "var(--gray-500)", fontWeight: 600 }}>{k}:</span>{" "}
                              <span style={{ color: "var(--gray-700)" }}>{v}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted">{pairs.length} field{pairs.length === 1 ? "" : "s"} — click to expand</span>
                      )}
                    </td>
                    <td>{e.performed_by || "—"}</td>
                    <td style={{ maxWidth: 200 }}>{e.reason || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
