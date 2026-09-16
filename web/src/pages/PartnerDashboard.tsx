import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

interface PartnerProfile {
  id?: number;
  first_name?: string;
  last_name?: string;
  company_name?: string | null;
  referral_code?: string | null;
  status?: string;
  w9_uploaded?: boolean;
  w9_filename?: string | null;
  stripe?: StripeConnectState;
  payouts?: PayoutRow[];
}

interface StripeConnectState {
  stripe_account_id?: string | null;
  details_submitted?: boolean;
  currently_due?: string;
  payouts_enabled?: boolean;
  charges_enabled?: boolean;
  disconnected_at?: string | null;
  connect_status?: "not_connected" | "onboarding" | "active";
}

interface PayoutRow {
  id: number;
  amount: number | null;
  status: string;
  payment_method: string | null;
  transaction_ref: string | null;
  payment_date: string | null;
  notes: string | null;
  created_at: string | null;
}

interface Referral {
  id: number;
  referred_company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  referral_date: string | null;
  customer_status: string;
}

interface DashboardData {
  demo?: boolean;
  referral_code: string | null;
  referral_link: string | null;
  referring_enabled?: boolean;
  w9_required?: boolean;
  w9_uploaded?: boolean;
  w9_filename?: string | null;
  total_referrals: number;
  active_customers: number;
  pending_referrals: number;
  cancelled_customers: number;
  current_month_earnings: number;
  pending_commission: number;
  approved_commission: number;
  paid_commission: number;
  lifetime_earnings: number;
  next_expected_payout: number;
}

function money(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Status badge colors: lead=yellow, trial=blue, active=green,
// past_due=orange, cancelled/refunded=red (same mapping as My Referrals).
function statusBadge(status: string) {
  const cls: Record<string, string> = {
    lead: "badge-lead",
    trial: "badge-trial",
    active: "badge-active",
    past_due: "badge-past_due",
    cancelled: "badge-cancelled",
    refunded: "badge-refunded",
  };
  return <span className={`badge ${cls[status] ?? "badge-lead"}`}>{status.replace("_", " ")}</span>;
}

// Small copy button that shows "Copied!" for 2 seconds after clicking.
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard unavailable — fall back to a temporary textarea
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button type="button" className="btn btn-outline btn-sm copy-btn" onClick={copy}>
      {copied ? "Copied!" : label}
    </button>
  );
}

