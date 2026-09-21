import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import ComplianceScore from "../components/ComplianceScore";

/**
 * Project detail — the vendors on one jobsite, with their payment status and
 * compliance score, plus assign / remove.
 *
 * Everything shown comes from the API (GET /api/projects/:id and
 * GET /api/projects/:id/vendors): the readiness counts are computed by the same
 * compliance engine as the dashboard and the weekly report, and the vendor rows
 * use the identical shape as the Vendors page, so this page never recomputes a
 * status or a score. It is a flagging aid — the client reviews the source
 * documents and verifies coverage.
 */
interface ProjectSummary {
  id: number;
  name: string;
  vendor_count: number;
  approved_count: number;
  review_count: number;
  hold_count: number;
  all_clear: boolean;
}

interface VendorRow {
  id: number;
  client_id: number;
  client_name: string | null;
  name: string;
  contact_email: string | null;
  compliance_status: string;
  payment_status: "approved" | "review" | "hold" | string;
  compliance_score: number | null;
  score_label: "Good" | "Fair" | "Poor" | null;
}

function statusBadge(status: string) {
  const safe = status || "needs_review";
  return <span className={`badge badge-${safe}`}>{safe.replace(/_/g, " ")}</span>;
}

function paymentBadge(status: string) {
  const safe = status || "hold";
  const label = safe === "approved" ? "approved for payment" : safe === "review" ? "review before payment" : "hold payment";
  return <span className={`badge badge-${safe}`}>{label}</span>;
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();

  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Assign modal
  const [showAssign, setShowAssign] = useState(false);
  const [allVendors, setAllVendors] = useState<VendorRow[]>([]);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [assignSearch, setAssignSearch] = useState("");
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    Promise.all([
      apiFetch(`/api/projects/${id}`).then(async (res) => {
        if (res.status === 404) return { __notFound: true };
        if (!res.ok) throw new Error("Failed to fetch project");
        return res.json();
      }),
      apiFetch(`/api/projects/${id}/vendors`).then((res) => {
        if (!res.ok) throw new Error("Failed to fetch project vendors");
        return res.json();
      }),
    ])
      .then(([projectData, vendorData]) => {
        if ((projectData as { __notFound?: boolean }).__notFound) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setProject(projectData as ProjectSummary);
        setVendors(Array.isArray(vendorData) ? (vendorData as VendorRow[]) : []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || "Failed to load project");
        setLoading(false);
      });
  }, [id]);

  useEffect(load, [load]);

  // Vendors available to assign (the whole tenant list) — fetched when the
  // assign modal opens so the page's first paint stays fast.
  const openAssign = useCallback(() => {
    setShowAssign(true);
    setSelected([]);
    setAssignSearch("");
    setAssignError(null);
    setAssignLoading(true);
    apiFetch("/api/vendors")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch vendors");
        return res.json();
      })
      .then((data) => {
        setAllVendors(Array.isArray(data) ? (data as VendorRow[]) : []);
        setAssignLoading(false);
      })
      .catch((err) => {
        setAssignError(err?.message || "Failed to fetch vendors");
        setAssignLoading(false);
      });
  }, []);

  const assignedIds = useMemo(() => new Set(vendors.map((v) => v.id)), [vendors]);

  const candidates = useMemo(() => {
    const q = assignSearch.trim().toLowerCase();
    return allVendors
      .filter((v) => !assignedIds.has(v.id))
      .filter((v) => (q ? v.name.toLowerCase().includes(q) : true));
  }, [allVendors, assignedIds, assignSearch]);

  async function handleAssign() {
    if (selected.length === 0) return;
    setAssigning(true);
    setAssignError(null);
    try {
      const res = await apiFetch(`/api/projects/${id}/vendors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_ids: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Assign failed");
      setShowAssign(false);
      setMessage(
        `Assigned ${data.assigned ?? selected.length} vendor${(data.assigned ?? selected.length) === 1 ? "" : "s"} to this project.`,
      );
      load();
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : "Assign failed");
    } finally {
      setAssigning(false);
    }
  }

  async function handleRemove(vendor: VendorRow) {
    try {
      const res = await apiFetch(`/api/projects/${id}/vendors/${vendor.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Remove failed");
      setMessage(`Removed ${vendor.name} from this project. Their documents and compliance history are unchanged.`);
      load();
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Remove failed"}`);
    }
  }

  if (loading) {
    return (
      <div className="dashboard">
        <h2 className="page-title">Project</h2>
        <div className="loading">Loading project…</div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="dashboard">
        <h2 className="page-title">Project</h2>
        <div className="error-message">This project could not be found.</div>
        <Link className="btn btn-primary" style={{ display: "inline-block", marginTop: 12 }} to="/app/projects">
          ← Back to Projects
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard">
        <h2 className="page-title">Project</h2>
        <div className="error-message">Error: {error}</div>
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={load}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <p style={{ margin: "0 0 6px" }}>
        <Link to="/app/projects" style={{ color: "var(--blue)", fontSize: 13 }}>← All Projects</Link>
      </p>
      <div className="dashboard-heading">
        <h2 className="page-title">{project?.name}</h2>
        <div className="dashboard-heading-actions">
          <button className="btn btn-primary" onClick={openAssign}>+ Assign Vendors</button>
        </div>
      </div>

      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-icon" style={{ backgroundColor: "#1a56db" }}>👥</div>
          <div className="metric-body">
            <span className="metric-label">Vendors on Project</span>
            <span className="metric-value" style={{ color: "#1a56db" }}>{project?.vendor_count ?? 0}</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon" style={{ backgroundColor: "#059669" }}>✓</div>
          <div className="metric-body">
            <span className="metric-label">Approved for Payment</span>
            <span className="metric-value" style={{ color: "#059669" }}>{project?.approved_count ?? 0}</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon" style={{ backgroundColor: "#d97706" }}>🔍</div>
          <div className="metric-body">
            <span className="metric-label">Review Before Payment</span>
            <span className="metric-value" style={{ color: "#d97706" }}>{project?.review_count ?? 0}</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon" style={{ backgroundColor: "#dc2626" }}>🚫</div>
          <div className="metric-body">
            <span className="metric-label">Hold Payment</span>
            <span className="metric-value" style={{ color: "#dc2626" }}>{project?.hold_count ?? 0}</span>
          </div>
        </div>
      </div>

      <section className="clear-to-pay-card" aria-labelledby="project-readiness-title">
        <div className="clear-to-pay-heading">
          <div>
            <h3 id="project-readiness-title">
              {project?.all_clear
                ? "Everyone on this project is approved for payment"
                : "Project payment readiness"}
            </h3>
            <p>
              {project?.vendor_count
                ? `${project.vendor_count} vendor${project.vendor_count === 1 ? "" : "s"} assigned to this project.`
                : "No vendors assigned to this project yet."}
            </p>
          </div>
        </div>
        <p style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted, #6b7280)" }}>
          Statuses below are informational flags based on documents on file and your configured
          criteria. Review source documents and verify coverage with your insurance agent or broker
          before making payment or coverage decisions.
        </p>

        {message && <div className="success-message" style={{ marginBottom: 12 }}>{message}</div>}

        {vendors.length === 0 ? (
          <div className="readiness-empty">
            No vendors assigned yet. Use <strong>+ Assign Vendors</strong> to add the vendors working on
            this project.
          </div>
        ) : (
          <div className="readiness-table-wrap mobile-cards">
            <table className="readiness-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Company</th>
                  <th>Compliance</th>
                  <th>Payment</th>
                  <th>Score</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) => (
                  <tr key={v.id}>
                    <td data-label="Vendor"><Link to={`/app/vendors/${v.id}`}>{v.name}</Link></td>
                    <td data-label="Company">{v.client_name || "—"}</td>
                    <td data-label="Compliance">{statusBadge(v.compliance_status)}</td>
                    <td data-label="Payment">{paymentBadge(v.payment_status)}</td>
                    <td data-label="Score">
                      <ComplianceScore score={v.compliance_score} label={v.score_label} />
                    </td>
                    <td data-label="Actions">
                      <button className="btn btn-sm btn-outline" onClick={() => handleRemove(v)}>
                        Remove from Project
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Assign vendors modal ── */}
      {showAssign && (
        <div className="modal-overlay" onClick={() => setShowAssign(false)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Assign Vendors to {project?.name}</h3>
              <button className="btn-close" onClick={() => setShowAssign(false)}>✕</button>
            </div>
            <div className="modal-body">
              {assignError && <div className="error-message">{assignError}</div>}
              {assignLoading ? (
                <div className="loading">Loading vendors…</div>
              ) : candidates.length === 0 ? (
                <p className="text-muted">
                  {allVendors.length === 0
                    ? "No vendors yet — add vendors first, then assign them to this project."
                    : "Every matching vendor is already assigned to this project."}
                </p>
              ) : (
                <>
                  <div className="form-group">
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Search vendors…"
                      value={assignSearch}
                      onChange={(e) => setAssignSearch(e.target.value)}
                    />
                  </div>
                  <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border, #e5e7eb)", borderRadius: 8 }}>
                    {candidates.map((v) => (
                      <label
                        key={v.id}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid var(--border, #f3f4f6)", cursor: "pointer" }}
                      >
                        <input
                          type="checkbox"
                          checked={selected.includes(v.id)}
                          onChange={(e) =>
                            setSelected((current) =>
                              e.target.checked ? [...current, v.id] : current.filter((x) => x !== v.id),
                            )
                          }
                        />
                        <span style={{ flex: 1 }}>{v.name}</span>
                        <span className="text-muted text-sm">{v.client_name || "—"}</span>
                        {statusBadge(v.payment_status)}
                      </label>
                    ))}
                  </div>
                  <p className="text-muted text-sm" style={{ marginTop: 8 }}>
                    {selected.length} selected
                  </p>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowAssign(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={selected.length === 0 || assigning} onClick={handleAssign}>
                {assigning ? "Assigning…" : `Assign ${selected.length || ""}`.trim()}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
