import { apiFetch } from "../lib/api";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardStats } from "@clear-to-pay/shared";
import { openHelp } from "../components/HelpWidget";
import { useAuth } from "../components/AuthContext";
import { inboxAddress } from "../lib/complianceInbox";
import ComplianceScore from "../components/ComplianceScore";

interface ClearToPayVendor {
  vendor_id: number;
  vendor_name: string;
  client_id: number;
  client_name: string;
  compliance_status: string;
  payment_status: "approved" | "review" | "hold";
  /** Derived 0-100 compliance score (null until the vendor has been scored). */
  compliance_score?: number | null;
  score_label?: "Good" | "Fair" | "Poor" | null;
  missing_documents: string[];
  earliest_expiring_date: string | null;
  earliest_expiring_type: string | null;
  reason?: string;
}

/**
 * One project in the dashboard's "By project" section (GET
 * /api/dashboard/clear-to-pay → projects). The counts come from the same
 * readiness query the Projects page uses, so the two can never disagree.
 */
interface ClearToPayProjectGroup {
  project_id: number;
  project_name: string;
  vendor_count: number;
  approved_count: number;
  review_count: number;
  hold_count: number;
  all_clear: boolean;
  vendors: ClearToPayVendor[];
}

/** The Details cell for a vendor row (shared by the flat and per-project tables). */
function vendorDetails(vendor: ClearToPayVendor): string {
  return vendor.reason ?? (vendor.missing_documents.length
    ? `Missing: ${vendor.missing_documents.join(", ")}`
    : vendor.earliest_expiring_date
      ? `${vendor.earliest_expiring_type ?? "Document"} expires ${new Date(`${vendor.earliest_expiring_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : "All required documents current");
}

/** One-line readiness read for a project (same wording as the Projects page). */
function projectReadinessText(project: ClearToPayProjectGroup): string {
  if (project.vendor_count === 0) return "No vendors assigned yet";
  if (project.all_clear) return `All ${project.vendor_count} approved for payment`;
  const parts: string[] = [];
  if (project.approved_count) parts.push(`${project.approved_count} approved`);
  if (project.review_count) parts.push(`${project.review_count} review`);
  if (project.hold_count) parts.push(`${project.hold_count} hold`);
  return parts.join(" · ");
}

/** Vendor rows for both readiness tables (identical columns). */
function readinessRows(vendors: ClearToPayVendor[]) {
  return vendors.map((vendor) => (
    <tr key={vendor.vendor_id}>
      <td data-label="Vendor"><a href={`/app/vendors/${vendor.vendor_id}`}>{vendor.vendor_name}</a></td>
      <td data-label="Company">{vendor.client_name}</td>
      <td data-label="Compliance"><span className={`readiness-badge badge-${vendor.compliance_status}`}>{vendor.compliance_status.replace("_", " ")}</span></td>
      <td data-label="Score"><ComplianceScore score={vendor.compliance_score} label={vendor.score_label} /></td>
      <td data-label="Details">{vendorDetails(vendor)}</td>
    </tr>
  ));
}

const readinessTableHeader = (
  <thead><tr><th>Vendor</th><th>Company</th><th>Compliance</th><th>Score</th><th>Details</th></tr></thead>
);


interface MetricCard {
  key: keyof DashboardStats;
  label: string;
  icon: string;
  color: string;
}

const metricCards: MetricCard[] = [
  { key: "total_clients", label: "Total Companies", icon: "▦", color: "#1a56db" },
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
  const [clearToPayProjects, setClearToPayProjects] = useState<ClearToPayProjectGroup[]>([]);
  const [unassignedVendors, setUnassignedVendors] = useState(0);
  const [expandedProjects, setExpandedProjects] = useState<Record<number, boolean>>({});
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
        // `projects` is empty for a tenant that doesn't use projects — the
        // By-project section is then not rendered at all.
        const payload = readiness as {
          vendors?: ClearToPayVendor[];
          projects?: ClearToPayProjectGroup[];
          unassigned_vendor_count?: number;
        };
        setClearToPay(payload.vendors ?? []);
        setClearToPayProjects(payload.projects ?? []);
        setUnassignedVendors(payload.unassigned_vendor_count ?? 0);
        // Compute the doc count from THIS fetch (not the stale state value —
        // setDocumentCount's new value isn't visible in this closure yet).
        const freshDocumentCount = Array.isArray(documents) ? documents.length : (documents as { documents?: unknown[] }).documents?.length ?? 0;
        setDocumentCount(freshDocumentCount);
        // Show the onboarding guide whenever the tenant is effectively empty:
        // no vendors AND no documents. That covers the zero-client state AND
        // the normal signup path where the setup wizard auto-created the
        // tenant's own client row (so total_clients >= 1 but there is still
        // nothing configured) — step 1 is marked done by the steps list below.
        setShowGuide(data.total_vendors === 0 && freshDocumentCount === 0);
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
    { label: "Add your first company", href: "/app/clients", done: hasClients, action: "Add Company" },
    { label: "Add vendors under that company — or email us your vendor list", href: "/app/vendors", done: hasVendors },
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
          No weekly report will be emailed until at least one company has report recipients set.{" "}
          <Link to="/app/clients" style={{ color: "#92400e", fontWeight: 700 }}>Go to Companies</Link>{" "}
          and use the ✉ Email action on a company's row to add recipients.
        </div>
      )}

      {showGuide && (
        <section className="onboarding-card" aria-labelledby="onboarding-title">
          <h3 id="onboarding-title">👋 Welcome to ClearToPay! Let's get you set up.</h3>
          <p className="onboarding-intro">Complete these three steps to start tracking vendor compliance.</p>
          {/* Finding #4: the marketing site promises "You hand us the list. We
              handle everything after that" — so the first thing a new client
              sees must actually say how to hand the list over. Importing from
              an emailed roster is the supported path; no upload widget is
              implied here. */}
          <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.5 }}>
            📋 <strong>Already have a vendor list?</strong> Email it — Excel, CSV, PDF, or
            just the names in the message — to{" "}
            <a
              href={`mailto:${inboxAddress(user)}?subject=${encodeURIComponent("Vendor list")}`}
              style={{ color: "var(--blue, #2563eb)", fontWeight: 600, wordBreak: "break-all" }}
            >
              {inboxAddress(user)}
            </a>{" "}
            and we'll import your vendors and their compliance requirements for you.
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.5 }}>
            📥 <strong>Vendor documents:</strong> share the same address with your
            subcontractors and their insurance agents so COIs and W-9s come straight into
            your account.
          </p>
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

      {/* Finding #4 (continued): a tenant can end up with documents on file
          but zero vendors, and the welcome guide above only renders in the
          fully-empty state. Keep the vendor-list handover reachable here so a
          client never sees 0 vendors with no way to hand over the roster. */}
      {stats && (stats.total_vendors ?? 0) === 0 && !showGuide && (
        <div style={{ background: "var(--blue-light, #eff6ff)", border: "1px solid var(--blue-100, #dbeafe)", borderLeft: "5px solid var(--blue, #2563eb)", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 13.5, lineHeight: 1.5, color: "var(--blue-700, #1d4ed8)" }}>
          📋 <strong>No vendors yet.</strong> Email your vendor list — Excel, CSV, PDF, or just
          the names in the message — to{" "}
          <a
            href={`mailto:${inboxAddress(user)}?subject=${encodeURIComponent("Vendor list")}`}
            style={{ color: "var(--blue, #2563eb)", fontWeight: 700, wordBreak: "break-all" }}
          >
            {inboxAddress(user)}
          </a>{" "}
          and we'll import your vendors and their compliance requirements for you. You can also{" "}
          <Link to="/app/vendors" style={{ color: "var(--blue, #2563eb)", fontWeight: 700 }}>add vendors yourself</Link>.
        </div>
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

      {/* ── By project: "is everyone on Project X clear to pay?" ──
          Only rendered when the tenant actually uses projects, so a tenant
          without projects sees the dashboard exactly as it was. */}
      {clearToPayProjects.length > 0 && (
        <section className="clear-to-pay-card" aria-labelledby="by-project-title">
          <div className="clear-to-pay-heading">
            <div>
              <h3 id="by-project-title">By Project</h3>
              <p>Payment readiness for the vendors on each of your projects.</p>
            </div>
            <Link className="setup-guide-link" to="/app/projects">Manage projects</Link>
          </div>
          <p style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted, #6b7280)" }}>Statuses below are informational flags based on documents on file and your configured criteria. Review source documents and verify coverage with your insurance agent or broker before making payment or coverage decisions.</p>
          {clearToPayProjects.map((project) => {
            const open = expandedProjects[project.project_id] === true;
            const tone = project.all_clear ? "approved" : project.hold_count > 0 ? "hold" : "review";
            return (
              <div className={`readiness-section readiness-${tone}`} key={project.project_id}>
                <button
                  className="readiness-section-header"
                  aria-expanded={open}
                  onClick={() => setExpandedProjects((current) => ({ ...current, [project.project_id]: !open }))}
                >
                  <span><span className="readiness-chevron">{open ? "▾" : "▸"}</span>{project.project_name}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {project.all_clear && <span className="badge badge-approved">All clear</span>}
                    <span className="readiness-count">{project.vendor_count}</span>
                  </span>
                </button>
                <div style={{ padding: "10px 16px 0", fontSize: 13, color: "var(--text-muted, #6b7280)" }}>
                  <Link to={`/app/projects/${project.project_id}`} style={{ color: "var(--blue, #1a56db)", fontWeight: 600 }}>{project.project_name}</Link>
                  {" — "}{projectReadinessText(project)}
                </div>
                {open && (project.vendors.length === 0
                  ? <div className="readiness-empty">No vendors assigned to this project yet. Open the project to assign them.</div>
                  : <div className="readiness-table-wrap mobile-cards"><table className="readiness-table">{readinessTableHeader}<tbody>{readinessRows(project.vendors)}</tbody></table></div>)}
              </div>
            );
          })}
          {unassignedVendors > 0 && (
            <p style={{ margin: "12px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted, #6b7280)" }}>
              {unassignedVendors} vendor{unassignedVendors === 1 ? " is" : "s are"} not assigned to a project yet. Assign them from a project's page to include them here — this does not change their payment status.
            </p>
          )}
        </section>
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
            {open && (vendors.length === 0 ? <div className="readiness-empty">No vendors in this category.</div> : <div className="readiness-table-wrap mobile-cards"><table className="readiness-table">{readinessTableHeader}<tbody>{readinessRows(vendors)}</tbody></table></div>)}
          </div>;
        })}
      </section>
    </div>
  );
}
