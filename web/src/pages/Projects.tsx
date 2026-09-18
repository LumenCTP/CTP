import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

/**
 * Projects — group vendors by jobsite so the client can answer
 * "is everyone on Project X clear to pay?".
 *
 * The list endpoint (GET /api/projects) already returns the readiness summary
 * (vendor count + approved/review/hold counts) computed from the same
 * compliance engine the dashboard and weekly report use, so this page never
 * recalculates anything. Counts are a flagging aid: the client still reviews the
 * source documents and verifies coverage.
 */
interface ProjectSummary {
  id: number;
  name: string;
  vendor_count: number;
  approved_count: number;
  review_count: number;
  hold_count: number;
  all_clear: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Create/rename modal state. */
interface FormState {
  open: boolean;
  editing: ProjectSummary | null;
  name: string;
  saving: boolean;
  error: string | null;
}

const closedForm: FormState = { open: false, editing: null, name: "", saving: false, error: null };

export default function Projects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(closedForm);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [rowMessage, setRowMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch("/api/projects")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch projects");
        return res.json();
      })
      .then((data) => {
        setProjects(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || "Failed to fetch projects");
        setLoading(false);
      });
  }, []);

  useEffect(load, [load]);

  function openCreate() {
    setForm({ open: true, editing: null, name: "", saving: false, error: null });
  }

  function openRename(project: ProjectSummary) {
    setForm({ open: true, editing: project, name: project.name, saving: false, error: null });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setForm((f) => ({ ...f, error: "Project name is required" }));
      return;
    }
    setForm((f) => ({ ...f, saving: true, error: null }));
    try {
      const res = await apiFetch(
        form.editing ? `/api/projects/${form.editing.id}` : "/api/projects",
        {
          method: form.editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      setForm(closedForm);
      setRowMessage(form.editing ? `Renamed project to "${name}".` : `Project "${name}" created.`);
      load();
    } catch (err) {
      setForm((f) => ({ ...f, saving: false, error: err instanceof Error ? err.message : "Save failed" }));
    }
  }

  async function handleDelete(project: ProjectSummary) {
    setDeleteBusy(true);
    try {
      const res = await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Delete failed");
      }
      setDeleting(null);
      setRowMessage(`Project "${project.name}" deleted. Its vendors were not affected.`);
      load();
    } catch (err) {
      setRowMessage(`Error: ${err instanceof Error ? err.message : "Delete failed"}`);
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  /** One-line readiness read for a project row. */
  function readinessText(p: ProjectSummary): string {
    if (p.vendor_count === 0) return "No vendors assigned yet";
    if (p.all_clear) return `All ${p.vendor_count} approved for payment`;
    const parts: string[] = [];
    if (p.approved_count) parts.push(`${p.approved_count} approved`);
    if (p.review_count) parts.push(`${p.review_count} review`);
    if (p.hold_count) parts.push(`${p.hold_count} hold`);
    return parts.join(" · ");
  }

  return (
    <div className="dashboard">
      <div className="dashboard-heading">
        <h2 className="page-title">Projects</h2>
        <div className="dashboard-heading-actions">
          <button className="btn btn-primary" onClick={openCreate}>+ New Project</button>
        </div>
      </div>
      <p className="page-subtitle">
        Group vendors by jobsite to see at a glance whether everyone on a project is clear to pay.
      </p>

      {rowMessage && <div className="success-message" style={{ marginBottom: 12 }}>{rowMessage}</div>}

      {loading && <div className="loading">Loading projects…</div>}

      {!loading && error && (
        <>
          <div className="error-message">Error: {error}</div>
          <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={load}>
            Try again
          </button>
        </>
      )}

      {!loading && !error && (
        <>
          <p style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted, #6b7280)" }}>
            Payment readiness below is an informational flag based on the documents on file and your
            configured criteria. Review the source documents and verify coverage with your insurance
            agent or broker before making payment or coverage decisions.
          </p>

          {projects.length === 0 ? (
            <div className="clear-to-pay-card">
              <div className="readiness-empty">
                No projects yet. Create a project (for example "Maple St. Remodel"), then assign the
                vendors working on it.
              </div>
            </div>
          ) : (
            <div className="table-wrapper mobile-cards">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Vendors</th>
                    <th>Approved</th>
                    <th>Review</th>
                    <th>Hold</th>
                    <th>Readiness</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td className="td-name" data-label="Project">
                        <Link to={`/app/projects/${p.id}`}>{p.name}</Link>
                      </td>
                      <td data-label="Vendors">{p.vendor_count}</td>
                      <td data-label="Approved">
                        <span className="badge badge-approved">{p.approved_count}</span>
                      </td>
                      <td data-label="Review">
                        <span className="badge badge-review">{p.review_count}</span>
                      </td>
                      <td data-label="Hold">
                        <span className="badge badge-hold">{p.hold_count}</span>
                      </td>
                      <td data-label="Readiness">{readinessText(p)}</td>
                      <td className="td-actions">
                        <Link className="btn btn-sm btn-outline" to={`/app/projects/${p.id}`}>
                          View
                        </Link>
                        <button className="btn btn-sm btn-outline" onClick={() => openRename(p)}>
                          ✏ Rename
                        </button>
                        <button className="btn btn-sm btn-danger-outline" onClick={() => setDeleting(p)}>
                          🗑 Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Create / Rename modal ── */}
      {form.open && (
        <div className="modal-overlay" onClick={() => setForm(closedForm)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{form.editing ? "Rename Project" : "New Project"}</h3>
              <button className="btn-close" onClick={() => setForm(closedForm)}>✕</button>
            </div>
            <form onSubmit={handleSave}>
              <div className="modal-body">
                {form.error && <div className="error-message">{form.error}</div>}
                <div className="form-group">
                  <label htmlFor="project-name">Project name *</label>
                  <input
                    id="project-name"
                    type="text"
                    className="form-input"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Maple St. Remodel"
                    autoFocus
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setForm(closedForm)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={form.saving}>
                  {form.saving ? "Saving…" : form.editing ? "Save Name" : "Create Project"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete confirmation ── */}
      {deleting && (
        <div className="modal-overlay" onClick={() => setDeleting(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete Project</h3>
            </div>
            <div className="modal-body">
              <p>
                Delete <strong>{deleting.name}</strong>?
              </p>
              <p className="text-muted text-sm">
                Its {deleting.vendor_count} vendor{deleting.vendor_count === 1 ? "" : "s"} stay in your
                vendor list — only the grouping is removed. Vendor documents, compliance status and
                history are not affected.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn btn-danger" disabled={deleteBusy} onClick={() => handleDelete(deleting)}>
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
