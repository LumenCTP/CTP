import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { money, fmtDate, Badge, useToast, Modal, LoadingBlock, ErrorBlock } from "./common";

interface Commission {
  id: number;
  partner_id: number;
  partner_name?: string | null;
  referral_id: number | null;
  customer_name?: string | null;
  tenant_id?: number | null;
  billing_period: string | null;
  eligible_revenue: number;
  commission_percentage: number;
  commission_amount: number;
  earned_date: string | null;
  status: string;
  payout_id?: number | null;
}

interface Partner {
  id: number;
  first_name: string;
  last_name: string;
  company_name: string | null;
  commission_percentage?: number;
}

interface Referral {
  id: number;
  partner_id: number;
  referred_company: string | null;
  contact_name: string | null;
  contact_email: string | null;
}

const STATUS_OPTIONS = ["all", "pending", "approved", "scheduled", "paid", "reversed", "disputed"];
const ACTIONABLE = new Set(["pending", "approved", "scheduled"]);

export default function AdminCommissions() {
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fPartner, setFPartner] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fStart, setFStart] = useState("");
  const [fEnd, setFEnd] = useState("");
  const [actionFor, setActionFor] = useState<Commission | null>(null);
  const [actionType, setActionType] = useState<"approve" | "reverse" | "dispute" | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  // create form state
  const [cPartner, setCPartner] = useState("");
  const [cReferral, setCReferral] = useState("");
  const [cPeriod, setCPeriod] = useState("");
  const [cRevenue, setCRevenue] = useState("");
  const [cPct, setCPct] = useState("");
  const { toastEl, show } = useToast();

  const load = () => {
    setLoading(true);
    apiFetch("/api/commissions")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch commissions");
        return res.json();
      })
      .then((data) => {
        setCommissions((data.commissions ?? []) as Commission[]);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(load, []);

  useEffect(() => {
    apiFetch("/api/partners")
      .then((res) => (res.ok ? res.json() : { partners: [] }))
      .then((data) => setPartners((data.partners ?? []) as Partner[]))
      .catch(() => {});
    apiFetch("/api/referrals")
      .then((res) => (res.ok ? res.json() : { referrals: [] }))
      .then((data) => setReferrals((data.referrals ?? []) as Referral[]))
      .catch(() => {});
  }, []);

  // When the partner is chosen in the create form, auto-fill their default commission %.
  const selectedPartner = useMemo(() => partners.find((p) => p.id === Number(cPartner)), [partners, cPartner]);
  useEffect(() => {
    if (selectedPartner) setCPct(String(selectedPartner.commission_percentage ?? 25));
  }, [selectedPartner]);

  const partnerReferrals = useMemo(
    () => referrals.filter((r) => r.partner_id === Number(cPartner)),
    [referrals, cPartner]
  );

  const filtered = useMemo(() => {
    return commissions.filter((c) => {
      if (fPartner && c.partner_id !== Number(fPartner)) return false;
      if (fStatus !== "all" && c.status !== fStatus) return false;
      if (fStart && c.earned_date && c.earned_date < `${fStart}T00:00:00`) return false;
      if (fEnd && c.earned_date && c.earned_date > `${fEnd}T23:59:59`) return false;
      return true;
    });
  }, [commissions, fPartner, fStatus, fStart, fEnd]);

  const partnerName = (p: Partner) => `${p.first_name} ${p.last_name}`.trim();

  const runAction = async () => {
    if (!actionFor || !actionType) return;
    if (actionType !== "approve" && !actionReason.trim()) {
      show("error", `A reason is required to ${actionType} a commission`);
      return;
    }
    setBusy(true);
    try {
      const newStatus = actionType === "approve" ? "approved" : actionType;
      const res = await apiFetch(`/api/commissions/${actionFor.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus, reason: actionReason.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed");
      show("success", `Commission ${actionType === "approve" ? "approved" : actionType + "d"}`);
      setActionFor(null);
      setActionType(null);
      setActionReason("");
      load();
    } catch (err) {
      show("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createCommission = async () => {
    if (!cPartner || !Number.isFinite(Number(cRevenue))) {
      show("error", "Partner and eligible revenue are required");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch("/api/commissions", {
        method: "POST",
        body: JSON.stringify({
          partner_id: Number(cPartner),
          referral_id: cReferral ? Number(cReferral) : null,
          billing_period: cPeriod.trim() || null,
          eligible_revenue: Number(cRevenue),
          commission_percentage: Number(cPct),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create commission");
      show("success", "Commission created");
      setShowCreate(false);
      setCPartner(""); setCReferral(""); setCPeriod(""); setCRevenue(""); setCPct("");
      load();
    } catch (err) {
      show("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const referralLabel = (r: Referral) => r.referred_company || r.contact_name || r.contact_email || `#${r.id}`;

  return (
    <div className="dashboard">
      {toastEl}
      <div className="dashboard-heading">
        <div>
          <h2 className="page-title">Commissions</h2>
          <p className="page-subtitle">Commission records across all partners.</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setShowCreate(true); setCPartner(""); setCReferral(""); setCPeriod(""); setCRevenue(""); setCPct(""); }}>
          + Create Commission
        </button>
      </div>

      <div className="filter-bar" style={{ flexWrap: "wrap" }}>
        <select className="form-select" value={fPartner} onChange={(e) => setFPartner(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">All partners</option>
          {partners.map((p) => <option key={p.id} value={p.id}>{partnerName(p)}</option>)}
        </select>
        <select className="form-select" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        <label>From <input className="form-input" type="date" value={fStart} onChange={(e) => setFStart(e.target.value)} /></label>
        <label>To <input className="form-input" type="date" value={fEnd} onChange={(e) => setFEnd(e.target.value)} /></label>
      </div>

      {loading && <LoadingBlock label="Loading commissions…" />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Partner</th>
                <th>Customer</th>
                <th>Billing Period</th>
                <th>Revenue</th>
                <th>%</th>
                <th>Commission Amount</th>
                <th>Status</th>
                <th>Earned Date</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No commissions found.</td></tr>
              ) : filtered.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => { setActionFor(c); setActionType(null); setActionReason(""); }}
                  style={{ cursor: "pointer" }}
                >
                  <td className="td-name">{c.partner_name || `Partner #${c.partner_id}`}</td>
                  <td>{c.customer_name || "—"}</td>
                  <td>{c.billing_period || "—"}</td>
                  <td>{money(c.eligible_revenue)}</td>
                  <td>{c.commission_percentage}%</td>
                  <td><strong>{money(c.commission_amount)}</strong></td>
                  <td><Badge status={c.status} /></td>
                  <td>{fmtDate(c.earned_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Commission action modal */}
      {actionFor && (
        <Modal
          title={`Commission — ${money(actionFor.commission_amount)}`}
          onClose={() => setActionFor(null)}
          footer={
            <>
              <button className="btn btn-outline" onClick={() => setActionFor(null)}>Close</button>
              {ACTIONABLE.has(actionFor.status) && !actionType && (
                <>
                  <button className="btn btn-primary" onClick={() => setActionType("approve")}>Approve</button>
                  <button className="btn btn-outline" onClick={() => setActionType("reverse")}>Reverse</button>
                  <button className="btn btn-outline" onClick={() => setActionType("dispute")}>Dispute</button>
                </>
              )}
              {actionType && (
                <>
                  <button className="btn btn-outline" onClick={() => setActionType(null)}>Back</button>
                  <button
                    className={actionType === "approve" ? "btn btn-primary" : "btn btn-danger"}
                    disabled={busy || (actionType !== "approve" && !actionReason.trim())}
                    onClick={runAction}
                  >
                    Confirm {actionType === "approve" ? "Approve" : actionType === "reverse" ? "Reverse" : "Dispute"}
                  </button>
                </>
              )}
            </>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {[
              ["Partner", actionFor.partner_name || `#${actionFor.partner_id}`],
              ["Customer", actionFor.customer_name || "—"],
              ["Billing Period", actionFor.billing_period || "—"],
              ["Eligible Revenue", money(actionFor.eligible_revenue)],
              ["Commission %", `${actionFor.commission_percentage}%`],
              ["Earned Date", fmtDate(actionFor.earned_date)],
              ["Status", <Badge key="s" status={actionFor.status} />],
              ["Commission", money(actionFor.commission_amount)],
            ].map(([label, value]) => (
              <div key={String(label)} style={{ background: "var(--gray-50)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--gray-500)", textTransform: "uppercase" }}>{label}</div>
                <div style={{ fontSize: "0.9rem", color: "var(--gray-800)", marginTop: 2 }}>{value}</div>
              </div>
            ))}
          </div>
          {actionType && actionType !== "approve" && (
            <div className="form-group">
              <label>Reason for {actionType} (required)</label>
              <textarea className="form-input" rows={2} value={actionReason} onChange={(e) => setActionReason(e.target.value)} placeholder={`Why is this commission being ${actionType}d?`} />
            </div>
          )}
          {actionType === "approve" && (
            <p className="text-sm" style={{ color: "var(--gray-500)" }}>Approving schedules this commission for the next payout.</p>
          )}
        </Modal>
      )}

      {/* Create commission modal */}
      {showCreate && (
        <Modal
          title="Create Commission"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button className="btn btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={createCommission}>Create</button>
            </>
          }
        >
          <div className="form-group">
            <label>Partner</label>
            <select className="form-select" value={cPartner} onChange={(e) => { setCPartner(e.target.value); setCReferral(""); }}>
              <option value="">Select partner…</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{partnerName(p)}{p.company_name ? ` — ${p.company_name}` : ""}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Referral (optional)</label>
            <select className="form-select" value={cReferral} onChange={(e) => setCReferral(e.target.value)} disabled={!cPartner}>
              <option value="">— none —</option>
              {partnerReferrals.map((r) => <option key={r.id} value={r.id}>{referralLabel(r)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Billing Period</label>
            <input className="form-input" type="month" value={cPeriod} onChange={(e) => setCPeriod(e.target.value)} placeholder="2026-08" />
          </div>
          <div className="form-group">
            <label>Eligible Revenue ($)</label>
            <input className="form-input" type="number" min={0} step={0.01} value={cRevenue} onChange={(e) => setCRevenue(e.target.value)} placeholder="0.00" />
          </div>
          <div className="form-group">
            <label>Commission % (auto-filled from partner default)</label>
            <input className="form-input" type="number" min={0} max={100} step={0.5} value={cPct} onChange={(e) => setCPct(e.target.value)} />
            {cRevenue && Number(cRevenue) > 0 && Number(cPct) > 0 && (
              <p className="text-sm" style={{ color: "var(--gray-600)", marginTop: 6 }}>
                Commission amount: <strong>{money(Number(cRevenue) * Number(cPct) / 100)}</strong>
              </p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
