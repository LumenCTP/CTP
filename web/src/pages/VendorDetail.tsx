import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ComplianceDetailResponse, DocumentListItem, VendorDetail as VendorDetailType } from "@clear-to-pay/shared";
import { apiFetch } from "../lib/api";
import { confidencePercent } from "../lib/confidence";

function statusBadge(status: string | undefined) {
  const safe = status || "needs_review";
  const label = safe === "missing" ? "Missing" : safe.replace(/_/g, " ");
  return <span className={`badge badge-${safe}`}>{label}</span>;
}

function date(value: string | null | undefined) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

function ingestionBadge(status: string | undefined) {
  const labels: Record<string, string> = { uploaded: "Uploaded", processing: "Processing", ready: "Ready", error: "Error" };
  return <span className={`badge ingestion-${status || "uploaded"}`}>{labels[status || "uploaded"] || status}</span>;
}

export default function VendorDetail() {
  const { id } = useParams<{ id: string }>();
  const [vendor, setVendor] = useState<VendorDetailType | null>(null);
  const [compliance, setCompliance] = useState<ComplianceDetailResponse | null>(null);
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true); setError(null);
    try {
      const [vendorRes, complianceRes, docsRes] = await Promise.all([
        apiFetch(`/api/vendors/${id}`),
        apiFetch(`/api/vendors/${id}/compliance-detail`),
        apiFetch(`/api/documents?vendor_id=${id}`),
      ]);
      if (!vendorRes.ok) throw new Error("Vendor not found");
      if (!complianceRes.ok) throw new Error("Unable to load compliance details");
      if (!docsRes.ok) throw new Error("Unable to load vendor documents");
      setVendor(await vendorRes.json());
      setCompliance(await complianceRes.json());
      setDocuments(await docsRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load vendor details");
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function recalculate() {
    if (!vendor) return;
    setRecalculating(true); setError(null);
    try {
      const res = await apiFetch("/api/compliance/recalculate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_id: vendor.id, client_id: vendor.client_id }),
      });
      if (!res.ok) { const body = await res.json(); throw new Error(body.error || "Recalculation failed"); }
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Recalculation failed"); }
    finally { setRecalculating(false); }
  }

  if (loading) return <div className="page-container"><div className="loading">Loading vendor details…</div></div>;
  if (error || !vendor) return <div className="page-container"><div className="error-message">{error || "Vendor not found"}</div><Link className="btn btn-outline" to="/app/vendors">Back to Vendors</Link></div>;

  return <div className="page-container">
    <div className="page-header">
      <div><Link to="/app/vendors" className="back-link">← Vendors</Link><h2 className="page-title">{vendor.name}</h2></div>
      {statusBadge(vendor.payment_status)}
    </div>
    {error && <div className="error-message" style={{ marginBottom: 16 }}>{error}</div>}
    <div className="document-detail-layout">
      <section className="document-viewer-card">
        <h3>Vendor Information</h3>
        <div className="extraction-fields">
          <p><strong>Client</strong><br />{vendor.client_name || "—"}</p>
          <p><strong>Contact Email</strong><br />{vendor.contact_email || "—"}</p>
          <p><strong>Contact Phone</strong><br />{vendor.contact_phone || "—"}</p>
          <p><strong>Documents</strong><br />{vendor.document_count}</p>
          <p><strong>Created</strong><br />{date(vendor.created_at)}</p>
          <p><strong>Updated</strong><br />{date(vendor.updated_at)}</p>
        </div>
        <div className="card-header" style={{ marginTop: 20, padding: 0 }}><h3>Payment Readiness</h3></div>
        <p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted, #6b7280)" }}>Statuses below are informational flags based on documents on file and your configured criteria. Review source documents and verify coverage with your insurance agent or broker before making payment or coverage decisions.</p>
        <p style={{ marginBottom: 10 }}><strong>Compliance:</strong> {statusBadge(vendor.compliance_status)}</p>
        <p><strong>Payment:</strong> {statusBadge(vendor.payment_status)}</p>
        <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={recalculate} disabled={recalculating}>{recalculating ? "Recalculating…" : "Recalculate Compliance"}</button>
      </section>
      <section className="card extraction-form-card">
        <h3>Compliance by Document Type</h3>
        {!compliance?.details.length ? <p className="text-muted">No document requirements configured for this client.</p> : <div className="table-wrapper"><table className="data-table"><thead><tr><th>Document Type</th><th>Status</th><th>Expiration Date</th><th>Has Unreviewed</th></tr></thead><tbody>{compliance.details.map((d) => <tr key={d.document_type}><td className="td-name">{d.document_id ? <Link to={`/app/documents/${d.document_id}`}>{d.document_type}</Link> : d.document_type}</td><td>{statusBadge(d.status)}</td><td>{date(d.expiration_date)}</td><td>{d.has_unreviewed ? "⚠ Yes" : "✓ No"}</td></tr>)}</tbody></table></div>}
        <h3 style={{ marginTop: 28 }}>Documents</h3>
        {!documents.length ? <p className="text-muted">No documents uploaded for this vendor.</p> : <div className="table-wrapper"><table className="data-table"><thead><tr><th>Filename</th><th>Document Type</th><th>Expiration</th><th>Reviewed</th><th>AI Confidence</th><th>Ingestion</th></tr></thead><tbody>{documents.map((doc) => <tr key={doc.id}><td className="td-name"><Link to={`/app/documents/${doc.id}`}>{doc.original_filename}</Link></td><td>{doc.extracted_document_type || doc.document_type || "—"}</td><td>{date(doc.expiration_date)}</td><td>{doc.is_reviewed ? <span className="badge badge-approved">Reviewed</span> : <span className="badge badge-needs_review">Needs Review</span>}</td><td>{confidencePercent(doc.ai_confidence_score) != null ? `${confidencePercent(doc.ai_confidence_score)}%` : "—"}</td><td>{ingestionBadge(doc.ingestion_status)}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  </div>;
}
