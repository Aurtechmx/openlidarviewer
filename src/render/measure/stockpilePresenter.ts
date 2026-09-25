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
import { stockpileAreaGrid, type StockpileAreaGridResult } from './stockpileAreaGrid';
import type { Vec3 } from '../navMath';
import { streamingIsComplete, type StreamingCoverage } from './profileSectionSnapshot';
import { buildStockpileResult, stockpileResultHeadline } from './stockpileResult';
import type { StockpileBandInputs } from './stockpileBandInputs';
import type { VolumeRecord } from './types';

export interface StockpileViewRow {
  readonly label: string;
  readonly value: string;
}

export interface StockpileView {
  /**
   * "1,254 m³ ± 41 m³ (model band)" — the volume and its band, already in metres.
   * The band's confidence level is printed explicitly: a bare "± N" invites
   * reading it as a hard bound, when it is one standard deviation (~68%).
   */
  readonly headline: string;
  /** "±3.3%" — relative band. */
  readonly relative: string;
  /** The confidence tier. */
  readonly confidence: StockpileConfidence;
  /** What the sampling supports — see {@link CONFIDENCE_LABEL}. */
  readonly confidenceLabel: string;
  /** The auditable breakdown — every input behind the number and band. */
  readonly rows: ReadonlyArray<StockpileViewRow>;
  /** Honesty notes, verbatim from the result. */
  readonly caveats: ReadonlyArray<string>;
  /**
   * Whether the horizontal unit was verified. When false every m³/m²/m figure
   * here rests on an assumed-metres scale (an unknown-unit CRS yields the
   * placeholder factor 1); the `caveats` carry the full disclosure and
   * {@link stockpileToastLine} appends a short note, so a bare "X m³" is never
   * presented as a confirmed metric claim.
   */
  readonly unitVerified: boolean;
}

export interface StockpilePresentOptions {
  /** `linearUnitToMetres` for the source CRS. Defaults to 1 (already metres). */
  readonly lin?: number;
  /**
   * `verticalUnitToMetres` for the source CRS. Defaults to {@link lin}, so a
   * single-unit CRS is unchanged; it differs only for a compound CRS (metre
   * eastings over foot heights), where one factor cannot describe both axes.
   */
  readonly vert?: number;
}

/**
 * How well the SAMPLE supports the estimate — not how accurate the volume is.
 *
 * The words were High / Medium / Low beside a "± x m³ (1σ)" band, which reads
 * as a calibrated interval on the volume. The register approves "Exploratory
 * volume preview; spatial correlation and base uncertainty unquantified" and
 * prohibits "validated uncertainty interval": the band is a model sensitivity
 * scale whose sample term assumes independent thickness observations (LiDAR
 * returns are spatially correlated, so the effective N is smaller) and whose
 * base term is a heuristic spread, zero for an explicit base. Naming what the
 * grade is about keeps the word inside what the estimator supports.
 */
const CONFIDENCE_LABEL: Record<StockpileConfidence, string> = {
  high: 'Dense, even sampling',
  medium: 'Uneven sampling',
  low: 'Sparse or gappy sampling',
};

function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function presentStockpile(
  r: StockpileVolumeResult,
  options: StockpilePresentOptions = {},
): StockpileView {
  const lin = options.lin ?? 1;
  const vert = options.vert ?? lin;
  const lin2 = lin * lin;
  // A volume is an area times a height, so its factor is linear²·vertical —
  // the same `Vol` measurementExport uses. Plain lin³ applied the HORIZONTAL
  // unit to the vertical axis, overstating a metre/US-foot pile by 3.28×.
  const vol = lin2 * vert;
  const b = r.breakdown;

  // "model band", not "1σ": the ± is one standard deviation OF THE MODEL above,
  // not a measured coverage interval on the volume.
  const headline = `${int(r.volume * vol)} m³ ± ${int(r.sigma * vol)} m³ (model band)`;
  const relative = `±${(r.relativeError * 100).toFixed(1)}%`;

  const baseLabel =
    b.baseMode === 'explicit'
      ? `${(b.baseZ * vert).toFixed(2)} m (set)`
      : `${(b.baseZ * vert).toFixed(2)} m (lowest ground, ±${(b.baseUncertainty * vert).toFixed(2)} m)`;

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
    { label: 'Mean thickness', value: `${(b.meanThickness * vert).toFixed(2)} m` },
    { label: 'Sampling error', value: `± ${int(b.samplingError * vol)} m³` },
    { label: 'Base-plane error', value: `± ${int(b.basePlaneError * vol)} m³` },
  ];

  return {
    headline,
    relative,
    confidence: r.confidence,
    confidenceLabel: CONFIDENCE_LABEL[r.confidence],
    rows,
    caveats: r.caveats,
    unitVerified: r.densityUnitKnown,
  };
}

