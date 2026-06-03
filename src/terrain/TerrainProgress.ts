/**
 * TerrainProgress.ts
 *
 * Pure helpers for terrain job progress reporting. The worker emits
 * `TerrainProgress` payloads as it walks chunks; the host renders
 * them via the engine subscription.
 */

/** A progress payload. */
export interface TerrainProgress {
  /** Completed work units (e.g. tiles processed). */
  readonly completed: number;
  /** Total work units. Zero when unknown. */
  readonly total: number;
  /** Free-text stage label — "partitioning", "metrics", "scoring". */
  readonly stage: string;
}

/** Fraction in `[0, 1]` — 0 when `total` is unknown. */
export function progressFraction(p: TerrainProgress): number {
  if (p.total <= 0) return 0;
  return Math.max(0, Math.min(1, p.completed / p.total));
}
