import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ComplianceDetailResponse, DocumentListItem, VendorDetail as VendorDetailType } from "@clear-to-pay/shared";
import { apiFetch } from "../lib/api";
import { confidencePercent } from "../lib/confidence";
import ComplianceScore from "../components/ComplianceScore";

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
  const [requesting, setRequesting] = useState(false);
  const [requestNotice, setRequestNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
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

  // Ask the vendor for updated compliance documents. The API derives the doc
  // types (missing / expired / expiring / below the required coverage limit)
  // when none are passed, sends ONE email to the vendor, and logs it as a
  // 'vendor_request' outreach. Success/error is reported inline.
  async function requestDocs() {
    if (!vendor || requesting) return;
    if (!window.confirm(`Email ${vendor.name} a request for updated compliance documents?`)) return;
    setRequesting(true); setRequestNotice(null);
    try {
      const res = await apiFetch(`/api/vendors/${vendor.id}/request-docs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({} as { error?: string; code?: string; recipient?: string }));
      if (!res.ok) {
        if (body?.code === "no_email_on_file") {
          throw new Error("No email on file for this vendor — add a contact email first.");
        }
        throw new Error(body?.error || "Unable to send the request");
      }
      setRequestNotice({ kind: "success", text: `Request sent to ${body?.recipient ?? "the vendor"}` });
    } catch (err) {
      setRequestNotice({ kind: "error", text: err instanceof Error ? err.message : "Unable to send the request" });
    } finally { setRequesting(false); }
  }

  if (loading) return <div className="page-container"><div className="loading">Loading vendor details…</div></div>;
  if (error || !vendor) return <div className="page-container"><div className="error-message">{error || "Vendor not found"}</div><Link className="btn btn-outline" to="/app/vendors">Back to Vendors</Link></div>;

  return <div className="page-container">
    <div className="page-header">
      <div><Link to="/app/vendors" className="back-link">← Vendors</Link><h2 className="page-title">{vendor.name}</h2></div>
      {statusBadge(vendor.payment_status)}
    </div>
    {error && <div className="error-message" style={{ marginBottom: 16 }}>{error}</div>}
    {requestNotice && (
      <div className={requestNotice.kind === "success" ? "success-message" : "error-message"} style={{ marginBottom: 16 }}>
        {requestNotice.text}
      </div>
    )}
    <div className="document-detail-layout">
      <section className="document-viewer-card">
        <h3>Vendor Information</h3>
        <div className="extraction-fields">
          <p><strong>Company</strong><br />{vendor.client_name || "—"}</p>
          <p><strong>Contact Email</strong><br />{vendor.contact_email || "—"}</p>
          <p><strong>Contact Phone</strong><br />{vendor.contact_phone || "—"}</p>
          <p><strong>Documents</strong><br />{vendor.document_count}</p>
          <p><strong>Created</strong><br />{date(vendor.created_at)}</p>
          <p><strong>Updated</strong><br />{date(vendor.updated_at)}</p>
        </div>
        <div className="card-header" style={{ marginTop: 20, padding: 0 }}><h3>Payment Readiness</h3></div>
        <p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted, #6b7280)" }}>Statuses below are informational flags based on documents on file and your configured criteria. Review source documents and verify coverage with your insurance agent or broker before making payment or coverage decisions.</p>
        <p style={{ marginBottom: 10 }}><strong>Compliance:</strong> {statusBadge(vendor.compliance_status)}</p>
        <p style={{ marginBottom: 10 }}><strong>Payment:</strong> {statusBadge(vendor.payment_status)}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 4px" }}>
          <strong>Compliance Score</strong>
          <ComplianceScore
            score={compliance?.compliance_score ?? vendor.compliance_score}
            label={compliance?.score_label ?? vendor.score_label}
            size="lg"
          />
        </div>
        <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--text-muted, #6b7280)" }}>
          Average of this vendor's required document types (compliant 100, expiring soon 75, needs review 50, below the required coverage limit 25, missing or expired 0): 80+ Good, 40–79 Fair, below 40 Poor.
        </p>
        <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={recalculate} disabled={recalculating}>{recalculating ? "Recalculating…" : "Recalculate Compliance"}</button>
        <button className="btn btn-outline" style={{ marginTop: 20, marginLeft: 10 }} onClick={requestDocs} disabled={requesting}>{requesting ? "Sending…" : "Request updated docs"}</button>
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--text-muted, #6b7280)" }}>Emails this vendor a request for the documents they are missing, expired, expiring, or below your required coverage limit. It goes to the vendor's contact email (or insurance agent email on file).</p>
      </section>
      <section className="card extraction-form-card">
        <h3>Compliance by Document Type</h3>
        {!compliance?.details.length ? <p className="text-muted">No document requirements configured for this company.</p> : <div className="table-wrapper"><table className="data-table"><thead><tr><th>Document Type</th><th>Status</th><th>Expiration Date</th><th>Coverage</th><th>Has Unreviewed</th></tr></thead><tbody>{compliance.details.map((d) => <tr key={d.document_type}><td className="td-name">{d.document_id ? <Link to={`/app/documents/${d.document_id}`}>{d.document_type}</Link> : d.document_type}</td><td>{statusBadge(d.status)}</td><td>{date(d.expiration_date)}</td><td>{d.coverage_status === "below" ? <span style={{ color: "#dc2626", fontSize: 13 }}>Coverage below requirement: ${(d.coverage_extracted ?? 0).toLocaleString()} / required ${d.coverage_required ?? "—"} — HOLD</span> : d.coverage_status === "unreadable" ? <span style={{ color: "#d97706", fontSize: 13 }}>Coverage limit not readable — review required</span> : <span className="text-muted">—</span>}</td><td>{d.has_unreviewed ? "⚠ Yes" : "✓ No"}</td></tr>)}</tbody></table></div>}
        <h3 style={{ marginTop: 28 }}>Documents</h3>
        {!documents.length ? <p className="text-muted">No documents uploaded for this vendor.</p> : <div className="table-wrapper"><table className="data-table"><thead><tr><th>Filename</th><th>Document Type</th><th>Expiration</th><th>Reviewed</th><th>AI Confidence</th><th>Ingestion</th></tr></thead><tbody>{documents.map((doc) => <tr key={doc.id}><td className="td-name"><Link to={`/app/documents/${doc.id}`}>{doc.original_filename}</Link></td><td>{doc.extracted_document_type || doc.document_type || "—"}</td><td>{date(doc.expiration_date)}</td><td>{doc.is_reviewed ? <span className="badge badge-approved">Reviewed</span> : <span className="badge badge-needs_review">Needs Review</span>}</td><td>{confidencePercent(doc.ai_confidence_score) != null ? `${confidencePercent(doc.ai_confidence_score)}%` : "—"}</td><td>{ingestionBadge(doc.ingestion_status)}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  </div>;
}