/** One-line summary for a toast: "Stockpile: 1,254 m³ ± 41 m³ (model band) (±3.3%) · Uneven sampling". */
export function stockpileToastLine(view: StockpileView): string {
  const line = `Stockpile: ${view.headline} (${view.relative}) · ${view.confidenceLabel}`;
  // The toast renders no caveats, so the unverified-unit disclosure has to live
  // in the line itself — otherwise an unknown-unit CRS shows a bare "X m³".
  return view.unitVerified ? line : `${line} · units unverified (assumes metres)`;
}

/** What the analysed sample was, relative to the whole source. */
export interface StockpileScope {
  /**
   * Whether the source the footprint was drawn on is PROVEN complete: a
   * committed static cloud, or a streaming source counted fully resident.
   *
   * A streaming source that holds part of its nodes, or whose node count is
   * unknown, is false. Renderer readiness is not this fact: a settled view is
   * settled for the current camera's wanted set, so a 5 %-resident source can
   * fill every cell the footprint covers and still be most of a scan short.
   */
  readonly sourceComplete: boolean;
  /**
   * True when the analysed points are a sample of the resident data: a cloud
   * voxel-reduced to the device budget, or a lasso walk that strode the points.
   */
  readonly sampled: boolean;
  /**
   * True when a streaming source contributed points, so an incomplete source
   * can be named as streaming residency rather than left unexplained.
   * Defaults to false.
   */
  readonly streaming?: boolean;
}

/** The result authority after footprint support AND scope are both applied. */
export type StockpileAuthority = 'measured' | 'preview' | 'withheld';

export interface StockpileAreaGridView {
  readonly method: StockpileAreaGridResult['method'];
  readonly authority: StockpileAuthority;
  /** Why a preview or a withheld result is not measured. */
  readonly reason: string;
  /** Fill volume above the base over supported cells, m³. */
  readonly volumeM3: number;
  /**
   * Fill/cut/net over supported cells in the SOURCE's native linear units
   * cubed — the grid's own output before the `lin`/`vert` conversion above,
   * so a caller storing a native-unit record (VolumeRecord's contract) does
   * not have to invert `volumeM3` back through the CRS factor.
   */
  readonly fillNative: number;
  readonly cutNative: number;
  readonly netNative: number;
  /** Supported footprint fraction, 0..1, and the coverage verdict it gave. */
  readonly supportFraction: number;
  readonly coverage: StockpileAreaGridResult['coverage'];
  /** Per-cell surface spread term, m³; the only term the incomplete model carries. */
  readonly surfaceTermM3: number;
  /** Base plane elevation (m) and its heuristic spread (m), not in the band. */
  readonly baseZM: number;
  readonly baseUncertaintyM: number;
  readonly unitVerified: boolean;
}

/**
 * Apply the scope to the coverage verdict. Footprint support is geometric; it
 * says nothing about whether the points that filled the cells are all the
 * points there will be. An incomplete or sampled source caps the authority at
 * preview; a refused coverage stays withheld whatever the scope.
 */
export function stockpileAuthority(
  coverage: StockpileAreaGridResult['coverage'],
  scope: StockpileScope,
): { authority: StockpileAuthority; reason: string } {
  if (coverage === 'refused') return { authority: 'withheld', reason: 'insufficient observations' };
  if (!scope.sourceComplete) {
    const reason = scope.streaming
      ? 'source is streaming and not fully resident'
      : 'source not proven complete';
    return { authority: 'preview', reason };
  }
  if (scope.sampled) return { authority: 'preview', reason: 'display sample' };
  if (coverage === 'preview') return { authority: 'preview', reason: 'footprint gaps' };
  return { authority: 'measured', reason: '' };
}

