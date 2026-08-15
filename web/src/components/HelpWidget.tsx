import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type Message = { id:number; message:string; context?:string; status:string; created_at:string; reply_text?:string|null; replied_at?:string|null; replied_by?:string|null };
export const openHelp = (message?: string, context?: string) => window.dispatchEvent(new CustomEvent("cleartopay:help", { detail: { message, context } }));

export default function HelpWidget() {
  const [open, setOpen] = useState(false); const [messages, setMessages] = useState<Message[]>([]); const [text, setText] = useState(""); const [context, setContext] = useState(""); const [sending, setSending] = useState(false); const [sendError, setSendError] = useState<string | null>(null);
  const load = () => apiFetch("/api/support/messages").then(r => r.ok ? r.json() : []).then(setMessages).catch(() => {});
  useEffect(() => { const fn = (e: Event) => { const d = (e as CustomEvent).detail || {}; setOpen(true); if (d.message) setText(d.message); if (d.context) setContext(d.context); }; window.addEventListener("cleartopay:help", fn); return () => window.removeEventListener("cleartopay:help", fn); }, []);
  useEffect(() => { if (open) load(); }, [open]);
  async function send() {
    if (!text.trim() || sending) return;
    setSending(true); setSendError(null);
    try {
      const r = await apiFetch("/api/support/ask", { method:"POST", body: JSON.stringify({ message:text.trim(), context: context || undefined }) });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setSendError(data.error || "Your message couldn't be sent. Please try again.");
        return;
      }
      setText(""); await load();
    } catch {
      setSendError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }
  return <>
    <button className="help-fab" aria-label="Open help" onClick={() => setOpen(true)}>💬 Help</button>
    {open && <div className="help-panel"><div className="help-header"><strong>ClearToPay Help</strong><button onClick={() => setOpen(false)} aria-label="Close">×</button></div><div className="help-messages">{messages.length === 0 ? <p className="help-empty">Ask us anything about compliance, vendors, reports, or your account.</p> : messages.slice().reverse().map(m => <div key={m.id}><div className="help-bubble client">{m.message}</div>{m.reply_text && <div className="help-bubble agent"><div>{m.reply_text}</div><small>{m.replied_by} · {m.replied_at ? new Date(m.replied_at).toLocaleString() : ""}</small></div>}</div>)}</div>{sendError && <div className="help-error" style={{ padding: "8px 12px", fontSize: 12, color: "var(--red, #dc2626)" }}>{sendError}</div>}<div className="help-input"><textarea value={text} onChange={e=>setText(e.target.value)} placeholder="How can we help?" rows={2} onKeyDown={e=>{if(e.key === "Enter" && !e.shiftKey){e.preventDefault();send();}}}/><button onClick={send} disabled={sending || !text.trim()}>{sending ? "Sending…" : "Send"}</button></div></div>}
  </>;
}
