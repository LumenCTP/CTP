import { useState } from "react";
import Logo from "../components/Logo";
import { useAuth } from "../components/AuthContext";

// Same key the marketing /checkout page + App.tsx use to stash the Stripe
// session id before redirecting (survives an intermediate redirect that strips
// ?session_id=).
const CHECKOUT_SESSION_KEY = "cleartopay_checkout_session";

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
 * ACTIVE or TRIAL (PENDING after signup, PAST_DUE after a failed renewal, or
 * CANCELLED). Every plan button goes to the marketing /checkout page on the
 * same origin — checkout starts a 30-day free trial (card on file, no charge
 * until the trial ends) or collects payment immediately for a paid plan.
 *
 * Also offers a "check status" recovery path: a customer who already completed
 * checkout (but whose Stripe webhook lagged, or who landed back here via a
 * redirect) can re-run /api/checkout/confirm instead of being forced to
 * re-checkout.
 */
export default function Paywall() {
  const { logout, token, refreshUser } = useAuth();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");

  async function checkStatus() {
    setChecking(true);
    setCheckError("");
    try {
      const qs = new URLSearchParams(window.location.search);
      let sessionId = qs.get("session_id");
      if (!sessionId) {
        try {
          sessionId = localStorage.getItem(CHECKOUT_SESSION_KEY);
        } catch {
          sessionId = null;
        }
      }
      if (sessionId && token) {
        await fetch("/api/checkout/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session_id: sessionId }),
        });
        try {
          localStorage.removeItem(CHECKOUT_SESSION_KEY);
        } catch {
          // ignore
        }
      }
      // Re-fetch /me — if the subscription is ACTIVE/TRIAL now, the shell
      // re-renders and this paywall disappears.
      const ok = await refreshUser();
      if (token && !ok) {
        setCheckError("We could not reach the server. Please try again in a moment.");
      }
      // If refreshUser returned true but the tenant is still PENDING, the
      // Webhook hasn't landed yet — leave the paywall visible with no error
      // (the user can retry or pick a plan).
    } catch {
      setCheckError("We could not confirm your checkout yet. Please try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 640 }}>
        <div className="auth-header">
          <div className="auth-logo-slot"><Logo size={48} /></div>
          <h2>Complete checkout to activate your account</h2>
          <p className="auth-subtitle">
            Your ClearToPay account is created — pick a plan and enter your card
            at checkout to unlock your compliance dashboard. Your card won't be
            charged until your 30-day free trial ends.
          </p>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <a href="/checkout?plan=monthly" style={PLAN_STYLES} className="plan-card-link">
            <span style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>Monthly</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: "var(--text)" }}>$149<span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)" }}>/mo</span></span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Billed after your free trial. Cancel anytime.</span>
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
              Start free trial — $149/mo
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
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Billed once a year after trial. Save $588 vs. monthly.</span>
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
              Start free trial — $1,200/yr
            </span>
          </a>
        </div>

        <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginTop: 18 }}>
          Your card is entered at checkout but you won't be charged until your 30-day
          free trial ends. Cancel anytime.
        </p>

        {/* Checkout recovery: the webhook may have lagged behind a completed
            checkout, or the user may have landed back here after a redirect.
            Re-run confirm instead of forcing a re-checkout. */}
        <div style={{ textAlign: "center", marginTop: 10 }}>
          <button
            type="button"
            className="auth-link-btn"
            onClick={checkStatus}
            disabled={checking}
          >
            {checking ? "Checking…" : "I already completed checkout — check status"}
          </button>
          {checkError && (
            <p style={{ fontSize: 12.5, color: "#b91c1c", margin: "8px 12px 0" }}>{checkError}</p>
          )}
        </div>

        <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginTop: 6 }}>
          Need help? Email <a href="mailto:documents@cleartopayconstruction.com" style={{ color: "var(--blue)" }}>documents@cleartopayconstruction.com</a>
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