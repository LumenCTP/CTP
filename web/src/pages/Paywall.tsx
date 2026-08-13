import Logo from "../components/Logo";
import { useAuth } from "../components/AuthContext";

const PLAN_STYLES: React.CSSProperties = {
  flex: 1,
  padding: "18px 16px",
  borderRadius: 12,
  border: "1.5px solid var(--border, #d1d5db)",
  background: "#fff",
  textAlign: "left",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

/**
 * Full-screen paywall shown to authenticated tenants whose subscription is not
 * ACTIVE (PENDING after signup, PAST_DUE after a failed renewal, or legacy
 * TRIAL). Every plan button goes to the marketing /checkout page on the same
 * origin — payment is collected immediately (no free trial).
 */
export default function Paywall() {
  const { logout } = useAuth();

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 640 }}>
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
          <h2>Complete your purchase to activate your account</h2>
          <p className="auth-subtitle">
            Your ClearToPay account is created — pick a plan and pay securely
            with Stripe to unlock your compliance dashboard.
          </p>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <a href="/checkout?plan=monthly" style={PLAN_STYLES} className="plan-card-link">
            <span style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>Monthly</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: "var(--text)" }}>$149<span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)" }}>/mo</span></span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Billed monthly. Cancel anytime.</span>
            <span
              style={{
                marginTop: 8,
                textAlign: "center",
                background: "var(--accent, #2563eb)",
                color: "#fff",
                padding: "10px 12px",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              Pay $149 now
            </span>
          </a>
          <a href="/checkout?plan=annual" style={{ ...PLAN_STYLES, borderColor: "var(--accent, #2563eb)", position: "relative" }} className="plan-card-link">
            <span
              style={{
                position: "absolute",
                top: -10,
                right: 12,
                background: "var(--accent, #2563eb)",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                padding: "3px 10px",
                borderRadius: 999,
              }}
            >
              Best Value
            </span>
            <span style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>Annual</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: "var(--text)" }}>$1,200<span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)" }}>/yr</span></span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Billed once a year. Save $588 vs. monthly.</span>
            <span
              style={{
                marginTop: 8,
                textAlign: "center",
                background: "var(--accent, #2563eb)",
                color: "#fff",
                padding: "10px 12px",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              Pay $1,200 now
            </span>
          </a>
        </div>

        <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginTop: 18 }}>
          You'll be charged now — no free trial. Cancel anytime.
        </p>
        <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginTop: 6 }}>
          Need help? Email <a href="mailto:support@cleartopay.com" style={{ color: "var(--blue)" }}>support@cleartopay.com</a>
        </p>

        <p className="auth-footer" style={{ marginTop: 18 }}>
          <button type="button" className="auth-link-btn" onClick={logout}>
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
