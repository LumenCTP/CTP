import { useEffect, useState, useCallback, useRef } from "react";
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
  const dropRef = useRef<HTMLDivElement>(null);

  // Expanded row
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // ── Fetch data ──────────────────────────────────

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch("/api/clients");
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
      const res = await fetch(url);
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

      const res = await fetch(url);
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
      setSelectedFile(files[0]);
      setUploadError(null);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFile(files[0]);
      setUploadError(null);
    }
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

      const res = await fetch("/api/documents/upload", {
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
          border: `2px dashed ${dragOver ? "var(--blue)" : "var(--gray-300)"}`,
          borderRadius: "10px",
          padding: "24px",
          marginBottom: "20px",
          background: dragOver ? "var(--blue-light)" : "var(--gray-50)",
          transition: "border-color 0.2s, background 0.2s",
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <form onSubmit={handleUpload} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {/* File picker */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                onChange={handleFileSelect}
                style={{ display: "none" }}
                id="doc-file-input"
              />
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => fileInputRef.current?.click()}
              >
                📎 {selectedFile ? selectedFile.name : "Choose File"}
              </button>
            </div>

            {/* Client selector */}
            <select
              className="form-select"
              style={{ minWidth: "180px" }}
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

            {/* Vendor selector — filtered by client */}
            <select
              className="form-select"
              style={{ minWidth: "180px" }}
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

            {/* Upload button */}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={uploading || !selectedFile}
            >
              {uploading ? "Uploading…" : "⬆ Upload"}
            </button>
          </div>

          {/* Drag hint */}
          {!selectedFile && (
            <p className="text-muted text-sm" style={{ margin: 0 }}>
              or drag &amp; drop a file here (PDF, PNG, JPG — max 10MB)
            </p>
          )}

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

  async function loadDetail() {
    if (detail) {
      onToggle();
      return;
    }
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/documents/${doc.id}`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setDetail(data);
      setDetailLoading(false);
      onToggle();
    } catch {
      setDetailLoading(false);
    }
  }

  const score = doc.ai_confidence_score;
  const displayDocType = doc.extracted_document_type || doc.document_type;

  return (
    <>
      <tr style={{ cursor: "pointer" }} onClick={loadDetail}>
        <td className="td-name" style={{ maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {doc.original_filename}
        </td>
        <td className="text-muted text-sm">
          {doc.content_type ? doc.content_type.split("/")[1]?.toUpperCase() || doc.content_type : "—"}
        </td>
        <td className="text-muted text-sm">{formatSize(doc.file_size)}</td>
        <td>{doc.vendor_name || "—"}</td>
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
              color: confidenceColor(score),
              background: confidenceBg(score),
            }}
          >
            {score != null ? `${score}%` : "—"}
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
              window.open(`/api/documents/${doc.id}/file`, "_blank");
            }}
          >
            📄 View
          </button>
          {detailLoading && <span className="text-muted text-sm">…</span>}
        </td>
      </tr>

      {/* Expanded extraction detail */}
      {isExpanded && detail && (
        <tr>
          <td colSpan={11} style={{ padding: "0" }}>
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
