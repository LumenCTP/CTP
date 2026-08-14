import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { money, fmtDate, Badge, useToast, Modal, LoadingBlock, ErrorBlock } from "./common";

interface Partner {
  id: number;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string;
  phone?: string | null;
  address?: string | null;
  website?: string | null;
  states_served?: string | null;
  partner_type: string;
  tax_info_status?: string | null;
  preferred_payout_method?: string | null;
  status: string;
  referral_code?: string | null;
  commission_percentage: number;
  created_at?: string | null;
  total_referrals: number;
  commission_totals?: {
    lifetime_earnings: number;
    paid_earnings: number;
    outstanding_earnings: number;
    commission_count: number;
  };
}

interface ReferralRow {
  id: number;
  customer_status: string;
}

const STATUS_TABS = ["all", "pending", "approved", "suspended", "rejected", "terminated"];

export default function AdminPartners() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusTab, setStatusTab] = useState("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Partner | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeCustomers, setActiveCustomers] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [showCommissionForm, setShowCommissionForm] = useState(false);
  const [commissionPct, setCommissionPct] = useState("");
  const [commissionReason, setCommissionReason] = useState("");
  const [reason, setReason] = useState("");
  const [pendingAction, setPendingAction] = useState<"reject" | "suspend" | "terminate" | null>(null);
  const { toastEl, show } = useToast();

  const load = () => {
    setLoading(true);
    apiFetch("/api/partners")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch partners");
        return res.json();
      })
      .then((data) => {
        setPartners((data.partners ?? []) as Partner[]);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return partners.filter((p) => {
      if (statusTab !== "all" && p.status !== statusTab) return false;
      if (!q) return true;
      return [p.first_name, p.last_name, p.company_name, p.email]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [partners, statusTab, search]);

  const openDetail = (p: Partner) => {
    setDetail(p);
    setDetailLoading(true);
    setPendingAction(null);
    setShowCommissionForm(false);
    setReason("");
    setCommissionPct(String(p.commission_percentage ?? 25));
    setCommissionReason("");
    // Fetch per-partner stats (detail + active customer count).
    Promise.all([
      apiFetch(`/api/partners/${p.id}`).then((res) => (res.ok ? res.json() : null)),
      apiFetch(`/api/referrals?partner_id=${p.id}`).then((res) => (res.ok ? res.json() : { referrals: [] })),
    ])
      .then(([detailData, refData]) => {
        if (detailData?.partner) setDetail(detailData.partner as Partner);
        const refs = (refData?.referrals ?? []) as ReferralRow[];
        setActiveCustomers(refs.filter((r) => r.customer_status === "active").length);
        setDetailLoading(false);
      })
      .catch(() => setDetailLoading(false));
  };

  const changeStatus = async (newStatus: string) => {
    if (!detail) return;
    if (["rejected", "suspended", "terminated"].includes(newStatus) && !reason.trim()) {
      show("error", `A reason is required to ${newStatus} a partner`);
      return;
    }
    setActionBusy(true);
    try {
      const res = await apiFetch(`/api/partners/${detail.id}/status`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus, reason: reason.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed");
      show("success", `Partner ${newStatus === "approved" ? "approved — referral code generated" : newStatus}`);
      setDetail((d) => (d ? { ...d, ...data.partner } : d));
      setPendingAction(null);
      setReason("");
      load();
    } catch (err) {
      show("error", (err as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  const saveCommission = async () => {
    if (!detail) return;
    const pct = Number(commissionPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      show("error", "Commission % must be between 0 and 100");
      return;
    }
    if (!commissionReason.trim()) {
      show("error", "A reason is required to change the commission rate");
      return;
    }
    setActionBusy(true);
    try {
      const res = await apiFetch(`/api/partners/${detail.id}/commission`, {
        method: "PUT",
        body: JSON.stringify({ commission_percentage: pct, reason: commissionReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update commission");
      show("success", "Commission percentage updated");
      setDetail((d) => (d ? { ...d, commission_percentage: pct } : d));
      setShowCommissionForm(false);
      load();
    } catch (err) {
      show("error", (err as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  const name = (p: Partner) => `${p.first_name} ${p.last_name}`.trim();

  return (
    <div className="dashboard">
      {toastEl}
      <h2 className="page-title">Partners</h2>
      <p className="page-subtitle">Manage partner applications and program membership.</p>

      <div className="filter-bar" style={{ flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              className={`btn btn-sm ${statusTab === s ? "btn-primary" : "btn-outline"}`}
              onClick={() => setStatusTab(s)}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <input
          className="form-input"
          placeholder="Search name, company, email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 280 }}
        />
      </div>

      {loading && <LoadingBlock label="Loading partners…" />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Company</th>
                <th>Email</th>
                <th>Partner Type</th>
                <th>Status</th>
                <th>Referral Code</th>
                <th>Total Referrals</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr className="table-empty"><td colSpan={8}>No partners found.</td></tr>
              ) : filtered.map((p) => (
                <tr key={p.id} onClick={() => openDetail(p)} style={{ cursor: "pointer" }}>
                  <td className="td-name">{name(p)}</td>
                  <td>{p.company_name || "—"}</td>
                  <td>{p.email}</td>
                  <td>{p.partner_type}</td>
                  <td><Badge status={p.status} /></td>
                  <td>{p.referral_code || "—"}</td>
                  <td>{p.total_referrals}</td>
                  <td>{fmtDate(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail modal */}
      {detail && (
        <Modal
          title={`Partner — ${name(detail)}`}
          wide
          onClose={() => setDetail(null)}
          footer={
            <button className="btn btn-outline" onClick={() => setDetail(null)}>Close</button>
          }
        >
          {detailLoading ? (
            <LoadingBlock label="Loading partner details…" />
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 18 }}>
                {[
                  ["Company", detail.company_name || "—"],
                  ["Email", detail.email],
                  ["Phone", detail.phone || "—"],
                  ["Partner Type", detail.partner_type],
                  ["Status", <Badge key="s" status={detail.status} />],
                  ["Referral Code", detail.referral_code || "—"],
                  ["Commission %", `${detail.commission_percentage ?? 25}%`],
                  ["Tax Info", detail.tax_info_status || "—"],
                  ["Payout Method", detail.preferred_payout_method || "—"],
                  ["States Served", detail.states_served || "—"],
                  ["Website", detail.website || "—"],
                  ["Created", fmtDate(detail.created_at)],
                ].map(([label, value]) => (
                  <div key={String(label)} style={{ background: "var(--gray-50)", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--gray-500)", textTransform: "uppercase", letterSpacing: "0.03em" }}>{label}</div>
                    <div style={{ fontSize: "0.9rem", color: "var(--gray-800)", wordBreak: "break-word", marginTop: 2 }}>{value}</div>
                  </div>
                ))}
              </div>

              <div className="partner-status-grid" style={{ marginBottom: 18 }}>
                {[
                  ["Total Referrals", String(detail.total_referrals ?? 0), "#1a56db"],
                  ["Active Customers", String(activeCustomers), "#059669"],
                  ["Lifetime Commissions", money(detail.commission_totals?.lifetime_earnings), "#059669"],
                  ["Total Paid", money(detail.commission_totals?.paid_earnings), "#059669"],
                ].map(([label, value, color]) => (
                  <div key={String(label)} className="partner-status-card">
                    <span className="partner-status-label">{label}</span>
                    <span className="partner-status-value" style={{ color: String(color) }}>{value}</span>
                  </div>
                ))}
              </div>

              {detail.referral_code && (
                <p className="referral-code-card" style={{ marginTop: 0 }}>
                  <span className="referral-code-label">Referral code</span>{" "}
                  <span className="referral-code">{detail.referral_code}</span>
                </p>
              )}

              {/* Status-change actions */}
              <div style={{ marginBottom: 14 }}>
                <strong style={{ fontSize: "0.8rem", color: "var(--gray-600)" }}>Actions</strong>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  {detail.status === "pending" && (
                    <button className="btn btn-primary btn-sm" disabled={actionBusy} onClick={() => changeStatus("approved")}>
                      Approve
                    </button>
                  )}
                  {detail.status === "pending" && (
                    <button className="btn btn-danger btn-sm" disabled={actionBusy} onClick={() => { setPendingAction("reject"); setReason(""); }}>
                      Reject
                    </button>
                  )}
                  {detail.status === "approved" && (
                    <button className="btn btn-outline btn-sm" disabled={actionBusy} onClick={() => { setPendingAction("suspend"); setReason(""); }}>
                      Suspend
                    </button>
                  )}
                  {(detail.status === "approved" || detail.status === "suspended") && (
                    <button className="btn btn-danger-outline btn-sm" disabled={actionBusy} onClick={() => { setPendingAction("terminate"); setReason(""); }}>
                      Terminate
                    </button>
                  )}
                  <button className="btn btn-outline btn-sm" onClick={() => { setShowCommissionForm((v) => !v); setCommissionPct(String(detail.commission_percentage ?? 25)); setCommissionReason(""); }}>
                    Set Custom Commission %
                  </button>
                </div>
              </div>

              {/* Reason prompt for reject/suspend/terminate */}
              {pendingAction && (
                <div className="form-group" style={{ background: "var(--gray-50)", padding: 12, borderRadius: 8 }}>
                  <label>Reason for {pendingAction}</label>
                  <textarea
                    className="form-input"
                    rows={2}
                    placeholder={`Required — explain why this partner is being ${pendingAction}d`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="btn btn-danger btn-sm" disabled={actionBusy || !reason.trim()} onClick={() => changeStatus(pendingAction)}>
                      Confirm {pendingAction}
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => setPendingAction(null)}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Commission form */}
              {showCommissionForm && (
                <div className="form-group" style={{ background: "var(--gray-50)", padding: 12, borderRadius: 8 }}>
                  <label>Custom Commission Percentage (%)</label>
                  <input
                    className="form-input"
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={commissionPct}
                    onChange={(e) => setCommissionPct(e.target.value)}
                  />
                  <label style={{ marginTop: 10 }}>Reason</label>
                  <textarea
                    className="form-input"
                    rows={2}
                    placeholder="Required — why is the rate changing?"
                    value={commissionReason}
                    onChange={(e) => setCommissionReason(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="btn btn-primary btn-sm" disabled={actionBusy} onClick={saveCommission}>Save</button>
                    <button className="btn btn-outline btn-sm" onClick={() => setShowCommissionForm(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
