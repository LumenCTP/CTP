import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../lib/api";
import { openFileInNewTab } from "../lib/files";
import type { ExtractionUpdateBody } from "@clear-to-pay/shared";

interface ReviewItem {
  id: number;
  vendor_id: number;
  client_id: number;
  vendor_name: string | null;
  client_name: string | null;
  document_type: string;
  file_path: string;
  original_filename: string;
  sender_name: string | null;
  sender_email: string | null;
  received_date: string;
  created_at: string;
  ai_confidence_score: number;
  is_reviewed: boolean;
  insurance_carrier: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  certificate_holder: string | null;
  extracted_document_type: string | null;
  extraction_id: number;
  extracted_vendor_name: string | null;
  producer_name: string | null;
  producer_contact: string | null;
  producer_email: string | null;
  producer_phone: string | null;
}

interface ReviewFormData {
  vendor_name: string;
  insurance_carrier: string;
  policy_number: string;
  effective_date: string;
  expiration_date: string;
  certificate_holder: string;
  document_type: string;
  // Producer block (ACORD COI agency/agent contact) — preferred recipient for
  // renewal reminders when an email is present.
  producer_name: string;
  producer_contact: string;
  producer_email: string;
  producer_phone: string;
  // Manual entity assignment — reviewer can attach an unassigned document to a
  // vendor/client from the tenant's lists (null = unassigned/no match).
  vendor_id: number | null;
  client_id: number | null;
}

interface VendorOption {
  id: number;
  name: string;
  client_id: number;
  client_name: string | null;
}

interface ClientOption {
  id: number;
  name: string;
}

function confidenceColor(score: number): string {
  if (score >= 85) return "var(--green)";
  if (score >= 70) return "var(--amber)";
  return "var(--red)";
}

