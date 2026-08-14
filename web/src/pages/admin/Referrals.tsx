import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { money, fmtDate, Badge, useToast, Modal, LoadingBlock, ErrorBlock } from "./common";

interface Referral {
  id: number;
  partner_id: number;
  partner_name?: string | null;
  partner_code: string;
  referred_company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone?: string | null;
  referral_date: string | null;
  signup_date: string | null;
  subscription_start_date?: string | null;
  subscription_plan: string | null;
  subscription_amount: number | null;
  customer_status: string;
  tenant_id?: number | null;
  notes?: string | null;
  created_at?: string | null;
}

interface Partner {
  id: number;
  first_name: string;
  last_name: string;
  company_name: string | null;
}

const STATUS_OPTIONS = ["lead", "trial", "active", "past_due", "cancelled", "refunded"];

export default function AdminReferrals() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fPartner, setFPartner] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fStart, setFStart] = useState("");
  const [fEnd, setFEnd] = useState("");
  const [editing, setEditing] = useState<Referral | null>(null);
  const [editStatus, setEditStatus] = useState("");
  const [editPartner, setEditPartner] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editReason, setEditReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { toastEl, show } = useToast();

  useEffect(() => {
    apiFetch("/api/partners")
      .then((res) => (res.ok ? res.json() : { partners: [] }))
      .then((data) => setPartners((data.partners ?? []) as Partner[]))
      .catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (fPartner) params.set("partner_id", fPartner);
    if (fStatus) params.set("customer_status", fStatus);
    if (fStart) params.set("start", `${fStart} 00:00:00`);
    if (fEnd) params.set("end", `${fEnd} 23:59:59`);
    const qs = params.toString();
    apiFetch(`/api/referrals${qs ? `?${qs}` : ""}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch referrals");
        return res.json();
      })
      .then((data) => {
        setReferrals((data.referrals ?? []) as Referral[]);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(load, [fPartner, fStatus, fStart, fEnd]);

  const partnerName = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of partners) map.set(p.id, `${p.first_name} ${p.last_name}`.trim());
    return map;
  }, [partners]);

  const displayPartner = (r: Referral) => r.partner_name || partnerName.get(r.partner_id) || `Partner #${r.partner_id}`;

  const openEdit = (r: Referral) => {
    setEditing(r);
    setEditStatus(r.customer_status);
    setEditPartner(String(r.partner_id));
    setEditNotes(r.notes ?? "");
    setEditReason("");
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editReason.trim()) {
      show("error", "A reason is required for referral corrections");
      return;
    }
    const body: Record<string, unknown> = { reason: editReason.trim() };
    if (editStatus !== editing.customer_status) body.customer_status = editStatus;
    if (Number(editPartner) !== editing.partner_id) body.partner_id = Number(editPartner);
    if (editNotes !== (editing.notes ?? "")) body.notes = editNotes.trim() || null;
    if (Object.keys(body).length === 1) {
      show("error", "No changes made — adjust status, partner, or notes");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/referrals/${editing.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");
      show("success", "Referral updated");
      setEditing(null);
      load();
    } catch (err) {
      show("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dashboard">
      {toastEl}
      <h2 className="page-title">Referrals</h2>
      <p className="page-subtitle">All referred customers, with attribution correction.</p>

      <div className="filter-bar" style={{ flexWrap: "wrap" }}>
        <select className="form-select" value={fPartner} onChange={(e) => setFPartner(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">All partners</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>{`${p.first_name} ${p.last_name}`.trim()}{p.company_name ? ` — ${p.company_name}` : ""}</option>
          ))}
        </select>
        <select className="form-select" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <label>From <input className="form-input" type="date" value={fStart} onChange={(e) => setFStart(e.target.value)} /></label>
        <label>To <input className="form-input" type="date" value={fEnd} onChange={(e) => setFEnd(e.target.value)} /></label>
        {(fPartner || fStatus || fStart || fEnd) && (
          <button className="btn btn-outline btn-sm" onClick={() => { setFPartner(""); setFStatus(""); setFStart(""); setFEnd(""); }}>Clear</button>
        )}
      </div>

      {loading && <LoadingBlock label="Loading referrals…" />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Partner</th>
                <th>Referred Company</th>
                <th>Contact</th>
                <th>Email</th>
                <th>Referral Date</th>
                <th>Signup Date</th>
                <th>Plan</th>
                <th>Amount</th>
                <th>Customer Status</th>
              </tr>
            </thead>
            <tbody>
              {referrals.length === 0 ? (
                <tr className="table-empty"><td colSpan={9}>No referrals found.</td></tr>
              ) : referrals.map((r) => (
                <tr key={r.id} onClick={() => openEdit(r)} style={{ cursor: "pointer" }}>
                  <td className="td-name">{displayPartner(r)}</td>
                  <td>{r.referred_company || "—"}</td>
                  <td>{r.contact_name || "—"}</td>
                  <td>{r.contact_email || "—"}</td>
                  <td>{fmtDate(r.referral_date)}</td>
                  <td>{fmtDate(r.signup_date)}</td>
                  <td>{r.subscription_plan || "—"}</td>
                  <td>{r.subscription_amount != null ? money(r.subscription_amount) : "—"}</td>
                  <td><Badge status={r.customer_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal
          title={`Referral — ${editing.referred_company || editing.contact_name || `#${editing.id}`}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn btn-outline" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={saveEdit}>Save Changes</button>
            </>
          }
        >
          <div className="form-group">
            <label>Customer Status</label>
            <select className="form-select" value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Reassign to Partner</label>
            <select className="form-select" value={editPartner} onChange={(e) => setEditPartner(e.target.value)}>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>{`${p.first_name} ${p.last_name}`.trim()}{p.company_name ? ` — ${p.company_name}` : ""}</option>
              ))}
            </select>
            <p className="text-sm" style={{ color: "var(--gray-500)", marginTop: 4 }}>For attribution corrections — commissions already earned are not retroactively re-assigned.</p>
          </div>
          <div className="form-group">
            <label>Notes</label>
            <textarea className="form-input" rows={3} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="Internal notes about this referral…" />
          </div>
          <div className="form-group">
            <label>Reason (required)</label>
            <textarea className="form-input" rows={2} value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="Why is this referral being corrected?" />
          </div>
        </Modal>
      )}
    </div>
  );
}
