import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { downloadFile } from "../lib/files";
import { useEffect, useState, useCallback } from "react";
import type {
  VendorListItem,
  ClientWithRequiredDocs,
  ComplianceDetailResponse,
  RecalculateSummary,
} from "@clear-to-pay/shared";

interface VendorFormData {
  client_id: number;
  name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
}

const emptyForm: VendorFormData = {
  client_id: 0,
  name: "",
  contact_name: "",
  contact_email: "",
  contact_phone: "",
};

function statusBadge(status: string) {
  const safe = status || "needs_review";
  return <span className={`badge badge-${safe}`}>{safe.replace(/_/g, " ")}</span>;
}

export default function Vendors() {
  const [vendors, setVendors] = useState<VendorListItem[]>([]);
  const [clients, setClients] = useState<ClientWithRequiredDocs[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter
  const [filterClientId, setFilterClientId] = useState<number | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingVendor, setEditingVendor] = useState<VendorListItem | null>(null);
  const [form, setForm] = useState<VendorFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importClientId, setImportClientId] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; errors: Array<{ row: number; error: string }> } | null>(null);

  async function handleImport() {
    if (!importFile || !importClientId) return;
    setImporting(true); setImportResult(null);
    const data = new FormData(); data.append("file", importFile); data.append("client_id", String(importClientId));
    try { const res = await apiFetch("/api/import/vendors", { method: "POST", body: data }); const result = await res.json(); if (!res.ok) throw new Error(result.error || "Import failed"); setImportResult(result); await fetchVendors(filterClientId); }
    catch (e) { setImportResult({ imported: 0, errors: [{ row: 0, error: e instanceof Error ? e.message : "Import failed" }] }); }
    finally { setImporting(false); }
  }

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Recalculate
  const [recalculating, setRecalculating] = useState(false);
  const [recalcMessage, setRecalcMessage] = useState<string | null>(null);

  // Compliance detail modal
  const [complianceDetail, setComplianceDetail] = useState<ComplianceDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // ── Fetch clients ────────────────────────────

  const fetchClients = useCallback(async () => {
    try {
      const res = await apiFetch("/api/clients");
      if (!res.ok) throw new Error("Failed to fetch clients");
      const data: ClientWithRequiredDocs[] = await res.json();
      setClients(data);
    } catch {
      // silently ignore — vendors page still works
    }
  }, []);

  // ── Fetch vendors ────────────────────────────

  const fetchVendors = useCallback(async (clientId: number | null) => {
    try {
      let url = "/api/vendors";
      if (clientId) {
        url += `?client_id=${clientId}`;
      }
      const res = await apiFetch(url);
      if (!res.ok) throw new Error("Failed to fetch vendors");
      const data: VendorListItem[] = await res.json();
      setVendors(data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  useEffect(() => {
    setLoading(true);
    fetchVendors(filterClientId);
  }, [filterClientId, fetchVendors]);

  // ── Recalculate Compliance ────────────────────

  async function handleRecalculate() {
    setRecalculating(true);
    setRecalcMessage(null);
    try {
      const body: Record<string, number> = {};
      if (filterClientId) {
        body.client_id = filterClientId;
      }
      const res = await apiFetch("/api/compliance/recalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Recalculation failed");
      }
      const summary: RecalculateSummary = await res.json();
      setRecalcMessage(
        `Recalculated: ${summary.approved} approved, ${summary.review} review, ${summary.hold} hold`
      );
      // Refresh the vendor list
      await fetchVendors(filterClientId);
    } catch (err) {
      setRecalcMessage(
        `Error: ${err instanceof Error ? err.message : "Recalculation failed"}`
      );
    } finally {
      setRecalculating(false);
    }
  }

  // ── Compliance Detail ─────────────────────────

  async function openComplianceDetail(vendor: VendorListItem) {
    setLoadingDetail(true);
    setComplianceDetail(null);
    try {
      const res = await apiFetch(`/api/vendors/${vendor.id}/compliance-detail`);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to load compliance detail");
      }
      const data: ComplianceDetailResponse = await res.json();
      setComplianceDetail(data);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to load compliance detail");
    } finally {
      setLoadingDetail(false);
    }
  }

  function closeComplianceDetail() {
    setComplianceDetail(null);
  }

  // ── Modal helpers ────────────────────────────

  function openAddModal() {
    setEditingVendor(null);
    setForm(emptyForm);
    setFormError(null);
    setShowModal(true);
  }

  function openEditModal(vendor: VendorListItem) {
    setEditingVendor(vendor);
    setForm({
      client_id: vendor.client_id,
      name: vendor.name,
      contact_name: vendor.contact_name ?? "",
      contact_email: vendor.contact_email ?? "",
      contact_phone: vendor.contact_phone ?? "",
    });
    setFormError(null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingVendor(null);
    setForm(emptyForm);
    setFormError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim()) {
      setFormError("Vendor name is required");
      return;
    }

    if (!form.client_id) {
      setFormError("Please select a client");
      return;
    }

    setSaving(true);
    try {
      const url = editingVendor
        ? `/api/vendors/${editingVendor.id}`
        : "/api/vendors";
      const method = editingVendor ? "PUT" : "POST";

      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: form.client_id,
          name: form.name.trim(),
          contact_name: form.contact_name.trim() || null,
          contact_email: form.contact_email.trim() || null,
          contact_phone: form.contact_phone.trim() || null,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Save failed");
      }

      await fetchVendors(filterClientId);
      closeModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ── Delete ────────────────────────────────────

  async function handleDelete(id: number) {
    try {
      const res = await apiFetch(`/api/vendors/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Delete failed");
      }
      setDeletingId(null);
      await fetchVendors(filterClientId);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  }

  // ── Render ────────────────────────────────────

  if (loading) {
    return (
      <div className="page-container">
        <h2 className="page-title">Vendors</h2>
        <div className="loading">Loading vendors…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <h2 className="page-title">Vendors</h2>
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  const vendorToDelete =
    deletingId !== null
      ? vendors.find((v) => v.id === deletingId) ?? null
      : null;

  return (
    <div className="page-container">
      <div className="page-header">
        <h2 className="page-title">Vendors</h2>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="btn btn-outline"
            onClick={handleRecalculate}
            disabled={recalculating}
          >
            {recalculating ? "⟳ Recalculating…" : "⟳ Recalculate Compliance"}
          </button>
          <button className="btn btn-outline" onClick={() => { setShowImport(true); setImportResult(null); }}>
            Import CSV
          </button>
          <button className="btn btn-primary" onClick={openAddModal}>+ Add Vendor</button>
        </div>
      </div>

      {/* ── Recalc Message ── */}
      {recalcMessage && (
        <div className="success-message" style={{ marginBottom: "12px" }}>
          {recalcMessage}
        </div>
      )}

      {/* ── Client Filter ── */}
      <div className="filter-bar">
        <label htmlFor="vendor-client-filter">Filter by Client:</label>
        <select
          id="vendor-client-filter"
          className="form-select"
          value={filterClientId ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setFilterClientId(val ? Number(val) : null);
          }}
        >
          <option value="">All Clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* ── Vendors Table ── */}
      {vendors.length === 0 ? (
        <p className="page-subtitle">
          No vendors yet. Add your first vendor to get started.
        </p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Client</th>
                <th>Contact Email</th>
                <th>Compliance Status</th>
                <th>Payment Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((vendor) => (
                <tr key={vendor.id}>
                  <td className="td-name"><Link to={`/app/vendors/${vendor.id}`}>{vendor.name}</Link></td>
                  <td>{vendor.client_name}</td>
                  <td>{vendor.contact_email || "—"}</td>
                  <td>{statusBadge(vendor.compliance_status)}</td>
                  <td>{statusBadge(vendor.payment_status)}</td>
                  <td className="td-actions">
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => openComplianceDetail(vendor)}
                    >
                      📋 Detail
                    </button>
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => openEditModal(vendor)}
                    >
                      ✏ Edit
                    </button>
                    <button
                      className="btn btn-sm btn-danger-outline"
                      onClick={() => setDeletingId(vendor.id)}
                    >
                      🗑 Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Add/Edit Modal ── */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingVendor ? "Edit Vendor" : "Add Vendor"}</h3>
              <button className="btn-close" onClick={closeModal}>
                ✕
              </button>
            </div>
            <form onSubmit={handleSave}>
              <div className="modal-body">
                {formError && <div className="error-message">{formError}</div>}
                <div className="form-group">
                  <label htmlFor="vendor-client">Client *</label>
                  <select
                    id="vendor-client"
                    className="form-select"
                    style={{ width: "100%" }}
                    value={form.client_id || ""}
                    onChange={(e) =>
                      setForm({ ...form, client_id: Number(e.target.value) })
                    }
                  >
                    <option value="" disabled>
                      Select a client…
                    </option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="vendor-name">Name *</label>
                  <input
                    id="vendor-name"
                    type="text"
                    className="form-input"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Vendor name"
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="vendor-contact-name">Contact Name</label>
                  <input
                    id="vendor-contact-name"
                    type="text"
                    className="form-input"
                    value={form.contact_name}
                    onChange={(e) =>
                      setForm({ ...form, contact_name: e.target.value })
                    }
                    placeholder="Primary contact"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="vendor-contact-email">Contact Email</label>
                  <input
                    id="vendor-contact-email"
                    type="email"
                    className="form-input"
                    value={form.contact_email}
                    onChange={(e) =>
                      setForm({ ...form, contact_email: e.target.value })
                    }
                    placeholder="email@example.com"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="vendor-contact-phone">Contact Phone</label>
                  <input
                    id="vendor-contact-phone"
                    type="text"
                    className="form-input"
                    value={form.contact_phone}
                    onChange={(e) =>
                      setForm({ ...form, contact_phone: e.target.value })
                    }
                    placeholder="555-0100"
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={closeModal}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving}
                >
                  {saving
                    ? "Saving…"
                    : editingVendor
                      ? "Save Changes"
                      : "Create Vendor"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Compliance Detail Modal ── */}
      {complianceDetail && (
        <div className="modal-overlay" onClick={closeComplianceDetail}>
          <div
            className="modal modal-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Compliance Detail — {complianceDetail.vendor_name}</h3>
              <button className="btn-close" onClick={closeComplianceDetail}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="compliance-summary" style={{ marginBottom: "16px" }}>
                <p>
                  <strong>Client:</strong> {complianceDetail.client_name}
                </p>
                <p>
                  <strong>Overall Status:</strong>{" "}
                  {statusBadge(complianceDetail.status)}
                </p>
                <p>
                  <strong>Payment Status:</strong>{" "}
                  {statusBadge(complianceDetail.payment_status)}
                </p>
              </div>

              <h4 style={{ marginBottom: "8px" }}>Required Documents</h4>
              {complianceDetail.details.length === 0 ? (
                <p className="text-muted">No document requirements configured for this client.</p>
              ) : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Document Type</th>
                        <th>Status</th>
                        <th>Expiration Date</th>
                        <th>Has Unreviewed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {complianceDetail.details.map((d) => (
                        <tr key={d.document_type}>
                          <td className="td-name">{d.document_type}</td>
                          <td>{statusBadge(d.status)}</td>
                          <td>{d.expiration_date || "—"}</td>
                          <td>{d.has_unreviewed ? "⚠ Yes" : "✓ No"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-outline"
                onClick={closeComplianceDetail}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)}><div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header"><h3>Import Vendors CSV</h3><button className="btn-close" onClick={() => setShowImport(false)}>✕</button></div>
          <div className="modal-body"><div className="form-group"><label>Client *</label><select className="form-select" value={importClientId || ""} onChange={(e) => setImportClientId(Number(e.target.value))}><option value="" disabled>Select a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <p className="text-muted text-sm">Columns: name, contact_name, contact_email, contact_phone</p><div className="form-group"><input type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} /></div>
            <button
              type="button"
              className="link-button"
              style={{ padding: 0, border: "none", background: "none", color: "var(--blue)", cursor: "pointer", textDecoration: "underline", fontSize: "0.875rem" }}
              onClick={() =>
                downloadFile("/api/import/vendors-template", "vendors-template.csv").catch((err) =>
                  alert(err instanceof Error ? err.message : "Download failed"),
                )
              }
            >
              Download Template
            </button>
            {importResult && <div className={importResult.errors.length ? "error-message" : "success-message"} style={{ marginTop: 12 }}><strong>{importResult.imported} imported</strong>{importResult.errors.length > 0 && <ul>{importResult.errors.map((x, i) => <li key={i}>Row {x.row}: {x.error}</li>)}</ul>}</div>}
          </div><div className="modal-footer"><button className="btn btn-outline" onClick={() => setShowImport(false)}>Close</button><button className="btn btn-primary" onClick={handleImport} disabled={!importFile || !importClientId || importing}>{importing ? "Importing…" : "Import"}</button></div>
        </div></div>
      )}

      {/* ── Delete Confirmation ── */}
      {deletingId !== null && vendorToDelete && (
        <div className="modal-overlay" onClick={() => setDeletingId(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete Vendor</h3>
            </div>
            <div className="modal-body">
              <p>
                Are you sure you want to delete{" "}
                <strong>{vendorToDelete.name}</strong>?
              </p>
              <p className="text-muted text-sm">
                This will permanently delete the vendor and all associated
                documents, extractions, and compliance records.
              </p>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-outline"
                onClick={() => setDeletingId(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => handleDelete(deletingId)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