export default function NeedsReview() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Review modal
  const [reviewingItem, setReviewingItem] = useState<ReviewItem | null>(null);
  const [form, setForm] = useState<ReviewFormData>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null);

  // Tenant's vendors/clients for the assignment pickers (searchable selects)
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [vendorSearch, setVendorSearch] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  // Original assignment when the modal opened — used to decide whether to send
  // vendor_id/client_id on save (only when changed or already assigned).
  const [initialVendorId, setInitialVendorId] = useState<number | null>(null);
  const [initialClientId, setInitialClientId] = useState<number | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await apiFetch("/api/needs-review");
      if (!res.ok) throw new Error("Failed to fetch review queue");
      const data: ReviewItem[] = await res.json();
      setItems(data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // Load the tenant's vendors/clients for the assignment pickers. Failures are
  // non-fatal — the pickers simply stay empty and review still works.
  useEffect(() => {
    apiFetch("/api/vendors")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: VendorOption[]) => setVendors(data))
      .catch(() => {});
    apiFetch("/api/clients")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ClientOption[]) => setClients(data))
      .catch(() => {});
  }, []);

  function emptyForm(): ReviewFormData {
    return {
      vendor_name: "",
      insurance_carrier: "",
      policy_number: "",
      effective_date: "",
      expiration_date: "",
      certificate_holder: "",
      document_type: "",
      producer_name: "",
      producer_contact: "",
      producer_email: "",
      producer_phone: "",
      vendor_id: null,
      client_id: null,
    };
  }

  function openReview(item: ReviewItem) {
    setReviewingItem(item);
    setForm({
      vendor_name: item.extracted_vendor_name ?? item.vendor_name ?? "",
      insurance_carrier: item.insurance_carrier ?? "",
      policy_number: item.policy_number ?? "",
      effective_date: item.effective_date ?? "",
      expiration_date: item.expiration_date ?? "",
      certificate_holder: item.certificate_holder ?? "",
      document_type: item.extracted_document_type ?? item.document_type ?? "",
      producer_name: item.producer_name ?? "",
      producer_contact: item.producer_contact ?? "",
      producer_email: item.producer_email ?? "",
      producer_phone: item.producer_phone ?? "",
      vendor_id: item.vendor_id || null,
      client_id: item.client_id || null,
    });
    setInitialVendorId(item.vendor_id || null);
    setInitialClientId(item.client_id || null);
    setVendorSearch("");
    setClientSearch("");
    setReviewError(null);
    setReviewSuccess(null);
  }

  function closeReview() {
    setReviewingItem(null);
    setForm(emptyForm());
    setInitialVendorId(null);
    setInitialClientId(null);
    setVendorSearch("");
    setClientSearch("");
    setReviewError(null);
    setReviewSuccess(null);
  }

  const filteredVendors = vendors.filter((v) =>
    v.name.toLowerCase().includes(vendorSearch.toLowerCase()),
  );
  const filteredClients = clients.filter((c) =>
    c.name.toLowerCase().includes(clientSearch.toLowerCase()),
  );

  async function handleApprove(e: React.FormEvent) {
    e.preventDefault();
    if (!reviewingItem) return;

    setReviewError(null);
    setReviewSuccess(null);
    setSaving(true);

    try {
      const body: ExtractionUpdateBody = {
        vendor_name: form.vendor_name.trim() || null,
        insurance_carrier: form.insurance_carrier.trim() || null,
        policy_number: form.policy_number.trim() || null,
        effective_date: form.effective_date.trim() || null,
        expiration_date: form.expiration_date.trim() || null,
        certificate_holder: form.certificate_holder.trim() || null,
        document_type: form.document_type.trim() || null,
        producer_name: form.producer_name.trim() || null,
        producer_contact: form.producer_contact.trim() || null,
        producer_email: form.producer_email.trim() || null,
        producer_phone: form.producer_phone.trim() || null,
        is_reviewed: true,
      };
      // Send the entity assignment only when the reviewer changed the picker or
      // the document was already assigned. Leaving an unassigned document's
      // picker untouched lets the API auto-map from the corrected names (same
      // logic as upload), instead of forcing an explicit null.
      if (form.vendor_id !== initialVendorId || initialVendorId !== null) {
        body.vendor_id = form.vendor_id ? Number(form.vendor_id) : null;
      }
      if (form.client_id !== initialClientId || initialClientId !== null) {
        body.client_id = form.client_id ? Number(form.client_id) : null;
      }

      const res = await apiFetch(`/api/documents/${reviewingItem.id}/extraction`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Update failed");
      }

      setReviewSuccess("Document approved and moved out of review queue.");
      setReviewingItem(null);

      // Refresh list
      await fetchItems();
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <h2 className="page-title">Needs Review</h2>
        <div className="loading">Loading review queue…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <h2 className="page-title">Needs Review</h2>
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2 className="page-title">Needs Review</h2>
        <span
          style={{
            background: items.length > 0 ? "var(--red)" : "var(--green)",
            color: "#fff",
            padding: "4px 12px",
            borderRadius: "9999px",
            fontSize: "0.8rem",
            fontWeight: 600,
          }}
        >
          {items.length} pending
        </span>
      </div>

      {items.length === 0 ? (
        <div
          style={{
            background: "var(--green-light)",
            color: "var(--green)",
            padding: "16px 20px",
            borderRadius: "10px",
            fontSize: "0.95rem",
            fontWeight: 500,
          }}
        >
          ✓ All documents have been reviewed. Nothing needs attention.
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Vendor</th>
                <th>Client</th>
                <th>Doc Type</th>
                <th>Confidence</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="td-name" style={{ maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <a className="document-name-link" href={`/app/documents/${item.id}`}>
                      {item.original_filename}
                    </a>
                  </td>
                  <td>{item.extracted_vendor_name ?? item.vendor_name ?? "—"}</td>
                  <td>{item.client_name ?? "—"}</td>
                  <td>
                    <span className="doc-tag">
                      {item.extracted_document_type ?? item.document_type}
                    </span>
                  </td>
                  <td>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 10px",
                        borderRadius: "9999px",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                        color: confidenceColor(item.ai_confidence_score),
                        background:
                          item.ai_confidence_score >= 85
                            ? "var(--green-light)"
                            : item.ai_confidence_score >= 70
                              ? "var(--amber-light)"
                              : "var(--red-light)",
                      }}
                    >
                      {item.ai_confidence_score}%
                    </span>
                  </td>
                  <td className="text-muted text-sm">
                    {item.received_date
                      ? new Date(item.received_date).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="td-actions">
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        openFileInNewTab(`/api/documents/${item.id}/file`, item.original_filename || "document").catch(
                          (err) => setReviewError(err instanceof Error ? err.message : String(err)),
                        );
                      }}
                    >
                      📄 View
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => openReview(item)}
                    >
                      ✏ Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Review Modal ── */}
      {reviewingItem && (
        <div className="modal-overlay" onClick={closeReview}>
          <div
            className="modal"
            style={{ maxWidth: "560px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Review Extraction</h3>
              <button className="btn-close" onClick={closeReview}>
                ✕
              </button>
            </div>
            <form onSubmit={handleApprove}>
              <div className="modal-body">
                <p className="text-muted text-sm" style={{ marginBottom: "12px" }}>
                  Document:{" "}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      openFileInNewTab(`/api/documents/${reviewingItem.id}/file`, reviewingItem.original_filename || "document").catch(
                        (err) => setReviewError(err instanceof Error ? err.message : String(err)),
                      );
                    }}
                    style={{ color: "var(--blue)", fontWeight: 600 }}
                  >
                    {reviewingItem.original_filename}
                  </a>
                  {" "}| AI Confidence:{" "}
                  <span
                    style={{
                      fontWeight: 600,
                      color: confidenceColor(reviewingItem.ai_confidence_score),
                    }}
                  >
                    {reviewingItem.ai_confidence_score}%
                  </span>
                </p>

                {reviewError && <div className="error-message">{reviewError}</div>}

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "12px",
                    marginBottom: "12px",
                    padding: "12px",
                    background: "var(--bg-soft, #f8fafc)",
                    borderRadius: "8px",
                    border: "1px dashed var(--border, #d1d5db)",
                  }}
                >
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Assign to Vendor (optional)</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Search vendors…"
                      value={vendorSearch}
                      onChange={(e) => setVendorSearch(e.target.value)}
                      style={{ marginBottom: 6 }}
                    />
                    <select
                      className="form-input"
                      value={form.vendor_id ? String(form.vendor_id) : ""}
                      onChange={(e) => {
                        const vid = e.target.value ? Number(e.target.value) : null;
                        const next = { ...form, vendor_id: vid };
                        // Auto-set the client from the vendor's client when a
                        // vendor is chosen — a vendor assigned without a client
                        // would otherwise bypass compliance requirements.
                        if (vid) {
                          const v = vendors.find((x) => x.id === vid);
                          if (v) next.client_id = v.client_id;
                        }
                        setForm(next);
                      }}
                    >
                      <option value="">— Unassigned (no vendor) —</option>
                      {filteredVendors.map((v) => (
                        <option key={v.id} value={String(v.id)}>
                          {v.name}
                          {v.client_name ? ` (${v.client_name})` : ""}
                        </option>
                      ))}
                    </select>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                      Picking a vendor assigns this document to it immediately.
                    </p>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Assign to Client (optional)</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Search clients…"
                      value={clientSearch}
                      onChange={(e) => setClientSearch(e.target.value)}
                      style={{ marginBottom: 6 }}
                    />
                    <select
                      className="form-input"
                      value={form.client_id ? String(form.client_id) : ""}
                      onChange={(e) =>
                        setForm({ ...form, client_id: e.target.value ? Number(e.target.value) : null })
                      }
                    >
                      <option value="">— Unassigned (no client) —</option>
                      {filteredClients.map((c) => (
                        <option key={c.id} value={String(c.id)}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                      Auto-filled from the vendor; override if needed.
                    </p>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div className="form-group">
                    <label>Vendor Name</label>
                    <input
                      type="text"
                      className="form-input"
                      value={form.vendor_name}
                      onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Document Type</label>
                    <input
                      type="text"
                      className="form-input"
                      value={form.document_type}
                      onChange={(e) => setForm({ ...form, document_type: e.target.value })}
                      placeholder="COI, W-9, etc."
                    />
                  </div>
                  <div className="form-group">
                    <label>Insurance Carrier</label>
                    <input
                      type="text"
                      className="form-input"
                      value={form.insurance_carrier}
                      onChange={(e) => setForm({ ...form, insurance_carrier: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Policy Number</label>
                    <input
                      type="text"
                      className="form-input"
                      value={form.policy_number}
                      onChange={(e) => setForm({ ...form, policy_number: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Effective Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={form.effective_date}
                      onChange={(e) => setForm({ ...form, effective_date: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Expiration Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={form.expiration_date}
                      onChange={(e) => setForm({ ...form, expiration_date: e.target.value })}
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>Certificate Holder</label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.certificate_holder}
                    onChange={(e) => setForm({ ...form, certificate_holder: e.target.value })}
                  />
                </div>
                <div
                  style={{
                    marginTop: "12px",
                    padding: "12px",
                    background: "var(--bg-soft, #f8fafc)",
                    borderRadius: "8px",
                    border: "1px dashed var(--border, #d1d5db)",
                  }}
                >
                  <p
                    style={{
                      margin: "0 0 8px",
                      fontSize: "12px",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-muted, #6b7280)",
                    }}
                  >
                    Producer (COI agency/agent — top-right of the certificate)
                  </p>
                  <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-muted, #6b7280)" }}>
                    Renewal reminders for this document go to the producer email when present.
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <div className="form-group">
                      <label>Producer / Agency Name</label>
                      <input
                        type="text"
                        className="form-input"
                        value={form.producer_name}
                        onChange={(e) => setForm({ ...form, producer_name: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label>Contact Person</label>
                      <input
                        type="text"
                        className="form-input"
                        value={form.producer_contact}
                        onChange={(e) => setForm({ ...form, producer_contact: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label>Producer Email</label>
                      <input
                        type="email"
                        className="form-input"
                        value={form.producer_email}
                        onChange={(e) => setForm({ ...form, producer_email: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label>Producer Phone</label>
                      <input
                        type="text"
                        className="form-input"
                        value={form.producer_phone}
                        onChange={(e) => setForm({ ...form, producer_phone: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={closeReview}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving}
                >
                  {saving ? "Saving…" : "✓ Approve"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
