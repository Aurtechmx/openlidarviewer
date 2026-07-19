/**
 * stockpilePresenter.ts
 *
 * Turns a `StockpileVolumeResult` (in the cloud's native CRS linear units)
 * into a metric, human-readable view model: the headline volume with its ±
 * band, the relative error, a confidence label, the "show the math" breakdown
 * rows, and the caveats. Pure — no DOM — so the panel, the toast, and the
 * report all render from one tested source of truth, and the honesty (the band
 * + the math) can never drift between surfaces.
 *
 * Unit handling: the result arrives in native linear units (feet for a
 * state-plane-feet cloud). `lin` is `linearUnitToMetres`; lengths scale by
 * `lin`, areas by `lin²`, volumes by `lin³`, so every figure prints in true
 * metres / m² / m³.
 */

import { stockpileVolume, type StockpileVolumeResult, type StockpileConfidence } from './stockpileVolume';
import type { Vec3 } from '../navMath';

export interface StockpileViewRow {
  readonly label: string;
  readonly value: string;
}

export interface StockpileView {
  /**
   * "1,254 m³ ± 41 m³ (1σ)" — the volume and its band, already in metres.
   * The band's confidence level is printed explicitly: a bare "± N" invites
   * reading it as a hard bound, when it is one standard deviation (~68%).
   */
  readonly headline: string;
  /** "±3.3%" — relative band. */
  readonly relative: string;
  /** The confidence tier. */
  readonly confidence: StockpileConfidence;
  /** "High" / "Medium" / "Low". */
  readonly confidenceLabel: string;
  /** The auditable breakdown — every input behind the number and band. */
  readonly rows: ReadonlyArray<StockpileViewRow>;
  /** Honesty notes, verbatim from the result. */
  readonly caveats: ReadonlyArray<string>;
}

export interface StockpilePresentOptions {
  /** `linearUnitToMetres` for the source CRS. Defaults to 1 (already metres). */
  readonly lin?: number;
}

const CONFIDENCE_LABEL: Record<StockpileConfidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function presentStockpile(
  r: StockpileVolumeResult,
  options: StockpilePresentOptions = {},
): StockpileView {
  const lin = options.lin ?? 1;
  const lin2 = lin * lin;
  const lin3 = lin2 * lin;
  const b = r.breakdown;

  const headline = `${int(r.volume * lin3)} m³ ± ${int(r.sigma * lin3)} m³ (1σ)`;
  const relative = `±${(r.relativeError * 100).toFixed(1)}%`;

  const baseLabel =
    b.baseMode === 'explicit'
      ? `${(b.baseZ * lin).toFixed(2)} m (set)`
      : `${(b.baseZ * lin).toFixed(2)} m (lowest ground, ±${(b.baseUncertainty * lin).toFixed(2)} m)`;

  // A points/m² density is only meaningful when the horizontal unit is known.
  // With an unknown unit the figure is native points/unit² read as m² — label
  // it honestly instead of printing a confident "pts/m²".
  const densityRow: StockpileViewRow = r.densityUnitKnown
    ? { label: 'Density', value: `${(b.densityNative / lin2).toFixed(1)} pts/m²` }
    : { label: 'Density', value: `${b.densityNative.toFixed(1)} pts/unit² (unit unknown)` };

  const rows: StockpileViewRow[] = [
    { label: 'Footprint', value: `${(b.footprintArea * lin2).toFixed(1)} m²` },
    { label: 'Points in footprint', value: int(b.pointsInPolygon) },
    densityRow,
    { label: 'Base plane', value: baseLabel },
    { label: 'Mean thickness', value: `${(b.meanThickness * lin).toFixed(2)} m` },
    { label: 'Sampling error', value: `± ${int(b.samplingError * lin3)} m³` },
    { label: 'Base-plane error', value: `± ${int(b.basePlaneError * lin3)} m³` },
  ];

  return {
    headline,
    relative,
    confidence: r.confidence,
    confidenceLabel: CONFIDENCE_LABEL[r.confidence],
    rows,
    caveats: r.caveats,
  };
}

/** One-line summary for a toast: "Stockpile: 1,254 m³ ± 41 m³ (1σ) (±3.3%) · Medium confidence". */
export function stockpileToastLine(view: StockpileView): string {
  return `Stockpile: ${view.headline} (${view.relative}) · ${view.confidenceLabel} confidence`;
}

/**
 * End-to-end helper for the lasso toast: run the estimator over the selected
 * sample with a "lowest ground" base plane and return the ` · Stockpile: …`
 * suffix — or `''` when there's nothing trustworthy to claim (too few points,
 * degenerate footprint, or zero volume). Keeps the whole compute + format path
 * inside the lazy chunk, so `main.ts` carries only the call. Positional args
 * keep the eager call site byte-cheap.
 */
export function stockpileToastSuffix(
  polygon: ReadonlyArray<Vec3>,
  positions: Float32Array,
  lin?: number,
  sourceReduced?: boolean,
  densityUnitKnown?: boolean,
): string {
  if (polygon.length < 3 || positions.length < 9) return '';
  const stock = stockpileVolume({
    polygon,
    positions,
    base: { mode: 'lowest-percentile', percentile: 0.05 },
    sourceReduced,
    // Grade the density bar in points/m² for foot-unit projects, not native ft².
    linearUnitToMetres: lin,
    // …but only claim a points/m² density when the unit is actually known; an
    // unknown CRS still passes lin (defaulting to 1) for display, so the grade
    // must be told separately not to trust it.
    densityUnitKnown,
  });
  if (stock.validity !== 'ok' || stock.volume <= 0) return '';
  return ` · ${stockpileToastLine(presentStockpile(stock, { lin }))}`;
}
