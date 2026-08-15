import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { openFileInNewTab } from "../lib/files";
import { confidencePercent } from "../lib/confidence";
import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "../components/AuthContext";
import type {
  DocumentListItem,
  ClientWithRequiredDocs,
  VendorListItem,
  IngestionStatus,
} from "@clear-to-pay/shared";

interface UploadForm {
  client_id: number | "";
  vendor_id: number | "";
}

const emptyUploadForm: UploadForm = {
  client_id: "",
  vendor_id: "",
};

function confidenceColor(score: number | null | undefined): string {
  if (score == null) return "var(--gray-400)";
  if (score >= 85) return "var(--green)";
  if (score >= 70) return "var(--amber)";
  return "var(--red)";
}

function confidenceBg(score: number | null | undefined): string {
  if (score == null) return "var(--gray-100)";
  if (score >= 85) return "var(--green-light)";
  if (score >= 70) return "var(--amber-light)";
  return "var(--red-light)";
}

function reviewBadge(isReviewed: boolean) {
  return isReviewed ? (
    <span className="badge badge-approved">Reviewed</span>
  ) : (
    <span className="badge badge-needs_review">Needs Review</span>
  );
}

function ingestionBadge(status: IngestionStatus) {
  const colors: Record<IngestionStatus, { bg: string; fg: string; label: string }> = {
    uploaded:  { bg: "var(--gray-100)", fg: "var(--gray-600)", label: "Uploaded" },
    processing:{ bg: "#fef3c7", fg: "#92400e", label: "Processing" },
    ready:     { bg: "#d1fae5", fg: "#065f46", label: "Ready" },
    error:     { bg: "#fee2e2", fg: "#991b1b", label: "Error" },
  };
  const c = colors[status] || colors.uploaded;
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: "9999px",
      fontSize: "0.75rem", fontWeight: 600, color: c.fg, background: c.bg,
    }}>
      {c.label}
    </span>
  );
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Documents() {
  const { user } = useAuth();
  const [docs, setDocs] = useState<DocumentListItem[]>([]);
  const [clients, setClients] = useState<ClientWithRequiredDocs[]>([]);
  const [vendors, setVendors] = useState<VendorListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterClientId, setFilterClientId] = useState<number | null>(null);
  const [filterNeedsReview, setFilterNeedsReview] = useState(false);

  // Upload form
  const [uploadForm, setUploadForm] = useState<UploadForm>(emptyUploadForm);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // Expanded row
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // ── Fetch data ──────────────────────────────────

  const fetchClients = useCallback(async () => {
    try {
      const res = await apiFetch("/api/clients");
      if (!res.ok) throw new Error("Failed");
      const data: ClientWithRequiredDocs[] = await res.json();
      setClients(data);
    } catch {
      // non-critical
    }
  }, []);

  const fetchVendors = useCallback(async (clientId: number | null) => {
    try {
      let url = "/api/vendors";
      if (clientId) url += `?client_id=${clientId}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error("Failed");
      const data: VendorListItem[] = await res.json();
      setVendors(data);
    } catch {
      // non-critical
    }
  }, []);

  const fetchDocs = useCallback(async () => {
    try {
      let url = "/api/documents";
      const params = new URLSearchParams();
      if (filterClientId) params.set("client_id", String(filterClientId));
      if (filterNeedsReview) params.set("needs_review", "true");
      const qs = params.toString();
      if (qs) url += `?${qs}`;

      const res = await apiFetch(url);
      if (!res.ok) throw new Error("Failed to fetch documents");
      const data: DocumentListItem[] = await res.json();
      setDocs(data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [filterClientId, filterNeedsReview]);

  useEffect(() => {
    fetchClients();
    fetchVendors(null);
  }, [fetchClients, fetchVendors]);

  useEffect(() => {
    setLoading(true);
    fetchDocs();
  }, [fetchDocs]);

  // ── Poll for ingestion status updates ────────────
  useEffect(() => {
    const hasPending = docs.some(
      (d) => d.ingestion_status === "uploaded" || d.ingestion_status === "processing"
    );
    if (!hasPending) return;

    const interval = setInterval(() => {
      fetchDocs();
    }, 5000);

    return () => clearInterval(interval);
  }, [docs, fetchDocs]);

  // ── Client change → refresh vendors ────────────

  function handleClientChange(clientId: number | "") {
    setUploadForm((f) => ({ ...f, client_id: clientId, vendor_id: "" }));
    if (clientId !== "") {
      fetchVendors(Number(clientId));
    } else {
      setVendors([]);
    }
  }

  // ── File drop zone ─────────────────────────────

  const [dragOver, setDragOver] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFilePicked(files[0]);
    }
  }

  // ── File pick (shared by Choose File, Take Photo, drag-drop) ──

  function handleFilePicked(file: File | null) {
    if (!file) return;
    // iPhone HEIC guard — iOS Safari normally delivers JPEG for capture, but if a
    // HEIC/HEIF file sneaks through, reject with a clear message (no backend support).
    const isHeic =
      file.type === "image/heic" ||
      file.type === "image/heif" ||
      file.type === "image/heic-sequence" ||
      file.type === "image/heif-sequence" ||
      /\.heic$/i.test(file.name) ||
      /\.heif$/i.test(file.name);
    if (isHeic) {
      setUploadError(
        "iPhone photos must be taken with the camera button — HEIC not supported. Use the 📷 Take Photo button, or convert to JPG/PNG and choose the file."
      );
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setUploadError(null);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFilePicked(files[0]);
    }
  }

  // Clear the input value on click so re-picking the same file/photo fires onChange.
  function handleInputClick(e: React.MouseEvent<HTMLInputElement>) {
    e.currentTarget.value = "";
  }

  // ── Upload ─────────────────────────────────────

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    setUploadSuccess(null);

    if (!selectedFile) {
      setUploadError("Please select a file");
      return;
    }

    // Validate file type
    const allowedTypes = ["application/pdf", "image/png", "image/jpeg"];
    if (!allowedTypes.includes(selectedFile.type)) {
      setUploadError("Unsupported file type. Allowed: PDF, PNG, JPG");
      return;
    }

    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    if (selectedFile.size > MAX_SIZE) {
      setUploadError("File too large. Maximum size is 10MB");
      return;
    }

    setUploading(true);
    setUploadProgress("Uploading...");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      if (uploadForm.client_id) {
        formData.append("client_id", String(uploadForm.client_id));
      }
      if (uploadForm.vendor_id) {
        formData.append("vendor_id", String(uploadForm.vendor_id));
      }

      const res = await apiFetch("/api/documents/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Upload failed");
      }

      const result = await res.json();
      setUploadSuccess(
        `Uploaded "${selectedFile.name}" — processing started`
      );
      setSelectedFile(null);
      setUploadForm(emptyUploadForm);
      if (fileInputRef.current) fileInputRef.current.value = "";

      // Refresh the document list
      await fetchDocs();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadProgress("");
    }
  }

  // ── Render ─────────────────────────────────────

  if (loading) {
    return (
      <div className="page-container">
        <h2 className="page-title">Documents</h2>
        <div className="loading">Loading documents…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <h2 className="page-title">Documents</h2>
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <h2 className="page-title">Documents</h2>

      {/* ── Upload Area ── */}
      <div
        ref={dropRef}
        className="upload-zone"
        style={{
          borderRadius: "10px",
          padding: "8px",
          marginBottom: "20px",
          background: dragOver ? "var(--blue-light)" : "var(--gray-50)",
          transition: "background 0.2s",
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className="report-config-panel"
          style={{
            background: "#fff",
            border: `1px solid ${dragOver ? "var(--blue)" : "var(--gray-200, #e5e7eb)"}`,
            borderLeft: "5px solid var(--blue)",
            borderRadius: "10px",
            boxShadow: "0 2px 8px rgba(15, 23, 42, 0.08)",
            padding: "24px",
          }}
        >
          <h3 style={{ margin: "0 0 18px", fontSize: "1.2rem" }}>📤 Upload Documents</h3>
          {user?.inbox_address && (
            <div style={{ background: "var(--blue-light, #eff6ff)", border: "1px solid var(--blue-100, #dbeafe)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "var(--blue-700, #1d4ed8)" }}>
              📧 Vendors can also email documents directly to{" "}
              <strong style={{ wordBreak: "break-all" }}>{user.inbox_address}</strong>
              <span style={{ display: "block", marginTop: 6, fontSize: 12, color: "var(--blue-600, #2563eb)" }}>
                ClearToPay stores and tracks your documents; your customer (the contractor)
                sets the compliance requirements. Contact them with questions about coverage.
              </span>
            </div>
          )}
          <form onSubmit={handleUpload} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* File picker */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                onChange={handleFileSelect}
                onClick={handleInputClick}
                style={{ display: "none" }}
                id="doc-file-input"
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileSelect}
                onClick={handleInputClick}
                style={{ display: "none" }}
                id="doc-camera-input"
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => cameraInputRef.current?.click()}
              >
                📷 Take Photo
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose File
              </button>
              <span className="text-muted text-sm" aria-live="polite" style={{ wordBreak: "break-all" }}>
                {selectedFile ? selectedFile.name : "No file selected"}
              </span>
            </div>

            {/* Photo tips */}
            <div style={{ background: "var(--gray-50, #f9fafb)", border: "1px dashed var(--gray-300, #d1d5db)", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "var(--gray-600, #4b5563)", lineHeight: 1.5 }}>
              📸 <strong>Photo tips:</strong> good lighting, flat and straight angle, all text readable and in frame. Clear photos help AI extract policy numbers and dates accurately.
            </div>

            {/* Client and vendor selectors */}
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <select
                className="form-select"
                style={{ minWidth: "180px", flex: "1 1 220px" }}
                value={uploadForm.client_id}
                onChange={(e) => handleClientChange(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">Select client (optional)…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <select
                className="form-select"
                style={{ minWidth: "180px", flex: "1 1 220px" }}
                value={uploadForm.vendor_id}
                onChange={(e) =>
                  setUploadForm({ ...uploadForm, vendor_id: e.target.value ? Number(e.target.value) : "" })
                }
                disabled={!uploadForm.client_id}
              >
                <option value="">Select vendor (optional)…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              style={{ alignSelf: "flex-start" }}
              disabled={uploading || !selectedFile}
            >
              {uploading ? "Uploading…" : "⬆ Upload Document"}
            </button>

            <p className="text-muted text-sm" style={{ margin: 0 }}>
              Supported: PDF, JPG, PNG — up to 10MB. Drag &amp; drop also works.
            </p>

            {/* Progress */}
            {uploadProgress && (
              <div className="text-sm" style={{ color: "var(--blue)" }}>
                {uploadProgress}
              </div>
            )}

            {/* Messages */}
            {uploadError && <div className="error-message">{uploadError}</div>}
            {uploadSuccess && (
              <div className="success-message" style={{ color: "var(--green)", fontSize: "0.875rem", fontWeight: 500 }}>
                ✓ {uploadSuccess}
              </div>
            )}
          </form>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="filter-bar">
        <label>Filter by Client:</label>
        <select
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

        <label style={{ marginLeft: "12px" }}>
          <input
            type="checkbox"
            checked={filterNeedsReview}
            onChange={(e) => setFilterNeedsReview(e.target.checked)}
            style={{ marginRight: "4px" }}
          />
          Needs Review Only
        </label>
      </div>

      {/* ── Documents Table ── */}
      {docs.length === 0 ? (
        <p className="page-subtitle">No documents found. Upload one above to get started.</p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Type</th>
                <th>Size</th>
                <th>Vendor</th>
                <th>Client</th>
                <th>Doc Type</th>
                <th>Ingestion</th>
                <th>Confidence</th>
                <th>Review</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  isExpanded={expandedId === doc.id}
                  onToggle={() => setExpandedId(expandedId === doc.id ? null : doc.id)}
                  onRefresh={fetchDocs}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Document Row (sub-component) ──────────────────────

function DocumentRow({
  doc,
  isExpanded,
  onToggle,
  onRefresh,
}: {
  doc: DocumentListItem;
  isExpanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  async function loadDetail() {
    if (detail) {
      setDetailError(null);
      onToggle();
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await apiFetch(`/api/documents/${doc.id}`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setDetail(data);
      setDetailLoading(false);
      onToggle();
    } catch {
      setDetailLoading(false);
      // Surface the failure inline so a fetch hiccup doesn't look like the row
      // "does nothing" (M7).
      setDetailError("Couldn't load the document details. Please try again.");
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${doc.original_filename}" permanently? This cannot be undone.`)) return;
    setDeleting(true);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/documents/${doc.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Couldn't delete the document");
      }
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't delete the document");
    } finally {
      setDeleting(false);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/documents/${doc.id}/retry-extraction`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Couldn't retry extraction");
      }
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't retry extraction");
    } finally {
      setRetrying(false);
    }
  }

  const scorePct = confidencePercent(doc.ai_confidence_score);
  const displayDocType = doc.extracted_document_type || doc.document_type;

  return (
    <>
      <tr style={{ cursor: "pointer" }} onClick={loadDetail}>
        <td className="td-name" style={{ maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <a className="document-name-link" href={`/app/documents/${doc.id}`} onClick={(e) => e.stopPropagation()}>
            {doc.original_filename}
          </a>
        </td>
        <td className="text-muted text-sm">
          {doc.content_type ? doc.content_type.split("/")[1]?.toUpperCase() || doc.content_type : "—"}
        </td>
        <td className="text-muted text-sm">{formatSize(doc.file_size)}</td>
        <td>{doc.vendor_id && doc.vendor_name ? <Link to={`/app/vendors/${doc.vendor_id}`}>{doc.vendor_name}</Link> : "—"}</td>
        <td>{doc.client_name || "—"}</td>
        <td>
          <span className="doc-tag">{displayDocType}</span>
        </td>
        <td>{ingestionBadge(doc.ingestion_status)}</td>
        <td>
          <span
            style={{
              display: "inline-block",
              padding: "2px 10px",
              borderRadius: "9999px",
              fontSize: "0.8rem",
              fontWeight: 600,
              color: confidenceColor(scorePct),
              background: confidenceBg(scorePct),
            }}
          >
            {scorePct != null ? `${scorePct}%` : "—"}
          </span>
        </td>
        <td>{reviewBadge(doc.is_reviewed)}</td>
        <td className="text-muted text-sm">
          {doc.received_date ? new Date(doc.received_date).toLocaleDateString() : "—"}
        </td>
        <td className="td-actions">
          <button
            className="btn btn-sm btn-outline"
            onClick={(e) => {
              e.stopPropagation();
              setViewError(null);
              openFileInNewTab(`/api/documents/${doc.id}/file`, doc.original_filename || "document").catch(
                (err) => setViewError(err instanceof Error ? err.message : String(err)),
              );
            }}
          >
            📄 View
          </button>
          {doc.ingestion_status === "error" && (
            <button
              className="btn btn-sm btn-outline"
              onClick={(e) => {
                e.stopPropagation();
                handleRetry();
              }}
              disabled={retrying}
            >
              {retrying ? "Retrying…" : "↻ Retry"}
            </button>
          )}
          <button
            className="btn btn-sm btn-outline"
            style={{ color: "var(--red, #dc2626)", borderColor: "var(--red, #dc2626)" }}
            onClick={(e) => {
              e.stopPropagation();
              handleDelete();
            }}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "🗑 Delete"}
          </button>
          {viewError && <span className="text-muted text-sm" style={{ color: "var(--red)" }}>{viewError}</span>}
          {actionError && <span className="text-muted text-sm" style={{ color: "var(--red)", display: "block" }}>{actionError}</span>}
          {detailLoading && <span className="text-muted text-sm">…</span>}
          {detailError && !isExpanded && <span className="text-muted text-sm" style={{ color: "var(--red)", display: "block" }}>{detailError}</span>}
        </td>
      </tr>

      {/* Expanded extraction detail */}
      {isExpanded && (
        <tr>
          <td colSpan={11} style={{ padding: "0" }}>
            {detail ? (
              <div className="extraction-detail" style={{ padding: "16px 20px", background: "var(--gray-50)", borderTop: "1px solid var(--gray-200)" }}>
                <h4 style={{ marginBottom: "12px", fontSize: "0.9rem", color: "var(--gray-700)" }}>
                  Extraction Details{" "}
                  <span className="text-muted text-sm">(latest)</span>
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "8px 16px", fontSize: "0.85rem" }}>
                  <DetailField label="Vendor Name" value={detail.extracted_vendor_name ?? detail.vendor_name} />
                  <DetailField label="Document Type" value={detail.extracted_document_type ?? detail.document_type} />
                  <DetailField label="Insurance Carrier" value={detail.insurance_carrier} />
                  <DetailField label="Policy Number" value={detail.policy_number} />
                  <DetailField label="Effective Date" value={detail.effective_date} />
                  <DetailField label="Expiration Date" value={detail.expiration_date} />
                  <DetailField label="Certificate Holder" value={detail.certificate_holder} />
                  <DetailField label="AI Confidence" value={score != null ? `${score}%` : "—"} />
                  <DetailField label="Sender Name" value={doc.sender_name} />
                  <DetailField label="Sender Email" value={doc.sender_email} />
                </div>
                {detail.extractions && detail.extractions.length > 1 && (
                  <div style={{ marginTop: "12px" }}>
                    <p className="text-muted text-sm">
                      {detail.extractions.length} extraction records (history retained)
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: "12px 20px", background: "var(--gray-50)", borderTop: "1px solid var(--gray-200)", fontSize: "0.85rem", color: "var(--red, #dc2626)" }}>
                Couldn't load the document details. <button className="btn btn-sm btn-outline" onClick={loadDetail}>Try again</button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span style={{ fontWeight: 600, color: "var(--gray-500)", fontSize: "0.75rem" }}>{label}</span>
      <br />
      <span style={{ color: "var(--gray-800)" }}>{value || "—"}</span>
    </div>
  );
}