export default function PartnerDashboard() {
  const [profile, setProfile] = useState<PartnerProfile | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [w9File, setW9File] = useState<File | null>(null);
  const [w9Busy, setW9Busy] = useState(false);
  const [w9Msg, setW9Msg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch("/api/partner/me").then((res) => (res.ok ? res.json() : { partner: null })),
      apiFetch("/api/partner/dashboard").then((res) => (res.ok ? res.json() : null)),
      apiFetch("/api/partner/referrals").then((res) => (res.ok ? res.json() : { referrals: [] })),
    ])
      .then(([me, dash, refs]) => {
        const partner = (me as { partner?: PartnerProfile })?.partner ?? null;
        setProfile(partner);
        setData(dash as DashboardData | null);
        const rows = ((refs as { referrals?: Referral[] })?.referrals ?? []) as Referral[];
        // Newest referral first.
        rows.sort((a, b) => {
          const ta = a.referral_date ? new Date(a.referral_date).getTime() : 0;
          const tb = b.referral_date ? new Date(b.referral_date).getTime() : 0;
          return tb - ta;
        });
        setReferrals(rows);
        if (!dash) setError("Unable to load partner dashboard data.");
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load dashboard");
        setLoading(false);
      });
  }, []);

  useEffect(load, [load]);

  const handleW9Upload = useCallback(async () => {
    if (!w9File) return;
    setW9Busy(true);
    setW9Msg(null);
    try {
      const fd = new FormData();
      fd.append("w9", w9File);
      const res = await apiFetch("/api/partners/w9", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setW9Msg({ kind: "err", text: json?.error || `Upload failed (HTTP ${res.status})` });
        return;
      }
      setW9Msg({ kind: "ok", text: json?.partner?.message || "W-9 uploaded — you're ready to refer!" });
      setW9File(null);
      load(); // refresh dashboard: referral code + flags now come back enabled
    } catch (err: any) {
      setW9Msg({ kind: "err", text: err?.message || "Upload failed. Please try again." });
    } finally {
      setW9Busy(false);
    }
  }, [w9File, load]);

  const handleConnect = useCallback(async () => {
    if (!profile?.id) return;
    setConnectBusy(true);
    setConnectError(null);
    try {
      const res = await apiFetch(`/api/partners/${profile.id}/connect`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setConnectError(json?.error || `Request failed (HTTP ${res.status})`);
        return;
      }
      if (json?.url) {
        window.location.href = json.url; // redirect to Stripe's onboarding page
        return;
      }
      setConnectError("No onboarding URL returned by Stripe.");
    } catch (err: any) {
      setConnectError(err?.message || "Failed to start Stripe Connect onboarding");
    } finally {
      setConnectBusy(false);
    }
  }, [profile?.id]);

  if (loading) {
    return <div className="dashboard"><h2 className="page-title">Partner Dashboard</h2><div className="loading">Loading metrics…</div></div>;
  }

  if (error) {
    return <div className="dashboard"><h2 className="page-title">Partner Dashboard</h2><div className="error-message">Error: {error}</div></div>;
  }

  const name = profile?.first_name || profile?.last_name
    ? `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim()
    : null;
  const company = profile?.company_name || null;
  const referringEnabled = data?.referring_enabled !== false; // absent flag ⇒ enabled (back-compat)
  const referralCode = data?.referral_code || profile?.referral_code || null;
  // TODO: revert to www.cleartopayconstruction.com once the domain is restored
  const referralLink = data?.referral_link || (referralCode ? `https://cleartopay.ctonew.app/get-started?ref=${referralCode}` : null);

  const stats = [
    { key: "total_referrals", label: "Total Referrals", icon: "👥", color: "#1a56db", value: data?.total_referrals ?? 0 },
    { key: "active_customers", label: "Active Customers", icon: "✓", color: "#059669", value: data?.active_customers ?? 0 },
    { key: "current_month", label: "Current Month Earnings", icon: "📅", color: "#1a56db", value: money(data?.current_month_earnings) },
    { key: "lifetime", label: "Lifetime Earnings", icon: "💰", color: "#059669", value: money(data?.lifetime_earnings) },
  ];

  const statusCards = [
    { key: "pending_referrals", label: "Pending Referrals", value: String(data?.pending_referrals ?? 0), color: "#d97706" },
    { key: "cancelled", label: "Cancelled Customers", value: String(data?.cancelled_customers ?? 0), color: "#dc2626" },
    { key: "pending_comm", label: "Pending Commission", value: money(data?.pending_commission), color: "#d97706" },
    { key: "approved_comm", label: "Approved Commission", value: money(data?.approved_commission), color: "#1a56db" },
    { key: "paid_comm", label: "Paid Commission", value: money(data?.paid_commission), color: "#059669" },
    { key: "next_payout", label: "Next Expected Payout", value: money(data?.next_expected_payout), color: "#059669" },
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-heading">
        <div>
          <h2 className="page-title">Partner Dashboard</h2>
          {name && <p className="page-subtitle">{name}{company ? ` · ${company}` : ""}</p>}
          {data?.demo && (
            <p className="demo-badge" title="This is a demo partner. All clients, commissions and payouts shown are sample/demo data — not real clients and not real money.">Sample data</p>
          )}
        </div>
        {referringEnabled ? (
          <Link to="/app/partner/refer" className="btn btn-primary">Refer a Client</Link>
        ) : (
          <span className="btn btn-primary" style={{ opacity: 0.5, pointerEvents: "none" }} title="Upload your W-9 to unlock referring">
            Refer a Client
          </span>
        )}
      </div>

      {!referringEnabled && (
        <W9UnlockCard
          busy={w9Busy}
          msg={w9Msg}
          onFile={(f) => setW9File(f)}
          file={w9File}
          onUpload={handleW9Upload}
        />
      )}

      {referralCode && (
        <section className="referral-code-card">
          <div className="referral-code-info">
            <span className="referral-code-label">Your referral code</span>
            <span className="referral-code">{referralCode}</span>
          </div>
          <div className="referral-code-actions">
            <CopyButton text={referralCode} label="Copy Code" />
            {referralLink && <CopyButton text={referralLink} label="Copy Link" />}
          </div>
          {referralLink && <p className="referral-code-link">Share your link: <span className="referral-link-text">{referralLink}</span></p>}
        </section>
      )}

      {/* Next payout — commissions accrued (approved/scheduled) since the last payout */}
      <section className="next-payout-card">
        <div className="next-payout-info">
          <span className="referral-code-label">Next payout</span>
          <span className="next-payout-amount">{money(data?.next_expected_payout)}</span>
          <p className="next-payout-caption">
            Commissions accrued and approved since your last payout — this is the amount scheduled to be
            paid on the next payout run.
          </p>
        </div>
        <div className="next-payout-action">
          <Link to="/app/partner/payouts" className="btn btn-outline btn-sm">View payouts</Link>
          <Link to="/app/partner/commissions" className="btn btn-outline btn-sm">View commissions</Link>
        </div>
      </section>

      <StripeConnectCard
        stripe={profile?.stripe}
        payouts={profile?.payouts}
        busy={connectBusy}
        error={connectError}
        onConnect={handleConnect}
      />

      <div className="metrics-grid">
        {stats.map((card) => (
          <div key={card.key} className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: card.color }}>{card.icon}</div>
            <div className="metric-body">
              <span className="metric-label">{card.label}</span>
              <span className="metric-value" style={{ color: card.color }}>{card.value}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="partner-status-grid">
        {statusCards.map((card) => (
          <div key={card.key} className="partner-status-card">
            <span className="partner-status-label">{card.label}</span>
            <span className="partner-status-value" style={{ color: card.color }}>{card.value}</span>
          </div>
        ))}
      </div>

      {/* Referral-client list */}
      <section className="referral-code-card" style={{ marginTop: 20 }}>
        <div className="referral-list-header">
          <h3 className="section-title">Referred clients</h3>
          <Link to="/app/partner/referrals" className="btn btn-outline btn-sm">View all referrals</Link>
        </div>
        {referrals.length === 0 ? (
          <p className="stripe-connect-hint" style={{ marginTop: 10 }}>
            No referrals yet — share your link or submit your first referral.
          </p>
        ) : (
          <div className="table-wrapper" style={{ marginTop: 12 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Contact</th>
                  <th>Referred</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {referrals.slice(0, 10).map((r) => (
                  <tr key={r.id}>
                    <td className="td-name">{r.referred_company || "—"}</td>
                    <td>{r.contact_name || "—"}</td>
                    <td>{fmtDate(r.referral_date)}</td>
                    <td>{statusBadge(r.customer_status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Stripe Connect card (delegation B) ────────────────────
// Shows connect status (Not connected / Onboarding / Active), a button that
// starts Connect Express onboarding (redirects to Stripe), and recent payout
// history with transfer references.
function StripeConnectCard({
  stripe, payouts, busy, error, onConnect,
}: {
  stripe?: StripeConnectState;
  payouts?: PayoutRow[];
  busy: boolean;
  error: string | null;
  onConnect: () => void;
}) {
  const status = stripe?.connect_status ?? "not_connected";
  const badge =
    status === "active" ? <span className="badge badge-active">Active</span>
    : status === "onboarding" ? <span className="badge badge-pending">Onboarding</span>
    : <span className="badge badge-rejected">Not connected</span>;

  const recent = (payouts ?? []).slice(0, 5);

  return (
    <section className="referral-code-card stripe-connect-card">
      <div className="stripe-connect-header">
        <div className="stripe-connect-title">
          <span style={{ fontSize: "20px", marginRight: "8px" }}>🏦</span>
          <span className="referral-code-label">Stripe Connect payouts</span>
          {badge}
        </div>
        {status !== "active" && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onConnect} disabled={busy}>
            {busy ? "Connecting…" : "Connect Stripe account"}
          </button>
        )}
      </div>
      {error && <p className="error-message" style={{ marginTop: "8px" }}>Error: {error}</p>}
      {status !== "active" && (
        <p className="stripe-connect-hint">
          Connect a Stripe account to receive your commission payouts by direct transfer.
          {status === "onboarding" ? " Your account exists but isn't fully onboarded yet — finish the Stripe steps or click connect again." : ""}
        </p>
      )}
      {status === "active" && stripe?.stripe_account_id && (
        <p className="stripe-connect-hint">
          Payouts are transferred to your connected Stripe account (<code>{stripe.stripe_account_id}</code>).
        </p>
      )}
      <div className="table-wrapper" style={{ marginTop: "12px" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Transfer ref</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: "center", color: "#6b7280" }}>No payouts yet.</td></tr>
            )}
            {recent.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.payment_date || p.created_at)}</td>
                <td>{money(p.amount)}</td>
                <td>{p.status.replace("_", " ")}</td>
                <td>{p.transaction_ref ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(payouts ?? []).length > 5 && (
        <p style={{ marginTop: "8px" }}><Link to="/app/partner/payouts" className="btn btn-outline btn-sm">View all payouts</Link></p>
      )}
    </section>
  );
}

// ── W-9 unlock card ──────────────────────────────────────
// Shown when the partner has no W-9 on file (referral_code NULL ⇒ referring
// disabled). Uploading calls POST /api/partners/w9, which stores the file and
// generates the referral code — after that, referring is enabled.
function W9UnlockCard({
  busy, msg, file, onFile, onUpload,
}: {
  busy: boolean;
  msg: { kind: "ok" | "err"; text: string } | null;
  file: File | null;
  onFile: (f: File | null) => void;
  onUpload: () => void;
}) {
  return (
    <section className="referral-code-card" style={{ borderColor: "#d97706", background: "linear-gradient(135deg, #fffbeb 0%, #fff 100%)" }}>
      <div className="referral-code-info">
        <div>
          <span className="referral-code-label" style={{ color: "#92400e" }}>Upload your W-9 to unlock referring</span>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "#78350f", maxWidth: 520 }}>
            You're approved — one step left. A W-9 is required before you can
            refer clients and start earning. Upload a PDF, JPG, or PNG (max 10MB)
            and your referral link unlocks immediately.
          </p>
        </div>
      </div>
      <div className="referral-code-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          style={{ maxWidth: 260 }}
          disabled={busy}
        />
        <button type="button" className="btn btn-primary" onClick={onUpload} disabled={busy || !file}>
          {busy ? "Uploading…" : "Upload W-9"}
        </button>
      </div>
      {file && !busy && (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: "#059669" }}>✓ {file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
      )}
      {msg && (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: msg.kind === "ok" ? "#059669" : "#b91c1c" }}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
