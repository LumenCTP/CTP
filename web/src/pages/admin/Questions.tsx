import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { Badge, fmtDateTime, LoadingBlock, ErrorBlock, useToast } from "./common";

// ── Admin "Accounts & Questions" review ──────────────────────────────
// Lists every client account (tenant + owner user, plan, subscription
// status, unanswered-questions count), lets the owner drill into an
// account's full support-question history (unanswered first), and reply
// inline — the reply lands back in the client's own support thread.

interface Account {
  id: number;
  name: string;
  subscription_status: string | null;
  subscription_plan: string | null;
  subscription_period_start: string | null;
  payment_week_start_day: string | null;
  wizard_status: string | null;
  created_at: string;
  user_count: number;
  vendor_count: number;
  owner_name: string | null;
  owner_email: string | null;
  unanswered_count: number;
}
interface SupportMessage {
  id: number;
  tenant_id: number;
  tenant_name: string;
  user_id: number | null;
  sender_name: string | null;
  sender_email: string | null;
  message: string;
  context: string | null;
  status: string;
  created_at: string;
  reply_text: string | null;
  replied_at: string | null;
  replied_by: string | null;
}
type StatusFilter = "unanswered" | "all";

const PLAN_LABELS: Record<string, string> = {
  monthly: "Monthly",
  annual: "Annual",
};

