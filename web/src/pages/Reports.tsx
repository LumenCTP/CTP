import { apiFetch } from "../lib/api";
import { downloadFile } from "../lib/files";
import { useEffect, useState } from "react";
import type { ClientWithRequiredDocs } from "@clear-to-pay/shared";
import { ALL_DOCUMENT_TYPES } from "@clear-to-pay/shared";

interface ReportSummary {
  client_name: string;
  report_date: string;
  payment_week: { monday: string; sunday: string };
  approved_count: number;
  review_count: number;
  hold_count: number;
  expiring_count: number;
  missing_count: number;
}

interface ReportResult {
  pdf_url?: string;
  excel_url?: string;
  summary?: ReportSummary;
}

interface AuditResult {
  download_url: string;
  summary: {
    matching_documents: number;
    vendors: number;
    total_size: number;
  };
}

interface VendorOption {
  id: number;
  name: string;
  client_id: number;
}

export default function Reports() {
  const [clients, setClients] = useState<ClientWithRequiredDocs[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [format, setFormat] = useState<string>("both");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientsLoading, setClientsLoading] = useState(true);

  // ── Audit State ──
  const [auditClientId, setAuditClientId] = useState<number | null>(null);
  const [auditVendorId, setAuditVendorId] = useState<number | null>(null);
  const [auditDocType, setAuditDocType] = useState<string>("");
  const [auditDateFrom, setAuditDateFrom] = useState<string>("");
  const [auditDateTo, setAuditDateTo] = useState<string>("");
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);

  // Load clients list
  useEffect(() => {
    apiFetch("/api/clients")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch clients");
        return res.json();
      })
      .then((data: ClientWithRequiredDocs[]) => {
        setClients(data);
        if (data.length > 0) {
          setSelectedClientId(data[0].id);
          setAuditClientId(data[0].id);
        }
        setClientsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setClientsLoading(false);
      });
  }, []);

  // Load vendors when audit client changes
  useEffect(() => {
    if (!auditClientId) {
      setVendors([]);
      setAuditVendorId(null);
      return;
    }
    setVendorsLoading(true);
    apiFetch(`/api/vendors?client_id=${auditClientId}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch vendors");
        return res.json();
      })
      .then((data: VendorOption[]) => {
        setVendors(data);
        setAuditVendorId(null);
        setVendorsLoading(false);
      })
      .catch(() => {
        setVendors([]);
        setVendorsLoading(false);
      });
  }, [auditClientId]);

  const generateReport = async () => {
    if (!selectedClientId) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // For "pdf" and "excel" single formats, trigger file download directly
      if (format === "pdf" || format === "excel" || format === "csv") {
        const res = await apiFetch("/api/reports/clear-to-pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: selectedClientId, format }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: "Failed to generate report" }));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const ext = format === "pdf" ? "pdf" : format === "csv" ? "csv" : "xlsx";
        a.href = url;
        a.download = `ClearToPay_Report.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Summary preview comes from THIS response's X-Report-Summary header
        // (base64url JSON) — generating the report a second time just for the
        // preview was wasteful (L5).
        const rawSummary = res.headers.get("X-Report-Summary");
        if (rawSummary) {
          try {
            const b64 = rawSummary.replace(/-/g, "+").replace(/_/g, "/");
            const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
            setResult({ summary: JSON.parse(json) });
          } catch {
            // Header unreadable — preview just won't show; the download still worked.
          }
        }
      } else {
        // "both" format
        const res = await apiFetch("/api/reports/clear-to-pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: selectedClientId, format: "both" }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: "Failed to generate report" }));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const data: ReportResult = await res.json();
        setResult(data);

        // Auto-download both files (fetch-with-token → Blob → object URL)
        try {
          if (data.pdf_url) {
            await downloadFile(data.pdf_url, "ClearToPay_Report.pdf");
          }
          if (data.excel_url) {
            await downloadFile(data.excel_url, "ClearToPay_Report.xlsx");
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to download reports");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const generateAudit = async () => {
    if (!auditClientId) return;

    setAuditLoading(true);
    setAuditError(null);
    setAuditResult(null);

    try {
      const body: Record<string, unknown> = { client_id: auditClientId };
      if (auditVendorId) body.vendor_id = auditVendorId;
      if (auditDocType) body.document_type = auditDocType;
      if (auditDateFrom) body.date_from = auditDateFrom;
      if (auditDateTo) body.date_to = auditDateTo;

      const res = await apiFetch("/api/audit/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Failed to generate audit package" }));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data: AuditResult = await res.json();
      setAuditResult(data);

      // Auto-download the zip (fetch-with-token → Blob → object URL)
      if (data.download_url) {
        try {
          await downloadFile(data.download_url, data.download_url.split("/").pop() || "audit.zip");
        } catch (err) {
          setAuditError(err instanceof Error ? err.message : "Failed to download audit package");
        }
      }
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditLoading(false);
    }
  };

  const handleReportDownload = async (url: string | undefined, name: string) => {
    if (!url) return;
    setError(null);
    try {
      await downloadFile(url, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    }
  };

  const handleAuditDownload = async (url: string | undefined, name: string) => {
    if (!url) return;
    setAuditError(null);
    try {
      await downloadFile(url, name);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Download failed");
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  };

  const clientName = clients.find((c) => c.id === selectedClientId)?.name;

  return (
    <div className="page-container">
      <div className="page-header">
        <h2 className="page-title">Clear-to-Pay Reports</h2>
      </div>

      {clientsLoading ? (
        <div className="loading">Loading clients…</div>
      ) : (
        <>
          {/* Configuration Panel */}
          <div className="report-config-panel">
            <div className="config-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label>Client</label>
                <select
                  className="form-select"
                  value={selectedClientId ?? ""}
                  onChange={(e) => {
                    setSelectedClientId(Number(e.target.value));
                    setResult(null);
                    setError(null);
                  }}
                  style={{ width: "100%" }}
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Format</label>
                <div className="format-selector">
                  {[
                    { value: "both", label: "PDF + Excel" },
                    { value: "pdf", label: "PDF Only" },
                    { value: "excel", label: "Excel Only" },
                    { value: "csv", label: "CSV Only" },
                  ].map((opt) => (
                    <label key={opt.value} className="radio-label">
                      <input
                        type="radio"
                        name="format"
                        value={opt.value}
                        checked={format === opt.value}
                        onChange={(e) => setFormat(e.target.value)}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="form-group" style={{ alignSelf: "flex-end" }}>
                <button
                  className="btn btn-primary"
                  onClick={generateReport}
                  disabled={loading || !selectedClientId}
                >
                  {loading ? "Generating…" : "Generate Report"}
                </button>
              </div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="error-message" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}

          {/* Success */}
          {result && result.summary && !error && (
            <div className="success-message" style={{ marginBottom: 16 }}>
              Report generated successfully for <strong>{result.summary.client_name}</strong>!
            </div>
          )}

          {/* Report Summary Preview */}
          {result && result.summary && (
            <div className="report-preview">
              <div className="report-preview-header">
                <h3>Report Summary</h3>
                <div className="report-meta">
                  <span>
                    Report Date: {formatDate(result.summary.report_date)}
                  </span>
                  <span>
                    Payment Week: {formatDate(result.summary.payment_week.monday)} –{" "}
                    {formatDate(result.summary.payment_week.sunday)}
                  </span>
                </div>
              </div>

              <div className="summary-cards">
                <div className="summary-card approved">
                  <div className="summary-card-icon">✓</div>
                  <div className="summary-card-body">
                    <div className="summary-card-label">Approved for Payment</div>
                    <div className="summary-card-value">{result.summary.approved_count}</div>
                  </div>
                </div>
                <div className="summary-card review">
                  <div className="summary-card-icon">🔍</div>
                  <div className="summary-card-body">
                    <div className="summary-card-label">Review Before Payment</div>
                    <div className="summary-card-value">{result.summary.review_count}</div>
                  </div>
                </div>
                <div className="summary-card hold">
                  <div className="summary-card-icon">🚫</div>
                  <div className="summary-card-body">
                    <div className="summary-card-label">Hold Payment</div>
                    <div className="summary-card-value">{result.summary.hold_count}</div>
                  </div>
                </div>
                <div className="summary-card expiring">
                  <div className="summary-card-icon">⏰</div>
                  <div className="summary-card-body">
                    <div className="summary-card-label">Expiring This Week</div>
                    <div className="summary-card-value">{result.summary.expiring_count}</div>
                  </div>
                </div>
                <div className="summary-card missing">
                  <div className="summary-card-icon">⚠</div>
                  <div className="summary-card-body">
                    <div className="summary-card-label">Missing Documents</div>
                    <div className="summary-card-value">{result.summary.missing_count}</div>
                  </div>
                </div>
              </div>

              <p style={{ margin: "12px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted, #6b7280)" }}>Statuses below are informational flags based on documents on file and your configured criteria. Review source documents and verify coverage with your insurance agent or broker before making payment or coverage decisions.</p>

              {/* Download links for "both" format */}
              {format === "both" && (
                <div className="download-links">
                  <h4>Download Reports</h4>
                  <div className="download-buttons">
                    {result.pdf_url && (
                      <button className="btn btn-outline" type="button" onClick={() => handleReportDownload(result.pdf_url, "ClearToPay_Report.pdf")}>
                        📄 Download PDF
                      </button>
                    )}
                    {result.excel_url && (
                      <button className="btn btn-outline" type="button" onClick={() => handleReportDownload(result.excel_url, "ClearToPay_Report.xlsx")}>
                        📊 Download Excel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {/* ── Audit Package Generator ── */}
          <div style={{ marginTop: 48, borderTop: "2px solid #e5e7eb", paddingTop: 32 }}>
            <div className="page-header" style={{ marginBottom: 16 }}>
              <h3 className="page-title" style={{ fontSize: "1.25rem" }}>Audit Package Generator</h3>
              <p style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: 4 }}>
                Search for compliance documents by client, vendor, type, and date range, then download
                a ZIP archive with matching documents, vendor summaries, and compliance reports.
              </p>
            </div>

            <div className="report-config-panel">
              <div className="config-row" style={{ flexWrap: "wrap", gap: 12 }}>
                <div className="form-group" style={{ flex: "1 1 200px" }}>
                  <label>Client *</label>
                  <select
                    className="form-select"
                    value={auditClientId ?? ""}
                    onChange={(e) => {
                      setAuditClientId(e.target.value ? Number(e.target.value) : null);
                      setAuditResult(null);
                      setAuditError(null);
                    }}
                    style={{ width: "100%" }}
                  >
                    <option value="">-- Select Client --</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ flex: "1 1 200px" }}>
                  <label>Vendor (optional)</label>
                  <select
                    className="form-select"
                    value={auditVendorId ?? ""}
                    onChange={(e) => {
                      setAuditVendorId(e.target.value ? Number(e.target.value) : null);
                      setAuditResult(null);
                      setAuditError(null);
                    }}
                    style={{ width: "100%" }}
                    disabled={!auditClientId || vendorsLoading}
                  >
                    <option value="">-- All Vendors --</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ flex: "1 1 180px" }}>
                  <label>Document Type (optional)</label>
                  <select
                    className="form-select"
                    value={auditDocType}
                    onChange={(e) => {
                      setAuditDocType(e.target.value);
                      setAuditResult(null);
                      setAuditError(null);
                    }}
                    style={{ width: "100%" }}
                  >
                    <option value="">-- All Types --</option>
                    {ALL_DOCUMENT_TYPES.map((dt) => (
                      <option key={dt} value={dt}>
                        {dt}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ flex: "0 1 140px" }}>
                  <label>Date From</label>
                  <input
                    type="date"
                    className="form-input"
                    value={auditDateFrom}
                    onChange={(e) => {
                      setAuditDateFrom(e.target.value);
                      setAuditResult(null);
                      setAuditError(null);
                    }}
                    style={{ width: "100%" }}
                  />
                </div>

                <div className="form-group" style={{ flex: "0 1 140px" }}>
                  <label>Date To</label>
                  <input
                    type="date"
                    className="form-input"
                    value={auditDateTo}
                    onChange={(e) => {
                      setAuditDateTo(e.target.value);
                      setAuditResult(null);
                      setAuditError(null);
                    }}
                    style={{ width: "100%" }}
                  />
                </div>

                <div className="form-group" style={{ alignSelf: "flex-end" }}>
                  <button
                    className="btn btn-primary"
                    onClick={generateAudit}
                    disabled={auditLoading || !auditClientId}
                  >
                    {auditLoading ? "Generating…" : "Generate Audit Package"}
                  </button>
                </div>
              </div>
            </div>

            {/* Audit Error */}
            {auditError && (
              <div className="error-message" style={{ marginBottom: 16 }}>
                {auditError}
              </div>
            )}

            {/* Audit Success + Summary */}
            {auditResult && !auditError && (
              <div className="report-preview" style={{ marginTop: 16 }}>
                <div className="report-preview-header">
                  <h3>Audit Package Generated</h3>
                </div>

                <div className="summary-cards">
                  <div className="summary-card approved">
                    <div className="summary-card-icon">📄</div>
                    <div className="summary-card-body">
                      <div className="summary-card-label">Matching Documents</div>
                      <div className="summary-card-value">{auditResult.summary.matching_documents}</div>
                    </div>
                  </div>
                  <div className="summary-card review">
                    <div className="summary-card-icon">🏢</div>
                    <div className="summary-card-body">
                      <div className="summary-card-label">Vendors Included</div>
                      <div className="summary-card-value">{auditResult.summary.vendors}</div>
                    </div>
                  </div>
                  <div className="summary-card" style={{ backgroundColor: "#f0f9ff", borderLeftColor: "#1a56db" }}>
                    <div className="summary-card-icon">📦</div>
                    <div className="summary-card-body">
                      <div className="summary-card-label">ZIP Size</div>
                      <div className="summary-card-value">
                        {(auditResult.summary.total_size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                  </div>
                </div>

                <div className="download-links">
                  <h4>Download Audit Package</h4>
                  <div className="download-buttons">
                    <button
                      className="btn btn-outline"
                      type="button"
                      onClick={() =>
                        handleAuditDownload(
                          auditResult.download_url,
                          auditResult.download_url.split("/").pop() || "audit-package.zip",
                        )
                      }
                    >
                      📦 Download ZIP
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
