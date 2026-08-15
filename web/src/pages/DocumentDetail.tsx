import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { fetchFileObjectUrl, openFileInNewTab } from "../lib/files";
import { ALL_DOCUMENT_TYPES, type DocumentDetail as DocumentDetailType, type ExtractionUpdateBody } from "@clear-to-pay/shared";

const emptyForm = { vendor_name: "", insurance_carrier: "", policy_number: "", effective_date: "", expiration_date: "", certificate_holder: "", certificate_holder_address: "", producer_name: "", producer_contact: "", producer_email: "", producer_phone: "", document_type: "" };
type FormState = typeof emptyForm;

function statusBadge(status: string | undefined) {
  const labels: Record<string, string> = { ready: "Ready", processing: "Processing", uploaded: "Uploaded", error: "Error" };
  return <span className={`badge ingestion-${status || "uploaded"}`}>{labels[status || "uploaded"] || status}</span>;
}

export default function DocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<DocumentDetailType | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Authenticated file object URL for the document viewer (<img> / PDF open).
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    setFileLoading(true);
    setFileError(null);
    fetchFileObjectUrl(`/api/documents/${id}/file`)
      .then((u) => {
        if (!active) return;
        url = u;
        setFileUrl(u);
      })
      .catch((err) => {
        if (active) setFileError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setFileLoading(false);
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setFileUrl(null);
    };
  }, [id]);

  useEffect(() => {
    apiFetch(`/api/documents/${id}`).then(async (res) => {
      if (!res.ok) throw new Error("Document not found");
      const data: DocumentDetailType & { certificate_holder_address?: string | null } = await res.json();
      setDoc(data);
      setForm({
        vendor_name: data.extractions?.[0]?.vendor_name ?? data.vendor_name ?? "",
        insurance_carrier: data.extractions?.[0]?.insurance_carrier ?? data.insurance_carrier ?? "",
        policy_number: data.extractions?.[0]?.policy_number ?? data.policy_number ?? "",
        effective_date: data.extractions?.[0]?.effective_date ?? data.effective_date ?? "",
        expiration_date: data.extractions?.[0]?.expiration_date ?? data.expiration_date ?? "",
        certificate_holder: data.extractions?.[0]?.certificate_holder ?? data.certificate_holder ?? "",
        certificate_holder_address: data.extractions?.[0]?.certificate_holder_address ?? data.certificate_holder_address ?? "",
        producer_name: data.extractions?.[0]?.producer_name ?? "",
        producer_contact: data.extractions?.[0]?.producer_contact ?? "",
        producer_email: data.extractions?.[0]?.producer_email ?? "",
        producer_phone: data.extractions?.[0]?.producer_phone ?? "",
        document_type: data.extractions?.[0]?.document_type ?? data.extracted_document_type ?? data.document_type ?? "",
      });
      setReviewed(Boolean(data.is_reviewed || data.extractions?.[0]?.is_reviewed));
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load document")).finally(() => setLoading(false));
  }, [id]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError(null);
    try {
      const body: ExtractionUpdateBody = { ...form, is_reviewed: reviewed };
      const res = await apiFetch(`/api/documents/${id}/extraction`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Save failed"); }
      navigate("/app/documents");
    } catch (err) { setError(err instanceof Error ? err.message : "Save failed"); setSaving(false); }
  }

  if (loading) return <div className="page-container"><div className="loading">Loading document…</div></div>;
  if (error || !doc) return <div className="page-container"><div className="error-message">{error || "Document not found"}</div><Link className="btn btn-outline" to="/app/documents">Back to Documents</Link></div>;
  const isImage = doc.content_type?.startsWith("image/");

  return <div className="page-container">
    <div className="page-header"><div><Link to="/app/documents" className="back-link">← Documents</Link><h2 className="page-title">Review Document</h2><p className="page-subtitle">{doc.original_filename}</p></div>{statusBadge(doc.ingestion_status)}</div>
    <div className="document-detail-layout">
      <section className="document-viewer-card"><h3>Document Viewer</h3>{fileError && !fileUrl ? <div className="error-message">{fileError}</div> : fileLoading && !fileUrl ? <div className="loading">Loading document…</div> : isImage ? <img className="document-preview-image" src={fileUrl ?? undefined} alt={doc.original_filename} /> : <div className="document-pdf-placeholder"><span>📄</span><strong>PDF document</strong><button className="btn btn-primary" type="button" onClick={() => { setFileError(null); openFileInNewTab(`/api/documents/${id}/file`, doc.original_filename).catch((e) => setFileError(e instanceof Error ? e.message : String(e))); }} disabled={fileLoading}>{fileLoading ? "Loading…" : "Open / Download PDF"}</button></div>}</section>
      <form className="card extraction-form-card" onSubmit={save}><div className="card-header"><h3>Extracted Data</h3><span className="confidence-score">AI confidence: {doc.ai_confidence_score != null ? `${doc.ai_confidence_score}%` : "—"}</span></div>
        <p style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.5, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 6, padding: "8px 10px" }}>AI-extracted fields may be incomplete or incorrect. Compare every field with the source document before marking the extraction reviewed. 'Reviewed' confirms data-entry review only; it is not approval of coverage or payment.</p>
        <div className="extraction-fields">
          {([ ["vendor_name","Vendor Name","text"],["insurance_carrier","Insurance Carrier","text"],["policy_number","Policy Number","text"],["effective_date","Effective Date","date"],["expiration_date","Expiration Date","date"],["certificate_holder","Certificate Holder","text"],["certificate_holder_address","Certificate Holder Address","text"]] as const).map(([key,label,type]) => <label className="form-group" key={key}>{label}<input className="form-input" type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>)}
          <label className="form-group">Document Type<select className="form-select" value={form.document_type} onChange={(e) => setForm({ ...form, document_type: e.target.value })}><option value="">Select type…</option>{ALL_DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <div className="producer-fields" style={{ gridColumn: "1 / -1", padding: "12px", background: "var(--bg-soft, #f8fafc)", borderRadius: "8px", border: "1px dashed var(--border, #d1d5db)" }}>
            <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted, #6b7280)" }}>Producer (COI agency/agent — top-right of the certificate)</p>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-muted, #6b7280)" }}>Renewal reminders for this document go to the producer email when present.</p>
            {([ ["producer_name","Producer / Agency Name","text"],["producer_contact","Contact Person","text"],["producer_email","Producer Email","email"],["producer_phone","Producer Phone","text"]] as const).map(([key,label,type]) => <label className="form-group" key={key}>{label}<input className="form-input" type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>)}
          </div>
        </div>
        <label className="review-checkbox"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I reviewed the extracted data against the source document.</label>
        {error && <div className="error-message">{error}</div>}<div className="form-actions"><Link className="btn btn-outline" to="/app/documents">Cancel</Link><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save Review"}</button></div>
      </form>
    </div>
  </div>;
}
