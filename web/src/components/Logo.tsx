/**
 * Brand logo — blue rounded tile with the shield+hardhat mark and the
 * "CTP Construction" wordmark (owner-approved brand).
 *
 * Mirrors the marketing site Logo (PageShell.tsx): same SVG (viewBox 0 0 24 24,
 * stroke currentColor, strokeWidth 2.5, round caps/joins), same flex layout
 * (items-center, ~10px gap). Sizing is driven by the `size` prop (the tile's
 * px dimension; the glyph inside scales to ~2/3 of it).
 */
interface LogoProps {
  /** Tile size in px (default 36 — app chrome). Auth pages use 48 like the marketing site h-12. */
  size?: number;
  /** Show the "CTP Construction" wordmark next to the icon (default true). */
  showText?: boolean;
  /** Extra classes for the wordmark span (e.g. color overrides for dark surfaces). */
  textClassName?: string;
  /** Extra classes for the outer flex wrapper. */
  className?: string;
}

export default function Logo({
  size = 36,
  showText = true,
  textClassName = "",
  className = "",
}: LogoProps) {
  const icon = Math.max(14, Math.round(size * 0.67));
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 10 }}
    >
      <span
        style={{
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.25),
          background: "var(--blue)",
          boxShadow: "0 1px 2px rgba(26, 86, 219, 0.25)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <svg
          width={icon}
          height={icon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: "#fff" }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <g transform="translate(12,11) scale(0.45) translate(-12,-11)">
            <path d="M3.5 16a.8.8 0 0 0 .8.8h15.4a.8.8 0 0 0 .8-.8v-1a.8.8 0 0 0-.8-.8H4.3a.8.8 0 0 0-.8.8z" />
            <path d="M10.5 9.5V5.5a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8v4" />
            <path d="M5.5 13.5v-2.5a5 5 0 0 1 5-5" />
            <path d="M13.5 6a5 5 0 0 1 5 5v2.5" />
          </g>
        </svg>
      </span>
      {showText && (
        <span
          className={`logo-wordmark ${textClassName}`.trim()}
          style={{ fontWeight: 700, whiteSpace: "nowrap", lineHeight: 1.1 }}
        >
          CTP Construction
        </span>
      )}
    </span>
  );
}
