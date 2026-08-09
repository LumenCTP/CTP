import { useCallback, useState, type ReactNode } from "react";

// ── Formatting helpers shared by all admin pages ─────────

export function money(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

// ── Status badges ─────────────────────────────────────────
// Color scheme: green = active/approved/paid, yellow = pending/lead,
// red = rejected/cancelled/reversed, orange = past_due/suspended, blue = trial.

const STATUS_CLASSES: Record<string, string> = {
  // partner statuses
  pending: "badge-pending",
  approved: "badge-approved",
  suspended: "badge-suspended",
  rejected: "badge-rejected",
  terminated: "badge-terminated",
  // referral customer statuses
  lead: "badge-lead",
  trial: "badge-trial",
  active: "badge-active",
  past_due: "badge-past_due",
  cancelled: "badge-cancelled",
  refunded: "badge-refunded",
  // commission statuses
  scheduled: "badge-scheduled",
  paid: "badge-paid",
  reversed: "badge-reversed",
  disputed: "badge-disputed",
};

export function Badge({ status }: { status: string | null | undefined }) {
  const s = (status ?? "").toLowerCase();
  return (
    <span className={`badge ${STATUS_CLASSES[s] ?? "badge-pending"}`}>
      {s.replace(/_/g, " ") || "—"}
    </span>
  );
}

// ── Toast feedback ────────────────────────────────────────
// Minimal auto-dismissing success/error toast for admin actions.

export function useToast() {
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const show = useCallback((type: "success" | "error", msg: string) => {
    setToast({ type, msg });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const toastEl = toast ? (
    <div className={`toast toast-${toast.type}`} role="status">
      {toast.type === "success" ? "✓ " : "✕ "}{toast.msg}
    </div>
  ) : null;

  return { toastEl, show };
}

// ── Modal wrapper (matches .modal CSS) ────────────────────

export function Modal({
  title, onClose, children, footer, wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal ${wide ? "modal-lg" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// ── Inline loading / error blocks ─────────────────────────

export function LoadingBlock({ label }: { label: string }) {
  return <div className="loading">{label}</div>;
}

export function ErrorBlock({ message }: { message: string }) {
  return <div className="error-message">{message}</div>;
}
