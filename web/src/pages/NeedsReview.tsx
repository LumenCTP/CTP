import { useEffect, useState, useCallback } from "react";
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
}

interface ReviewFormData {
  vendor_name: string;
  insurance_carrier: string;
  policy_number: string;
  effective_date: string;
  expiration_date: string;
  certificate_holder: string;
  document_type: string;
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

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch("/api/needs-review");
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

  function emptyForm(): ReviewFormData {
    return {
      vendor_name: "",
      insurance_carrier: "",
      policy_number: "",
      effective_date: "",
      expiration_date: "",
      certificate_holder: "",
      document_type: "",
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
    });
    setReviewError(null);
    setReviewSuccess(null);
  }

  function closeReview() {
    setReviewingItem(null);
    setForm(emptyForm());
    setReviewError(null);
    setReviewSuccess(null);
  }

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
        is_reviewed: true,
      };

      const res = await fetch(`/api/documents/${reviewingItem.id}/extraction`, {
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
                    {item.original_filename}
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
                        window.open(`/api/documents/${item.id}/file`, "_blank");
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
                    href={`/api/documents/${reviewingItem.id}/file`}
                    target="_blank"
                    rel="noopener noreferrer"
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
