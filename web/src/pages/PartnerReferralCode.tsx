import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import CopyButton from "../components/CopyButton";

interface PartnerMe {
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  referral_code?: string | null;
  referral_link?: string | null;
  w9_uploaded?: boolean;
}

// Canonical share-link format for partner referrals: the public signup page
// plus the partner's code in the ?ref= parameter. That parameter is what the
// signup form pre-fills/quotes back to the client ("You're being referred
// by …"), and the code can also be typed into the form by hand — so the link
// and the bare code are interchangeable.
//
// If the API ever returns an explicit referral_link for this partner we use
// that instead (single source of truth for the public host).
const SIGNUP_LINK_BASE = "https://cleartopay.ctonew.app/get-started";

// The referral code is stored uppercase (generated from the partner's last
// name); render it the same way so a partner reading it aloud gets it right.
function normalizeCode(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim();
  return code.length > 0 ? code.toUpperCase() : null;
}

export default function PartnerReferralCode() {
  const [profile, setProfile] = useState<PartnerMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch("/api/partner/me")
      .then(async (res) => {
        if (!res.ok) {
          // Read the API's message when there is one, but never surface a
          // raw status code / body to the partner.
          throw new Error(
            res.status === 403
              ? "This account isn't a partner account."
              : "We couldn't load your referral code.",
          );
        }
        return res.json();
      })
      .then((data: { partner?: PartnerMe }) => {
        setProfile(data?.partner ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "We couldn't load your referral code.");
        setLoading(false);
      });
  }, []);

  useEffect(load, [load]);

  const code = normalizeCode(profile?.referral_code);
  const shareLink = code
    ? profile?.referral_link || `${SIGNUP_LINK_BASE}?ref=${encodeURIComponent(code)}`
    : null;

  return (
    <div className="dashboard">
      <h2 className="page-title">Referral Code</h2>
      <p className="page-subtitle">
        Give this code — or your share link — to a construction company you refer.
        Anyone who signs up with it is credited to you.
      </p>

      {loading && <div className="loading">Loading your referral code…</div>}

      {!loading && error && (
        <div className="error-message">
          {error}{" "}
          <button type="button" className="btn btn-outline btn-sm" onClick={load} style={{ marginLeft: 10 }}>
            Try again
          </button>
        </div>
      )}

      {!loading && !error && code && (
        <>
          <section className="referral-hero">
            <span className="referral-code-label">Your referral code</span>
            <code className="referral-code-xl" aria-label="Your referral code">{code}</code>
            <p className="referral-hero-hint">
              Add this code at signup, or share your link below.
            </p>
            <div className="referral-hero-actions">
              <CopyButton text={code} label="Copy Code" className="btn btn-primary copy-btn" />
            </div>
          </section>

          {shareLink && (
            <section className="referral-link-card">
              <span className="referral-code-label referral-link-label">Your share link</span>
              <code className="referral-code-link-text">{shareLink}</code>
              <CopyButton text={shareLink} label="Copy Link" className="btn btn-outline btn-sm copy-btn" />
            </section>
          )}

          <section className="referral-tips">
            <h3 className="section-title">How referrals work</h3>
            <ol className="referral-tips-list">
              <li>Send the company your code or share link.</li>
              <li>They enter the code on the signup page (your link fills it in for them).</li>
              <li>Once their account is active, their company appears in your referral list.</li>
            </ol>
            <p className="referral-tips-links">
              <Link to="/app/partner/referrals" className="btn btn-outline btn-sm">View my referrals</Link>
              <Link to="/app/partner/commissions" className="btn btn-outline btn-sm">View commissions</Link>
            </p>
          </section>
        </>
      )}

      {!loading && !error && !code && (
        <section className="referral-empty">
          <span className="referral-empty-icon" aria-hidden="true">🔗</span>
          <h3 className="referral-empty-title">No referral code yet</h3>
          <p className="referral-empty-text">
            Your referral code is generated as soon as your W-9 is on file — it's how
            referrals get credited to you.
          </p>
          <p className="referral-empty-text">
            Upload your W-9 from your partner dashboard and your code will appear here
            right away.
          </p>
          <Link to="/app/partner/dashboard" className="btn btn-primary">Go to my dashboard</Link>
        </section>
      )}
    </div>
  );
}