/**
 * Integrate the lasso sample with the area-weighted grid over a "lowest
 * ground" base plane and build its view. The grid runs in native units; the
 * m³ factor is linear²·vertical, applied here, so a compound CRS is handled
 * the way the point-sample presenter handles it.
 */
export function presentStockpileAreaGrid(
  polygon: ReadonlyArray<Vec3>,
  positions: Float32Array,
  base: { readonly z: number; readonly uncertainty: number },
  scope: StockpileScope,
  options: StockpilePresentOptions & { readonly unitVerified?: boolean } = {},
): StockpileAreaGridView {
  const lin = options.lin ?? 1;
  const vert = options.vert ?? lin;
  const vol = lin * lin * vert;
  const points: { x: number; y: number; z: number }[] = [];
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(z)) continue;
    points.push({ x: positions[i * 3], y: positions[i * 3 + 1], z });
  }
  const grid = stockpileAreaGrid({
    points,
    polygon: polygon.map((p) => ({ x: p[0], y: p[1] })),
    base: { kind: 'constant', zM: base.z },
  });
  const { authority, reason } = stockpileAuthority(grid.coverage, scope);
  return {
    method: grid.method,
    authority,
    reason,
    volumeM3: grid.fillM3 * vol,
    fillNative: grid.fillM3,
    cutNative: grid.cutM3,
    netNative: grid.netM3,
    supportFraction: grid.supportFraction,
    coverage: grid.coverage,
    surfaceTermM3: grid.surfaceTermM3 * vol,
    baseZM: base.z * vert,
    baseUncertaintyM: base.uncertainty * vert,
    unitVerified: options.unitVerified ?? true,
  };
}

/**
 * One line for the toast. A preview figure never appears without its PREVIEW
 * word and reason; a withheld result shows the support that fell short and no
 * number at all.
 */
export function stockpileAreaGridToastLine(v: StockpileAreaGridView): string {
  const support = `${Math.round(v.supportFraction * 100)}% footprint support`;
  let line: string;
  if (v.authority === 'withheld') {
    line = `Stockpile: volume withheld · ${support} · ${v.reason}`;
  } else {
    const state = v.authority === 'measured' ? 'MEASURED' : `PREVIEW (${v.reason})`;
    line =
      `Stockpile: ${int(v.volumeM3)} m³ · ${state} · ${support} · area-weighted grid` +
      ` · surface term ± ${int(v.surfaceTermM3)} m³ (incomplete model)` +
      ` · base ${v.baseZM.toFixed(2)} m (lowest ground, ±${v.baseUncertaintyM.toFixed(2)} m, not in the term)`;
  }
  return v.unitVerified ? line : `${line} · units unverified (assumes metres)`;
}

/** What the caller knows about the sample and the source behind it. */
export interface StockpileToastOptions {
  /** True when a contributing cloud was voxel-reduced to the device budget. */
  readonly sourceReduced?: boolean;
  /** False for an unknown-unit CRS, which bars a pts/m² claim. */
  readonly densityUnitKnown?: boolean;
  /** `verticalUnitToMetres`; defaults to `lin` for a single-unit CRS. */
  readonly vert?: number;
  /** True when a streaming source contributed selected points. */
  readonly streamingContributed?: boolean;
  /**
   * The streaming source's node counts, or null when nothing streams. What
   * is resident can fill every cell the footprint covers; that is support,
   * not completeness, so anything short of full residency stays a preview.
   */
  readonly streamingCoverage?: StreamingCoverage | null;
  /** True when the lasso walk strode the points. */
  readonly walkSampled?: boolean;
}

/** What the lasso-save path needs from the grid alongside the toast text. */
export interface StockpileGridForLasso {
  /** ` · Stockpile: …` suffix, identical to what {@link stockpileToastSuffix} returns. */
  readonly suffix: string;
  /**
   * The grid's verdict, or `null` under the same gate that empties the
   * suffix (a degenerate footprint, too few points, or a base the
   * point-sample estimator could not fit) — there is then nothing to switch
   * a record's canonical figure to.
   */
  readonly view: StockpileAreaGridView | null;
}