export default function AdminQuestions() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("unanswered");
  const [selectedTenant, setSelectedTenant] = useState<number | "all">("all");
  const [replying, setReplying] = useState<number | null>(null);
  const { toastEl, show } = useToast();

  const loadAccounts = useCallback(() => {
    apiFetch("/api/admin/accounts")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load accounts");
        return res.json();
      })
      .then((data) => {
        setAccounts((data.accounts ?? []) as Account[]);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const loadMessages = useCallback((status: StatusFilter, tenantId: number | "all") => {
    setMessagesLoading(true);
    setMessagesError(null);
    const params = new URLSearchParams();
    params.set("status", status);
    if (tenantId !== "all") params.set("tenant_id", String(tenantId));
    apiFetch(`/api/admin/support/messages?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load questions");
        return res.json();
      })
      .then((data) => {
        setMessages((data.messages ?? []) as SupportMessage[]);
        setMessagesLoading(false);
      })
      .catch((err) => {
        setMessagesError(err.message);
        setMessagesLoading(false);
      });
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);
  useEffect(() => {
    loadMessages(filter, selectedTenant);
  }, [filter, selectedTenant, loadMessages]);

  // When an account is selected, show its full history (unanswered first).
  const selectAccount = (id: number) => {
    setSelectedTenant((prev) => (prev === id ? "all" : id));
    setFilter("all");
  };

  const totalUnanswered = useMemo(
    () => accounts.reduce((sum, a) => sum + (a.unanswered_count || 0), 0),
    [accounts],
  );
  const activeCount = useMemo(
    () => accounts.filter((a) => a.subscription_status === "ACTIVE" || a.subscription_status === "TRIAL").length,
    [accounts],
  );
  const selectedAccount = selectedTenant === "all" ? null : accounts.find((a) => a.id === selectedTenant) ?? null;

  const submitReply = async (msg: SupportMessage, replyText: string) => {
    if (!replyText.trim()) return;
    setReplying(msg.id);
    try {
      const res = await apiFetch("/api/admin/support/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: msg.id, reply_text: replyText.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Reply failed");
      }
      show("success", `Reply sent to ${msg.tenant_name}`);
      // Refresh both the thread and the account unanswered counts.
      loadMessages(filter, selectedTenant);
      loadAccounts();
    } catch (err) {
      show("error", err instanceof Error ? err.message : "Reply failed");
    } finally {
      setReplying(null);
    }
  };

  return (
    <div className="dashboard">
      {toastEl}
      <h2 className="page-title">Accounts &amp; Questions</h2>
      <p className="page-subtitle">Every client account and their support questions — answer questions right here; replies land in the client&apos;s thread.</p>

      {/* Summary bar */}
      {!loading && !error && (
        <div className="metrics-grid" style={{ marginTop: 16, marginBottom: 8 }}>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#1a56db" }}>👥</div>
            <div className="metric-body">
              <span className="metric-label">Total Accounts</span>
              <span className="metric-value" style={{ color: "#1a56db" }}>{accounts.length}</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#059669" }}>✓</div>
            <div className="metric-body">
              <span className="metric-label">Active / Trial</span>
              <span className="metric-value" style={{ color: "#059669" }}>{activeCount}</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: "#d97706" }}>❓</div>
            <div className="metric-body">
              <span className="metric-label">Unanswered Questions</span>
              <span className="metric-value" style={{ color: "#d97706" }}>{totalUnanswered}</span>
            </div>
          </div>
        </div>
      )}

      {/* Accounts table */}
      <h3 className="section-heading" style={{ marginTop: 20 }}>Accounts</h3>
      {loading && <LoadingBlock label="Loading accounts…" />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Owner</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Unanswered</th>
                <th>Vendors</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr><td colSpan={7} style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>No accounts yet.</td></tr>
              ) : accounts.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => selectAccount(a.id)}
                  style={{ cursor: "pointer", background: selectedTenant === a.id ? "var(--primary-50, #eff6ff)" : undefined }}
                >
                  <td className="td-name">{a.name}</td>
                  <td>
                    <div>{a.owner_name ?? "—"}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{a.owner_email ?? ""}</div>
                  </td>
                  <td>
                    {a.subscription_plan ? (
                      <span className={`badge ${a.subscription_plan.toLowerCase() === "annual" ? "badge-active" : "badge-trial"}`}>
                        {PLAN_LABELS[a.subscription_plan.toLowerCase()] ?? a.subscription_plan}
                      </span>
                    ) : (
                      <span style={{ color: "var(--gray-500)" }}>—</span>
                    )}
                  </td>
                  <td>
                    <Badge status={a.subscription_status} />
                  </td>
                  <td>
                    {a.unanswered_count > 0 ? (
                      <span className="badge badge-pending">{a.unanswered_count}</span>
                    ) : (
                      <span style={{ color: "var(--gray-500)" }}>0</span>
                    )}
                  </td>
                  <td>{a.vendor_count}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      className="btn btn-outline btn-sm"
                      style={{ padding: "4px 12px", fontSize: 13, borderRadius: 8 }}
                      onClick={(e) => { e.stopPropagation(); selectAccount(a.id); }}
                    >
                      {selectedTenant === a.id ? "Show all" : "Questions"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Questions panel */}
      <div className="dashboard-heading" style={{ marginTop: 28 }}>
        <h3 className="page-title" style={{ marginBottom: 0 }}>
          {selectedAccount ? `Questions — ${selectedAccount.name}` : "Questions — All Accounts"}
        </h3>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["unanswered", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={filter === f ? "btn btn-primary btn-sm" : "btn btn-outline btn-sm"}
            style={{ padding: "4px 14px", fontSize: 13, borderRadius: 8 }}
          >
            {f === "unanswered" ? "Unanswered" : "All"}
            {f === "unanswered" && totalUnanswered > 0 && ` (${totalUnanswered})`}
          </button>
        ))}
        {selectedAccount && (
          <button
            className="btn btn-outline btn-sm"
            style={{ padding: "4px 14px", fontSize: 13, borderRadius: 8, marginLeft: "auto" }}
            onClick={() => { setSelectedTenant("all"); setFilter("unanswered"); }}
          >
            ✕ Clear account filter
          </button>
        )}
      </div>

      {messagesLoading && <LoadingBlock label="Loading questions…" />}
      {messagesError && <ErrorBlock message={messagesError} />}
      {!messagesLoading && !messagesError && messages.length === 0 && (
        <div style={{ color: "var(--gray-500)", padding: "20px 0", fontSize: 14 }}>
          {filter === "unanswered" ? "No unanswered questions. 🎉" : "No questions yet for this view."}
        </div>
      )}
      {!messagesLoading && !messagesError && messages.map((m) => (
        <MessageCard key={m.id} msg={m} showTenant={selectedTenant === "all"} replying={replying === m.id} onReply={submitReply} />
      ))}
    </div>
  );
}

function MessageCard({
  msg, showTenant, replying, onReply,
}: {
  msg: SupportMessage;
  showTenant: boolean;
  replying: boolean;
  onReply: (msg: SupportMessage, replyText: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const isOpen = msg.status === "open";
  return (
    <div className="card" style={{ marginBottom: 12, padding: "14px 16px", borderLeft: isOpen ? "3px solid #d97706" : "3px solid #059669" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {showTenant && msg.tenant_name ? <span style={{ color: "var(--primary, #1a56db)" }}>{msg.tenant_name} — </span> : null}
          <span>{msg.sender_name ?? "Client"}</span>
          {msg.sender_email && <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 6 }}>{msg.sender_email}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Badge status={isOpen ? "open" : "answered"} />
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{fmtDateTime(msg.created_at)}</span>
        </div>
      </div>
      <div style={{ marginTop: 8, whiteSpace: "pre-wrap", fontSize: 14, color: "var(--text, #111827)" }}>{msg.message}</div>
      {msg.context && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
          <span className="badge badge-pending" style={{ fontSize: 11 }}>{msg.context}</span>
        </div>
      )}
      {!isOpen && msg.reply_text && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--gray-50, #f9fafb)", borderRadius: 8, fontSize: 13.5 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>💬 Reply — {msg.replied_by ?? "Support"}{msg.replied_at ? ` · ${fmtDateTime(msg.replied_at)}` : ""}</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{msg.reply_text}</div>
        </div>
      )}
      {isOpen && (
        <div style={{ marginTop: 10 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a reply — it will appear in the client's support thread…"
            rows={2}
            style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border, #d1d5db)", padding: "8px 10px", fontSize: 13.5, resize: "vertical" }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button
              className="btn btn-primary btn-sm"
              style={{ padding: "5px 16px", fontSize: 13, borderRadius: 8 }}
              disabled={replying || !draft.trim()}
              onClick={() => { onReply(msg, draft); setDraft(""); }}
            >
              {replying ? "Sending…" : "Send Reply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
