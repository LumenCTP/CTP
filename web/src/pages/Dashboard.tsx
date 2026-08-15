import { apiFetch } from "../lib/api";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardStats } from "@clear-to-pay/shared";
import { openHelp } from "../components/HelpWidget";
import { useAuth } from "../components/AuthContext";

interface ClearToPayVendor {
  vendor_id: number;
  vendor_name: string;
  client_id: number;
  client_name: string;
  compliance_status: string;
  payment_status: "approved" | "review" | "hold";
  missing_documents: string[];
  earliest_expiring_date: string | null;
  earliest_expiring_type: string | null;
}

interface MetricCard {
  key: keyof DashboardStats;
  label: string;
  icon: string;
  color: string;
}

const metricCards: MetricCard[] = [
  { key: "total_clients", label: "Total Clients", icon: "▦", color: "#1a56db" },
  { key: "total_vendors", label: "Total Vendors", icon: "👥", color: "#1a56db" },
  { key: "vendors_approved", label: "Approved for Payment", icon: "✓", color: "#059669" },
  { key: "vendors_review", label: "Review Before Payment", icon: "🔍", color: "#d97706" },
  { key: "vendors_hold", label: "Hold Payment", icon: "🚫", color: "#dc2626" },
  { key: "expiring_this_week", label: "Expiring This Week", icon: "⏰", color: "#d97706" },
  { key: "needs_review", label: "Needs Review", icon: "⚠", color: "#dc2626" },
];

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [documentCount, setDocumentCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [clearToPay, setClearToPay] = useState<ClearToPayVendor[]>([]);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ approved: true, review: true, hold: true });

  useEffect(() => {
    Promise.all([
      apiFetch("/api/dashboard/stats").then((res) => {
        if (!res.ok) throw new Error("Failed to fetch stats");
        return res.json() as Promise<DashboardStats>;
      }),
      apiFetch("/api/documents").then((res) => (res.ok ? res.json() : [])).catch(() => []),
      apiFetch("/api/dashboard/clear-to-pay").then((res) => (res.ok ? res.json() : { vendors: [] })).catch(() => ({ vendors: [] })),
    ])
      .then(([data, documents, readiness]) => {
        setStats(data);
        setClearToPay((readiness as { vendors?: ClearToPayVendor[] }).vendors ?? []);
        setDocumentCount(Array.isArray(documents) ? documents.length : (documents as { documents?: unknown[] }).documents?.length ?? 0);
        // Show the onboarding guide whenever the tenant is effectively empty:
        // no vendors AND no documents. That covers the zero-client state AND
        // the normal signup path where the setup wizard auto-created the
        // tenant's own client row (so total_clients >= 1 but there is still
        // nothing configured) — step 1 is marked done by the steps list below.
        setShowGuide(data.total_vendors === 0 && documentCount === 0);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div className="dashboard"><h2 className="page-title">Dashboard</h2><div className="loading">Loading metrics…</div></div>;
  }

  if (error) {
    return <div className="dashboard"><h2 className="page-title">Dashboard</h2><div className="error-message">Error: {error}</div></div>;
  }

  const hasClients = (stats?.total_clients ?? 0) > 0;
  const hasVendors = (stats?.total_vendors ?? 0) > 0;
  const steps = [
    { label: "Add your first client", href: "/app/clients", done: hasClients, action: "Add Client" },
    { label: "Add vendors under that client", href: "/app/vendors", done: hasVendors },
    { label: "Upload compliance documents", href: "/app/documents", done: documentCount > 0 },
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-heading">
        <h2 className="page-title">Dashboard</h2>
        <div className="dashboard-heading-actions">
          <button className="setup-guide-link" onClick={() => setShowGuide((visible) => !visible)}>{showGuide ? "Hide Setup Guide" : "Setup Guide"}</button>
          <button className="setup-guide-link" onClick={() => openHelp()}>Help & Support</button>
        </div>
      </div>

      {/* Weekly report configuration banner (H5): the Monday Clear-to-Pay email
          only fires when a client has weekly report recipients set. New clients
          get the tenant owner's email as the default at client creation, but
          tenants with clients created before that fix (or owners who cleared
          the recipients) must see a prominent notice instead of silently
          receiving nothing. */}
      {stats && (stats.total_clients ?? 0) > 0 && stats.weekly_reports_configured === false && (
        <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderLeft: "5px solid #d97706", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 13.5, color: "#78350f", lineHeight: 1.5 }}>
          <strong>⚠️ Your weekly Clear-to-Pay report isn't configured yet.</strong>{" "}
          No weekly report will be emailed until at least one client has report recipients set.{" "}
          <Link to="/app/clients" style={{ color: "#92400e", fontWeight: 700 }}>Add recipients in Clients → Email Settings</Link>
        </div>
      )}

      {showGuide && (
        <section className="onboarding-card" aria-labelledby="onboarding-title">
          <h3 id="onboarding-title">👋 Welcome to ClearToPay! Let's get you set up.</h3>
          <p className="onboarding-intro">Complete these three steps to start tracking vendor compliance.</p>
          {user?.inbox_address ? <p style={{ fontWeight: 700 }}>📥 Email documents to: {user.inbox_address}</p> : null}
          <div className="onboarding-steps">
            {steps.map((step, index) => (
              <div className={`onboarding-step${step.done ? " is-complete" : ""}`} key={step.href}>
                <span className="onboarding-check" aria-label={step.done ? "Complete" : "Not complete"}>{step.done ? "✓" : index + 1}</span>
                <a href={step.href}>{step.label}</a>
                {step.action && <a className="onboarding-action" href={step.href}>{step.action} →</a>}
              </div>
            ))}
          </div>
          {!hasClients && <button type="button" className="onboarding-help-prompt" onClick={() => openHelp("I have questions about getting set up.", "onboarding")}>Questions about getting set up? Ask our Onboarding Officer.</button>}
          <p className="onboarding-chat-hint">💬 Ask the AI assistant why a vendor is on hold or which vendors we've reached out to this week — click the <strong>Ask AI</strong> button.</p>
        </section>
      )}

      {(!showGuide || hasClients) && (
        <div className="metrics-grid">
          {metricCards.map((card) => (
            <div key={card.key} className="metric-card">
              <div className="metric-icon" style={{ backgroundColor: card.color }}>{card.icon}</div>
              <div className="metric-body">
                <span className="metric-label">{card.label}</span>
                <span className="metric-value" style={{ color: card.color }}>{stats ? stats[card.key] : 0}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="clear-to-pay-card" aria-labelledby="clear-to-pay-title">
        <div className="clear-to-pay-heading">
          <div><h3 id="clear-to-pay-title">Clear-to-Pay Summary</h3><p>Vendor payment readiness for the current payment week.</p></div>
        </div>
        <p style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted, #6b7280)" }}>Statuses below are informational flags based on documents on file and your configured criteria. Review source documents and verify coverage with your insurance agent or broker before making payment or coverage decisions.</p>
        {hasVendors && <p className="onboarding-chat-hint">💬 Ask the AI assistant why a vendor is on hold or which vendors we've reached out to this week — click the <strong>Ask AI</strong> button.</p>}
        {(["approved", "review", "hold"] as const).map((status) => {
          const labels = { approved: "Approved for Payment", review: "Review Before Payment", hold: "Hold Payment" };
          const vendors = clearToPay.filter((vendor) => vendor.payment_status === status);
          const open = expandedSections[status];
          return <div className={`readiness-section readiness-${status}`} key={status}>
            <button className="readiness-section-header" onClick={() => setExpandedSections((current) => ({ ...current, [status]: !current[status] }))} aria-expanded={open}>
              <span><span className="readiness-chevron">{open ? "▾" : "▸"}</span>{labels[status]}</span><span className="readiness-count">{vendors.length}</span>
            </button>
            {open && (vendors.length === 0 ? <div className="readiness-empty">No vendors in this category.</div> : <div className="readiness-table-wrap mobile-cards"><table className="readiness-table"><thead><tr><th>Vendor</th><th>Client</th><th>Compliance</th><th>Details</th></tr></thead><tbody>{vendors.map((vendor) => {
              const details = vendor.missing_documents.length ? `Missing: ${vendor.missing_documents.join(", ")}` : vendor.earliest_expiring_date ? `${vendor.earliest_expiring_type ?? "Document"} expires ${new Date(`${vendor.earliest_expiring_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "All required documents current";
              return <tr key={vendor.vendor_id}><td data-label="Vendor"><a href={`/app/vendors/${vendor.vendor_id}`}>{vendor.vendor_name}</a></td><td data-label="Client">{vendor.client_name}</td><td data-label="Compliance"><span className={`readiness-badge badge-${vendor.compliance_status}`}>{vendor.compliance_status.replace("_", " ")}</span></td><td data-label="Details">{details}</td></tr>;
            })}</tbody></table></div>)}
          </div>;
        })}
      </section>
    </div>
  );
}
