import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { openHelp } from "./HelpWidget";

interface ChatRow {
  id: number;
  role: "user" | "assistant";
  message: string;
  status_cards: string | null;
  escalate: number;
  created_at: string;
}

interface AskResponse {
  session_id: string;
  message_id: number;
  answer: string;
  payment_status: "approved" | "review" | "hold" | null;
  vendor_name: string | null;
  escalate: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number; cost_estimate_usd: number };
}

const SESSION_KEY = "cleartopay_chat_session";

const SUGGESTED_PROMPTS = [
  "Can I pay Acme Plumbing?",
  "Which vendors are on hold?",
  "What documents are missing?",
  "Which COIs expire this month?",
  "Why is this vendor on hold?",
  "Which vendors did we reach out to this week?",
];

const STATUS_LABELS: Record<string, string> = {
  approved: "Approved for Payment",
  review: "Review Before Payment",
  hold: "Hold Payment",
};

function getSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function parseCards(row: ChatRow): { payment_status?: string; vendor_name?: string } | null {
  if (!row.status_cards) return null;
  try {
    return JSON.parse(row.status_cards);
  } catch {
    return null;
  }
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadHistory = () => {
    const sid = getSessionId();
    apiFetch(`/api/chat/messages?session_id=${encodeURIComponent(sid)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setRows)
      .catch(() => {});
  };

  useEffect(() => {
    if (open) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [rows, sending, open]);

  async function send(prompt?: string) {
    const message = (prompt ?? text).trim();
    if (!message || sending) return;
    const sid = getSessionId();
    setSending(true);
    setError(null);
    setText("");
    const optimistic: ChatRow = {
      id: Date.now(),
      role: "user",
      message,
      status_cards: null,
      escalate: 0,
      created_at: new Date().toISOString(),
    };
    setRows((prev) => [...prev, optimistic]);
    try {
      const r = await apiFetch("/api/chat/ask", {
        method: "POST",
        body: JSON.stringify({ message, session_id: sid }),
      });
      if (!r.ok) {
        let msg = "The assistant couldn't answer right now. Please try again in a moment.";
        try {
          const d = await r.json();
          if (d?.error === "rate_limited") {
            msg = "You've reached the chat limit for now. Please wait a bit and try again.";
          }
        } catch {
          // keep default message
        }
        setError(msg);
        return;
      }
      const data = (await r.json()) as AskResponse;
      const cards =
        data.payment_status || data.vendor_name
          ? JSON.stringify({ payment_status: data.payment_status, vendor_name: data.vendor_name })
          : null;
      const assistantRow: ChatRow = {
        id: data.message_id,
        role: "assistant",
        message: data.answer,
        status_cards: cards,
        escalate: data.escalate ? 1 : 0,
        created_at: new Date().toISOString(),
      };
      setRows((prev) => [...prev.filter((row) => row.id !== optimistic.id), assistantRow]);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSending(false);
    }
  }

  function askHuman(row: ChatRow) {
    const cards = parseCards(row);
    const question = cards?.vendor_name
      ? `Why is ${cards.vendor_name} not approved for payment?`
      : "I need help with a compliance question from the AI assistant.";
    setOpen(false);
    openHelp(question, "assistant escalation");
  }

  return (
    <>
      <button
        className="chat-fab"
        aria-label="Ask the AI assistant"
        onClick={() => setOpen((v) => !v)}
      >
        💬 Ask AI
      </button>

      {open && (
        <div className="chat-panel" role="dialog" aria-label="ClearToPay Assistant">
          <div className="chat-header">
            <div>
              <strong>ClearToPay Assistant</strong>
              <span className="chat-header-sub">Answers from your compliance data</span>
            </div>
            <button className="chat-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          <div className="chat-messages" ref={listRef}>
            {rows.length === 0 && !sending ? (
              <div className="chat-empty">
                <p>Ask about vendor payment status, missing documents, expirations, or outreach this week.</p>
                <div className="chat-prompts">
                  {SUGGESTED_PROMPTS.map((p) => (
                    <button key={p} className="chat-prompt-chip" onClick={() => send(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              rows.map((row) => {
                const cards = parseCards(row);
                if (row.role === "user") {
                  return (
                    <div className="chat-bubble chat-user" key={row.id}>
                      {row.message}
                    </div>
                  );
                }
                return (
                  <div className="chat-bubble chat-assistant" key={row.id}>
                    {cards?.payment_status && (
                      <span className={`chat-verdict badge-${cards.payment_status}`}>
                        {STATUS_LABELS[cards.payment_status] ?? cards.payment_status}
                      </span>
                    )}
                    {cards?.vendor_name && (
                      <span className="chat-vendor-name">Vendor: {cards.vendor_name}</span>
                    )}
                    <div className="chat-answer">{row.message}</div>
                    {row.escalate === 1 && (
                      <button className="chat-ask-human" onClick={() => askHuman(row)}>
                        Ask a human
                      </button>
                    )}
                  </div>
                );
              })
            )}
            {sending && (
              <div className="chat-bubble chat-assistant">
                <span className="chat-typing">…</span>
              </div>
            )}
            {error && <div className="chat-error">{error}</div>}
          </div>

          <div className="chat-input">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask about a vendor, document, or report…"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button onClick={() => send()} disabled={sending || !text.trim()}>
              {sending ? "…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