/**
 * Fit the "lowest ground" base plane with the point-sample estimator (kept as
 * the base and validity reference), integrate the volume with the
 * area-weighted grid, and build the toast text alongside the structured
 * verdict. Shared by {@link stockpileToastSuffix} (the toast has never needed
 * more than the string) and {@link stockpileGridForLasso} (the Save path,
 * which also needs the verdict to enrich the stored record).
 */
function computeStockpileGridForLasso(
  polygon: ReadonlyArray<Vec3>,
  positions: Float32Array,
  lin?: number,
  options: StockpileToastOptions = {},
): StockpileGridForLasso {
  const { sourceReduced, densityUnitKnown, vert, streamingContributed, walkSampled } = options;
  // A streaming source authorises a measured figure only when its resident
  // node count reaches its known node count. An unknown count (null) is not
  // evidence of coverage, so it reads as incomplete.
  const sourceComplete =
    !streamingContributed ||
    (options.streamingCoverage != null && streamingIsComplete(options.streamingCoverage) === true);
  const empty: StockpileGridForLasso = { suffix: '', view: null };
  if (polygon.length < 3 || positions.length < 9) return empty;
  const stock = stockpileVolume({
    polygon,
    positions,
    base: { mode: 'lowest-percentile', percentile: 0.05 },
    sourceReduced,
    linearUnitToMetres: lin,
    densityUnitKnown,
  });
  if (stock.validity !== 'ok') return empty;
  const view = presentStockpileAreaGrid(
    polygon,
    positions,
    { z: stock.breakdown.baseZ, uncertainty: stock.breakdown.baseUncertainty },
    {
      sourceComplete,
      sampled: Boolean(sourceReduced) || Boolean(walkSampled),
      streaming: Boolean(streamingContributed),
    },
    { lin, vert, unitVerified: densityUnitKnown ?? true },
  );
  if (view.authority !== 'withheld' && view.volumeM3 <= 0) return empty;
  return { suffix: ` · ${stockpileAreaGridToastLine(view)}`, view };
}

/**
 * End-to-end helper for the lasso toast: the ` · Stockpile: …` suffix, or
 * `''` when the footprint is unusable. Keeps the whole compute + format path
 * inside the lazy chunk, so `main.ts` carries only the call.
 */
export function stockpileToastSuffix(
  polygon: ReadonlyArray<Vec3>,
  positions: Float32Array,
  lin?: number,
  options: StockpileToastOptions = {},
): string {
  return computeStockpileGridForLasso(polygon, positions, lin, options).suffix;
}

/**
 * {@link stockpileToastSuffix}, also returning the structured grid verdict so
 * the Save path can enrich the stored `VolumeRecord` with the SAME
 * figure the toast just printed, rather than recomputing it a second time
 * with a chance to disagree.
 */
export function stockpileGridForLasso(
  polygon: ReadonlyArray<Vec3>,
  positions: Float32Array,
  lin?: number,
  options: StockpileToastOptions = {},
): StockpileGridForLasso {
  return computeStockpileGridForLasso(polygon, positions, lin, options);
}

/** What the lasso commit path takes from the stockpile chunk. */
export interface LassoStockpileOutcome {
  /** The canonical result (`stockpileResult.ts`): what Save stores. */
  readonly record: VolumeRecord;
  /** The toast's volume clause, formatted from {@link record}. */
  readonly headline: string;
  /** The ` · Stockpile: …` band for the same grid evaluation. */
  readonly suffix: string;
}

/**
 * Evaluate the grid once for a lasso, build the canonical result from it and
 * the point-sample record, and format the toast from that result. `vol` is
 * the native→m³ factor (linear² · vertical).
 */
export function lassoStockpileResult(
  pointSample: VolumeRecord,
  inputs: StockpileBandInputs,
  vol: number,
): LassoStockpileOutcome {
  const { polygon, positions: sample, lin, options, withheld } = inputs;
  const { suffix, view } = computeStockpileGridForLasso(polygon, sample, lin, options);
  const record = buildStockpileResult(pointSample, view, withheld);
  return { record, headline: stockpileResultHeadline(record, vol), suffix };
}
