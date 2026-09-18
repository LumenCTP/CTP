import type { ScoreLabel } from "@clear-to-pay/shared";

/**
 * Per-vendor compliance score badge (0-100 + color band), rendered from the
 * `compliance_score` / `score_label` the API already computed — the UI never
 * recalculates the score itself.
 *
 * Bands: >= 80 "Good" (green), 40-79 "Fair" (amber), < 40 "Poor" (red).
 * A null score means the vendor has not been scored yet (the API backfills it
 * on the next vendor-list / dashboard read).
 */
export function scoreTone(label: ScoreLabel | null | undefined): "good" | "fair" | "poor" | "none" {
  if (label === "Good") return "good";
  if (label === "Fair") return "fair";
  if (label === "Poor") return "poor";
  return "none";
}

export default function ComplianceScore({
  score,
  label,
  size = "sm",
  showNumber = true,
}: {
  score: number | null | undefined;
  label: ScoreLabel | string | null | undefined;
  size?: "sm" | "lg";
  showNumber?: boolean;
}) {
  const tone = scoreTone(label as ScoreLabel | null | undefined);
  const title =
    tone === "none"
      ? "Compliance score not calculated yet"
      : `Compliance score ${score}/100 — ${label}`;
  const text = tone === "none" ? "—" : showNumber ? `${score} · ${label}` : String(label);

  return (
    <span
      className={`score-badge score-badge-${tone}${size === "lg" ? " score-badge-lg" : ""}`}
      title={title}
      aria-label={tone === "none" ? "Compliance score not calculated yet" : `Compliance score ${score} out of 100, ${label}`}
    >
      {text}
    </span>
  );
}
