import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { ALL_DOCUMENT_TYPES, type DocumentDetail as DocumentDetailType, type ExtractionUpdateBody } from "@clear-to-pay/shared";

const emptyForm = { vendor_name: "", insurance_carrier: "", policy_number: "", effective_date: "", expiration_date: "", certificate_holder: "", certificate_holder_address: "", document_type: "" };
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
      <section className="document-viewer-card"><h3>Document Viewer</h3>{isImage ? <img className="document-preview-image" src={`/api/documents/${id}/file`} alt={doc.original_filename} /> : <div className="document-pdf-placeholder"><span>📄</span><strong>PDF document</strong><a className="btn btn-primary" href={`/api/documents/${id}/file`} target="_blank" rel="noreferrer">Open / Download PDF</a></div>}</section>
      <form className="card extraction-form-card" onSubmit={save}><div className="card-header"><h3>Extracted Data</h3><span className="confidence-score">AI confidence: {doc.ai_confidence_score != null ? `${doc.ai_confidence_score}%` : "—"}</span></div>
        <div className="extraction-fields">
          {([ ["vendor_name","Vendor Name","text"],["insurance_carrier","Insurance Carrier","text"],["policy_number","Policy Number","text"],["effective_date","Effective Date","date"],["expiration_date","Expiration Date","date"],["certificate_holder","Certificate Holder","text"],["certificate_holder_address","Certificate Holder Address","text"]] as const).map(([key,label,type]) => <label className="form-group" key={key}>{label}<input className="form-input" type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>)}
          <label className="form-group">Document Type<select className="form-select" value={form.document_type} onChange={(e) => setForm({ ...form, document_type: e.target.value })}><option value="">Select type…</option>{ALL_DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        </div>
        <label className="review-checkbox"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> Mark as reviewed / approved</label>
        {error && <div className="error-message">{error}</div>}<div className="form-actions"><Link className="btn btn-outline" to="/app/documents">Cancel</Link><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : reviewed ? "Save & Approve" : "Save"}</button></div>
      </form>
    </div>
  </div>;
}
