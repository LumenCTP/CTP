import { useEffect, useRef, useState } from "react";
import Logo from "./Logo";
import { useAuth } from "./AuthContext";
import { apiFetch } from "../lib/api";

interface TopBarProps {
  onMenuToggle: () => void;
  badge?: string;
}

// Small camera/upload glyph used by the company-logo upload control.
function UploadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

export default function TopBar({ onMenuToggle, badge }: TopBarProps) {
  const { user, logout, refreshUser } = useAuth();
  const initial = user?.full_name?.charAt(0)?.toUpperCase() || "?";
  const displayName = user?.full_name || "User";
  // The logo endpoint is auth-gated (Bearer token), so the SPA fetches the
  // bytes itself and renders them as a blob URL. Falls back to the default
  // shield mark when the tenant has no logo or the fetch fails.
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user?.logo_url) {
      setLogoUrl(null);
      return;
    }
    (async () => {
      try {
        const res = await apiFetch(user.logo_url as string);
        if (!res.ok) throw new Error("logo fetch failed");
        const blob = await res.blob();
        if (!cancelled) setLogoUrl(URL.createObjectURL(blob));
      } catch {
        // Tenant has a logo_key but bytes are missing/unreachable — show the
        // default shield mark rather than a broken image.
        if (!cancelled) setLogoUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.logo_url]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/api/tenant/logo", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data?.error || "Logo upload failed");
      // /api/auth/me now reports logo_url — re-fetching triggers the effect
      // above to load and render the new logo.
      await refreshUser();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Logo upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <header className="topbar">
      <button className="menu-toggle" onClick={onMenuToggle} aria-label="Toggle menu">
        ☰
      </button>
      <div className="topbar-brand">
        {logoUrl ? (
          <img src={logoUrl} className="topbar-logo-img" alt="Company logo" />
        ) : (
          <Logo size={30} showText={false} />
        )}
        <span className="topbar-welcome">Welcome, {displayName}</span>
        <label
          className={`logo-upload-btn${uploading ? " uploading" : ""}`}
          title="Upload company logo (PNG, JPG, or SVG — 1MB max)"
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            hidden
            onChange={handleFileChange}
            disabled={uploading}
          />
          <UploadIcon />
        </label>
      </div>
      {uploadError && <span className="logo-upload-error">{uploadError}</span>}
      {badge && <span className="topbar-badge">{badge}</span>}
      <div className="topbar-spacer" />
      <div className="topbar-user" title={displayName}>
        <span className="user-avatar">{initial}</span>
        <span className="user-name">{displayName}</span>
        <button className="logout-btn" onClick={logout} title="Sign out">
          ↵
        </button>
      </div>
    </header>
  );
}
