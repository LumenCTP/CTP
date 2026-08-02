import { useEffect, useState, useCallback } from "react";
import type { ClientWithRequiredDocs, DocumentType } from "@clear-to-pay/shared";
import { ALL_DOCUMENT_TYPES } from "@clear-to-pay/shared";

interface ClientFormData {
  name: string;
  contact_email: string;
  contact_phone: string;
  address: string;
}

const emptyForm: ClientFormData = {
  name: "",
  contact_email: "",
  contact_phone: "",
  address: "",
};

export default function Clients() {
  const [clients, setClients] = useState<ClientWithRequiredDocs[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingClient, setEditingClient] = useState<ClientWithRequiredDocs | null>(null);
  const [form, setForm] = useState<ClientFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Required docs panel
  const [docsClientId, setDocsClientId] = useState<number | null>(null);
  const [docsSaving, setDocsSaving] = useState<Record<string, boolean>>({});

  // Email settings panel
  const [emailClientId, setEmailClientId] = useState<number | null>(null);
  const [emailConfig, setEmailConfig] = useState<{
    weekly_report_recipients: string;
    monthly_report_recipients: string;
    renewal_reminders_enabled: boolean;
  }>({ weekly_report_recipients: "", monthly_report_recipients: "", renewal_reminders_enabled: true });
  const [emailConfigSaving, setEmailConfigSaving] = useState(false);
  const [emailTestSending, setEmailTestSending] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState<string | null>(null);

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch("/api/clients");
      if (!res.ok) throw new Error("Failed to fetch clients");
      const data: ClientWithRequiredDocs[] = await res.json();
      setClients(data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  // ── Modal helpers ──

  function openAddModal() {
    setEditingClient(null);
    setForm(emptyForm);
    setFormError(null);
    setShowModal(true);
  }

  function openEditModal(client: ClientWithRequiredDocs) {
    setEditingClient(client);
    setForm({
      name: client.name,
      contact_email: client.contact_email ?? "",
      contact_phone: client.contact_phone ?? "",
      address: client.address ?? "",
    });
    setFormError(null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingClient(null);
    setForm(emptyForm);
    setFormError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim()) {
      setFormError("Name is required");
      return;
    }

    setSaving(true);
    try {
      const url = editingClient
        ? `/api/clients/${editingClient.id}`
        : "/api/clients";
      const method = editingClient ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          contact_email: form.contact_email.trim() || null,
          contact_phone: form.contact_phone.trim() || null,
          address: form.address.trim() || null,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Save failed");
      }

      await fetchClients();
      closeModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ── Delete ──

  async function handleDelete(id: number) {
    try {
      const res = await fetch(`/api/clients/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Delete failed");
      }
      setDeletingId(null);
      await fetchClients();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  }

  // ── Required Docs ──

  function toggleDocsPanel(clientId: number) {
    setDocsClientId((prev) => (prev === clientId ? null : clientId));
  }

  async function toggleDocumentType(clientId: number, docType: DocumentType) {
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;

    const hasDoc = client.required_documents.includes(docType);
    const newDocTypes = hasDoc
      ? client.required_documents.filter((d) => d !== docType)
      : [...client.required_documents, docType];

    const key = `${clientId}-${docType}`;
    setDocsSaving((prev) => ({ ...prev, [key]: true }));

    try {
      const res = await fetch(`/api/clients/${clientId}/documents-required`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_types: newDocTypes }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to update");
      }

      await fetchClients();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Update failed");
    } finally {
      setDocsSaving((prev) => ({ ...prev, [key]: false }));
    }
  }

  // ── Email Settings ──

  async function openEmailPanel(clientId: number) {
    setEmailClientId(clientId);
    setEmailFeedback(null);

    try {
      const res = await fetch(`/api/emails/config/${clientId}`);
      if (!res.ok) throw new Error("Failed to fetch email config");
      const data = await res.json();
      setEmailConfig({
        weekly_report_recipients: data.weekly_report_recipients ?? "",
        monthly_report_recipients: data.monthly_report_recipients ?? "",
        renewal_reminders_enabled: data.renewal_reminders_enabled !== 0,
      });
    } catch {
      // Fallback to defaults
      setEmailConfig({ weekly_report_recipients: "", monthly_report_recipients: "", renewal_reminders_enabled: true });
    }
  }

  async function saveEmailConfig() {
    if (!emailClientId) return;
    setEmailConfigSaving(true);
    setEmailFeedback(null);

    try {
      const res = await fetch(`/api/emails/config/${emailClientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekly_report_recipients: emailConfig.weekly_report_recipients.trim() || null,
          monthly_report_recipients: emailConfig.monthly_report_recipients.trim() || null,
          renewal_reminders_enabled: emailConfig.renewal_reminders_enabled,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Save failed");
      }

      setEmailFeedback("Email settings saved successfully.");
    } catch (err) {
      setEmailFeedback(`Error: ${err instanceof Error ? err.message : "Save failed"}`);
    } finally {
      setEmailConfigSaving(false);
    }
  }

  async function sendTestWeekly() {
    if (!emailClientId) return;
    setEmailTestSending(true);
    setEmailFeedback(null);

    try {
      const res = await fetch(`/api/emails/test-weekly/${emailClientId}`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to send test");
      }

      setEmailFeedback(`Test weekly report sent to: ${data.recipients?.join(", ") ?? "configured recipients"}`);
    } catch (err) {
      setEmailFeedback(`Error: ${err instanceof Error ? err.message : "Send failed"}`);
    } finally {
      setEmailTestSending(false);
    }
  }

  // ── Render ──

  if (loading) {
    return (
      <div className="page-container">
        <h2 className="page-title">Clients</h2>
        <div className="loading">Loading clients…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <h2 className="page-title">Clients</h2>
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2 className="page-title">Clients</h2>
        <button className="btn btn-primary" onClick={openAddModal}>
          + Add Client
        </button>
      </div>

      {/* ── Clients Table ── */}
      {clients.length === 0 ? (
        <p className="page-subtitle">No clients yet. Add your first client to get started.</p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Required Docs</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id}>
                  <td className="td-name">{client.name}</td>
                  <td>{client.contact_email || "—"}</td>
                  <td>{client.contact_phone || "—"}</td>
                  <td>
                    <div className="docs-tags">
                      {client.required_documents.length > 0
                        ? client.required_documents.map((dt) => (
                            <span key={dt} className="doc-tag">
                              {dt}
                            </span>
                          ))
                        : <span className="text-muted">None</span>}
                    </div>
                  </td>
                  <td className="td-actions">
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => toggleDocsPanel(client.id)}
                      title="Configure Required Docs"
                    >
                      ⚙ Docs
                    </button>
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => openEmailPanel(client.id)}
                      title="Email Settings"
                    >
                      ✉ Email
                    </button>
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => openEditModal(client)}
                    >
                      ✏ Edit
                    </button>
                    <button
                      className="btn btn-sm btn-danger-outline"
                      onClick={() => setDeletingId(client.id)}
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

      {/* ── Required Docs Panel ── */}
      {docsClientId !== null && (() => {
        const client = clients.find((c) => c.id === docsClientId);
        if (!client) return null;
        return (
          <div className="docs-panel">
            <div className="docs-panel-header">
              <h3>Required Documents — {client.name}</h3>
              <button className="btn-close" onClick={() => setDocsClientId(null)}>
                ✕
              </button>
            </div>
            <div className="docs-panel-body">
              {ALL_DOCUMENT_TYPES.map((docType) => {
                const checked = client.required_documents.includes(docType);
                const key = `${client.id}-${docType}`;
                return (
                  <label key={docType} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={docsSaving[key]}
                      onChange={() => toggleDocumentType(client.id, docType)}
                    />
                    <span>{docType}</span>
                    {docsSaving[key] && <span className="saving-indicator">…</span>}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Email Settings Panel ── */}
      {emailClientId !== null && (() => {
        const client = clients.find((c) => c.id === emailClientId);
        if (!client) return null;
        return (
          <div className="docs-panel">
            <div className="docs-panel-header">
              <h3>Email Settings — {client.name}</h3>
              <button className="btn-close" onClick={() => setEmailClientId(null)}>
                ✕
              </button>
            </div>
            <div className="docs-panel-body" style={{ maxWidth: "600px" }}>
              <div className="form-group">
                <label htmlFor="email-weekly">Weekly Report Recipients</label>
                <input
                  id="email-weekly"
                  type="text"
                  className="form-input"
                  value={emailConfig.weekly_report_recipients}
                  onChange={(e) => setEmailConfig({ ...emailConfig, weekly_report_recipients: e.target.value })}
                  placeholder="user@example.com, another@example.com"
                />
                <span className="text-muted text-sm">Comma-separated email addresses</span>
              </div>
              <div className="form-group">
                <label htmlFor="email-monthly">Monthly Report Recipients</label>
                <input
                  id="email-monthly"
                  type="text"
                  className="form-input"
                  value={emailConfig.monthly_report_recipients}
                  onChange={(e) => setEmailConfig({ ...emailConfig, monthly_report_recipients: e.target.value })}
                  placeholder="user@example.com, another@example.com"
                />
                <span className="text-muted text-sm">Comma-separated email addresses</span>
              </div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={emailConfig.renewal_reminders_enabled}
                    onChange={(e) => setEmailConfig({ ...emailConfig, renewal_reminders_enabled: e.target.checked })}
                  />
                  <span>Enable automatic renewal reminders</span>
                </label>
              </div>

              {emailFeedback && (
                <div className={emailFeedback.startsWith("Error") ? "error-message" : "success-message"} style={{ marginBottom: "12px" }}>
                  {emailFeedback}
                </div>
              )}

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  className="btn btn-primary"
                  onClick={saveEmailConfig}
                  disabled={emailConfigSaving}
                >
                  {emailConfigSaving ? "Saving…" : "Save Settings"}
                </button>
                <button
                  className="btn btn-outline"
                  onClick={sendTestWeekly}
                  disabled={emailTestSending}
                >
                  {emailTestSending ? "Sending…" : "Send Test Weekly Report"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Add/Edit Modal ── */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingClient ? "Edit Client" : "Add Client"}</h3>
              <button className="btn-close" onClick={closeModal}>
                ✕
              </button>
            </div>
            <form onSubmit={handleSave}>
              <div className="modal-body">
                {formError && <div className="error-message">{formError}</div>}
                <div className="form-group">
                  <label htmlFor="client-name">Name *</label>
                  <input
                    id="client-name"
                    type="text"
                    className="form-input"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Client name"
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="client-email">Contact Email</label>
                  <input
                    id="client-email"
                    type="email"
                    className="form-input"
                    value={form.contact_email}
                    onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
                    placeholder="email@example.com"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="client-phone">Contact Phone</label>
                  <input
                    id="client-phone"
                    type="text"
                    className="form-input"
                    value={form.contact_phone}
                    onChange={(e) => setForm({ ...form, contact_phone: e.target.value })}
                    placeholder="555-0100"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="client-address">Address</label>
                  <input
                    id="client-address"
                    type="text"
                    className="form-input"
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    placeholder="Street, City, State ZIP"
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={closeModal}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? "Saving…" : editingClient ? "Save Changes" : "Create Client"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation ── */}
      {deletingId !== null && (() => {
        const client = clients.find((c) => c.id === deletingId);
        return (
          <div className="modal-overlay" onClick={() => setDeletingId(null)}>
            <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Delete Client</h3>
              </div>
              <div className="modal-body">
                <p>
                  Are you sure you want to delete <strong>{client?.name}</strong>?
                </p>
                <p className="text-muted text-sm">
                  This will permanently delete the client and all associated vendors,
                  documents, and compliance records.
                </p>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline" onClick={() => setDeletingId(null)}>
                  Cancel
                </button>
                <button className="btn btn-danger" onClick={() => handleDelete(deletingId)}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
