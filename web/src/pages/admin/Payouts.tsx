import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { money, fmtDate, Badge, useToast, Modal, LoadingBlock, ErrorBlock } from "./common";

interface Payout {
  id: number;
  partner_id: number;
  partner_name?: string | null;
  amount: number;
  status: string;
  payment_date: string | null;
  payment_method: string | null;
  transaction_ref: string | null;
  notes?: string | null;
  created_at?: string | null;
}

interface Commission {
  id: number;
  partner_id: number;
  customer_name?: string | null;
  billing_period: string | null;
  commission_amount: number;
  status: string;
  earned_date: string | null;
  payout_id?: number | null;
}

interface Partner {
  id: number;
  first_name: string;
  last_name: string;
  company_name: string | null;
}

export default function AdminPayouts() {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [pPartner, setPPartner] = useState("");
  const [pAmount, setPAmount] = useState("");
  const [pMethod, setPMethod] = useState("");
  const [pRef, setPRef] = useState("");
  const [pNotes, setPNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Payout | null>(null);
  const { toastEl, show } = useToast();

  const load = () => {
    setLoading(true);
    apiFetch("/api/admin/payouts")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch payouts");
        return res.json();
      })
      .then((data) => {
        setPayouts((data.payouts ?? []) as Payout[]);
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
    apiFetch("/api/commissions")
      .then((res) => (res.ok ? res.json() : { commissions: [] }))
      .then((data) => setCommissions((data.commissions ?? []) as Commission[]))
      .catch(() => {});
  }, []);

  const partnerName = (p: Partner) => `${p.first_name} ${p.last_name}`.trim();

  // Approved/scheduled commission balance for the selected partner → auto-fill.
  const approvedBalance = useMemo(() => {
    if (!pPartner) return 0;
    return commissions
      .filter((c) => c.partner_id === Number(pPartner) && (c.status === "approved" || c.status === "scheduled"))
      .reduce((sum, c) => sum + Number(c.commission_amount || 0), 0);
  }, [commissions, pPartner]);

  const openCreate = () => {
    setShowCreate(true);
    setPPartner("");
    setPAmount("");
    setPMethod("");
    setPRef("");
    setPNotes("");
  };

  const onPartnerSelect = (id: string) => {
    setPPartner(id);
    const balance = commissions
      .filter((c) => c.partner_id === Number(id) && (c.status === "approved" || c.status === "scheduled"))
      .reduce((sum, c) => sum + Number(c.commission_amount || 0), 0);
    setPAmount(balance > 0 ? String(balance) : "");
  };

  const createPayout = async () => {
    if (!pPartner || !Number.isFinite(Number(pAmount)) || Number(pAmount) < 0) {
      show("error", "Partner and a valid amount are required");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch("/api/payouts", {
        method: "POST",
        body: JSON.stringify({
          partner_id: Number(pPartner),
          amount: Number(pAmount),
          payment_method: pMethod.trim() || null,
          transaction_ref: pRef.trim() || null,
          notes: pNotes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to record payout");
      show("success", "Payout recorded — approved commissions marked as paid");
      setShowCreate(false);
      load();
    } catch (err) {
      show("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const linkedCommissions = useMemo(
    () => (detail ? commissions.filter((c) => c.payout_id === detail.id) : []),
    [commissions, detail]
  );

  return (
    <div className="dashboard">
      {toastEl}
      <div className="dashboard-heading">
        <div>
          <h2 className="page-title">Payouts</h2>
          <p className="page-subtitle">Record and track partner payouts.</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Record Payout</button>
      </div>

      {loading && <LoadingBlock label="Loading payouts…" />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Partner</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Payment Date</th>
                <th>Method</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {payouts.length === 0 ? (
                <tr><td colSpan={6} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No payouts recorded yet.</td></tr>
              ) : payouts.map((po) => (
                <tr key={po.id} onClick={() => setDetail(po)} style={{ cursor: "pointer" }}>
                  <td className="td-name">{po.partner_name || `Partner #${po.partner_id}`}</td>
                  <td><strong>{money(po.amount)}</strong></td>
                  <td><Badge status={po.status} /></td>
                  <td>{fmtDate(po.payment_date || po.created_at)}</td>
                  <td>{po.payment_method || "—"}</td>
                  <td>{po.transaction_ref || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Record payout modal */}
      {showCreate && (
        <Modal
          title="Record Payout"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button className="btn btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={createPayout}>Record Payout</button>
            </>
          }
        >
          <div className="form-group">
            <label>Partner</label>
            <select className="form-select" value={pPartner} onChange={(e) => onPartnerSelect(e.target.value)}>
              <option value="">Select partner…</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{partnerName(p)}{p.company_name ? ` — ${p.company_name}` : ""}</option>)}
            </select>
            {pPartner && (
              <p className="text-sm" style={{ color: "var(--gray-600)", marginTop: 6 }}>
                Approved commission balance: <strong>{money(approvedBalance)}</strong>
              </p>
            )}
          </div>
          <div className="form-group">
            <label>Amount ($)</label>
            <input className="form-input" type="number" min={0} step={0.01} value={pAmount} onChange={(e) => setPAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div className="form-group">
            <label>Payment Method</label>
            <select className="form-select" value={pMethod} onChange={(e) => setPMethod(e.target.value)}>
              <option value="">— select —</option>
              <option value="ach">ACH</option>
              <option value="paypal">PayPal</option>
              <option value="venmo">Venmo</option>
              <option value="check">Check</option>
              <option value="wire">Wire</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="form-group">
            <label>Transaction Reference</label>
            <input className="form-input" value={pRef} onChange={(e) => setPRef(e.target.value)} placeholder="e.g. ACH confirmation #" />
          </div>
          <div className="form-group">
            <label>Notes</label>
            <textarea className="form-input" rows={2} value={pNotes} onChange={(e) => setPNotes(e.target.value)} placeholder="Optional notes…" />
          </div>
          <p className="text-sm" style={{ color: "var(--gray-500)" }}>
            Recording a payout marks all of this partner's approved commissions as paid and links them to this payout.
          </p>
        </Modal>
      )}

      {/* Payout detail modal */}
      {detail && (
        <Modal
          title={`Payout — ${money(detail.amount)}`}
          wide
          onClose={() => setDetail(null)}
          footer={<button className="btn btn-outline" onClick={() => setDetail(null)}>Close</button>}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
            {[
              ["Partner", detail.partner_name || `Partner #${detail.partner_id}`],
              ["Amount", money(detail.amount)],
              ["Status", <Badge key="s" status={detail.status} />],
              ["Payment Date", fmtDate(detail.payment_date || detail.created_at)],
              ["Method", detail.payment_method || "—"],
              ["Reference", detail.transaction_ref || "—"],
              ["Notes", detail.notes || "—"],
            ].map(([label, value]) => (
              <div key={String(label)} style={{ background: "var(--gray-50)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--gray-500)", textTransform: "uppercase" }}>{label}</div>
                <div style={{ fontSize: "0.9rem", color: "var(--gray-800)", marginTop: 2, wordBreak: "break-word" }}>{value}</div>
              </div>
            ))}
          </div>

          <strong style={{ fontSize: "0.8rem", color: "var(--gray-600)" }}>Linked Commissions ({linkedCommissions.length})</strong>
          <div className="table-wrapper" style={{ marginTop: 8 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Billing Period</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {linkedCommissions.length === 0 ? (
                  <tr><td colSpan={4} style={{ color: "var(--gray-500)", textAlign: "center", padding: 16 }}>No linked commissions.</td></tr>
                ) : linkedCommissions.map((c) => (
                  <tr key={c.id}>
                    <td>{c.customer_name || "—"}</td>
                    <td>{c.billing_period || "—"}</td>
                    <td>{money(c.commission_amount)}</td>
                    <td><Badge status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
