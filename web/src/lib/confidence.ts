/**
 * AI extraction confidence normalization.
 *
 * Real AI extractions store ai_confidence_score as a 0.0–1.0 fraction
 * (extract.ts), while older/seed rows carry a legacy 0–100 integer. Every
 * display surface (badges, thresholds, "AI confidence: X%") works on a
 * 0–100 percentage, so normalize before rendering or comparing.
 */
export function confidencePercent(score: number | null | undefined): number | null {
  if (score == null || Number.isNaN(score)) return null;
  return score > 1 ? Math.round(score) : Math.round(score * 100);
}
