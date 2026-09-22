/**
 * stockpileDualAnswer.test.ts: one lasso, both stockpile estimators, one input.
 *
 * A lasso answers twice. The toast's "Volume · fill" line, and the record a
 * Save writes to the session, report and CSV, come from the point-sample
 * integration (`volumeCutFill`, reached through `computeLassoVolume`). The
 * " · Stockpile:" band beside it comes from the area-weighted grid
 * (`stockpileAreaGrid`, reached through `stockpileToastSuffix`). This file
 * drives both from the same selection the way the application does and
 * measures how far apart they land, and, where the scene has a known volume,
 * how far each lands from it.
 *
 * It measures and pins; it does not choose. The pinned figures document the
 * gap as it stands, so a change to either estimator that moves an answer shows
 * up here as a changed measurement rather than passing unnoticed.
 *
 * HOW THE APP IS REPRODUCED. The walk is `computeLassoVolume` with a top-down
 * orthographic projector, the reference percentile the lasso tool passes
 * (0.05) and the default through-surfaces basis. The record is
 * `deriveVolumeRecord` over that result. The band is built from the inputs the
 * Viewer hands back (the hull lifted to the reference plane and the selected
 * points) and computed by the same calls `stockpileToastSuffix` makes, and the
 * suffix itself is run on one case per configuration to confirm the figure
 * here is the figure the toast prints.
 *
 * UNITS. Both estimators run on native coordinates. The record holds native
 * volumes, which the toast and the CSV scale by linear² × vertical; the band's
 * grid is called with no unit factor, so its `fillM3` is also native, and the
 * presenter scales it by the same linear² × vertical. Every m³ below is
 * therefore native × lin² × vert for both estimators. The grid's own
 * `linearUnitToMetres` option cubes one factor and is not on this path; the
 * unit cases show what it would give for a compound CRS.
 *
 * TRUTH. The analytic piles sit on a flat apron at z = 0 that the lasso
 * covers, so the 5th-percentile reference lands on the apron and the true
 * volume is the closed form. That holds only while the hull contains the whole
 * pile, which is checked per run; a run whose hull cuts into the pile is read
 * against the surface integrated over that hull instead. For the rasterisation
 * fixtures the surface is closed form but the reference is not zero, so truth
 * is the surface above each estimator's own reference, integrated over the
 * hull the app measured. The closed forms are themselves checked by
 * quadrature.
 *
 * SAMPLING. Uniform is independent uniform positions. Clustered is a Thomas
 * process, the spatial clumping of overlapping strips and scan lines. Gradient
 * is the 1/d² fall-off of a terrestrial scanner beside the pile. Clustering
 * and a gradient are where a per-point mean and a per-area integral should
 * part company, which is why both are here.
 *
 * Set STOCKPILE_DUAL_REPORT=1 to print every measured row.
 *
 * Pure Node: no DOM, no three.js, no network.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PointCloud } from '../src/model/PointCloud';
import { computeLassoVolume } from '../src/render/measure/lassoVolumeCompute';
import type { LassoVolumeHost } from '../src/render/measure/lassoVolumeCompute';
import { deriveVolumeRecord } from '../src/render/measure/measureDerivations';
import { POINT_SAMPLE_VOLUME_METHOD, pointInPolygon2D } from '../src/render/measure/volume';
import { stockpileVolume } from '../src/render/measure/stockpileVolume';
import { stockpileAreaGrid } from '../src/render/measure/stockpileAreaGrid';
import type { StockpileAreaGridResult } from '../src/render/measure/stockpileAreaGrid';
import {
  presentStockpileAreaGrid,
  stockpileToastSuffix,
  type StockpileAuthority,
} from '../src/render/measure/stockpilePresenter';

const REPORT = process.env.STOCKPILE_DUAL_REPORT === '1';
const ROOT = resolve(__dirname, '..');

// ── deterministic sampling ────────────────────────────────────────────────

/** Numerical Recipes LCG, top bits taken; the generator the fixtures use. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One standard normal draw by Box-Muller. */
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Half the apron side, m. The apron is [-A, A]², the lasso sits 1 m outside it. */
const A = 9;
const APRON_AREA = (2 * A) * (2 * A);
const LASSO = [
  { x: -A - 1, y: -A - 1 },
  { x: A + 1, y: -A - 1 },
  { x: A + 1, y: A + 1 },
  { x: -A - 1, y: A + 1 },
];

type Surface = (x: number, y: number) => number;
type Sampler = (n: number, r: () => number) => Array<[number, number]>;

/** Independent uniform positions over the apron. */
const uniform: Sampler = (n, r) => {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) out.push([(r() * 2 - 1) * A, (r() * 2 - 1) * A]);
  return out;
};

/**
 * A Thomas cluster process: parents uniform over the apron, ten children each,
 * offset by a 0.5 m Gaussian and wrapped back onto the apron so the process
 * stays stationary. Returns clump at a fixed physical size, so the pattern is
 * patchy at low density and close to uniform at high density.
 */
const clustered: Sampler = (n, r) => {
  const CHILDREN = 10;
  const SIGMA = 0.5;
  const wrap = (v: number): number => {
    const s = 2 * A;
    return ((((v + A) % s) + s) % s) - A;
  };
  const out: Array<[number, number]> = [];
  while (out.length < n) {
    const px = (r() * 2 - 1) * A;
    const py = (r() * 2 - 1) * A;
    for (let k = 0; k < CHILDREN && out.length < n; k++) {
      out.push([wrap(px + SIGMA * gauss(r)), wrap(py + SIGMA * gauss(r))]);
    }
  }
  return out;
};

/**
 * A terrestrial scanner 5 m off the west edge: density falls as 1/d², so the
 * near side of the apron is sampled about twenty times as densely as the far
 * side. The density gradient the area-weighted grid is built to be invariant
 * to.
 */
const gradient: Sampler = (n, r) => {
  const SX = -A - 5;
  const D0 = 5;
  const out: Array<[number, number]> = [];
  while (out.length < n) {
    const x = (r() * 2 - 1) * A;
    const y = (r() * 2 - 1) * A;
    const d2 = (x - SX) * (x - SX) + y * y;
    if (r() <= (D0 * D0) / d2) out.push([x, y]);
  }
  return out;
};

const SAMPLERS = { uniform, clustered, gradient } as const;
type SamplingName = keyof typeof SAMPLERS;

// ── analytic piles on a flat apron at z = 0 ───────────────────────────────

interface Pile {
  readonly name: string;
  readonly surface: Surface;
  /** Closed-form volume above z = 0, m³. */
  readonly volume: number;
  /** Points on the edge of the pile's support, which must lie inside the hull. */
  readonly rim: ReadonlyArray<[number, number]>;
}

function circleRim(radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < 64; k++) {
    const t = (2 * Math.PI * k) / 64;
    out.push([radius * Math.cos(t), radius * Math.sin(t)]);
  }
  return out;
}

/** Cone, radius 6 m, height 3 m: V = πR²H/3. */
const CONE: Pile = (() => {
  const R = 6, H = 3;
  return {
    name: 'cone',
    surface: (x, y) => Math.max(0, H * (1 - Math.hypot(x, y) / R)),
    volume: (Math.PI * R * R * H) / 3,
    rim: circleRim(R),
  };
})();

/** Truncated square pyramid, base 10 m, top 4 m, height 2.5 m: V = h(a² + ab + b²)/3. */
const FRUSTUM: Pile = (() => {
  const a = 10, b = 4, h = 2.5;
  const rim: Array<[number, number]> = [];
  for (let k = 0; k <= 16; k++) {
    const t = -a / 2 + (a * k) / 16;
    rim.push([t, -a / 2], [t, a / 2], [-a / 2, t], [a / 2, t]);
  }
  return {
    name: 'frustum',
    surface: (x, y) => {
      const m = Math.max(Math.abs(x), Math.abs(y));
      return h * Math.min(1, Math.max(0, (a / 2 - m) / ((a - b) / 2)));
    },
    volume: (h * (a * a + a * b + b * b)) / 3,
    rim,
  };
})();

/**
 * Flat-topped mound: a 3 m plateau at 2 m, falling to the apron by a half
 * cosine over the next 4 m. V = πH(r1² + r1·w + w²/2 − 2w²/π²), w = r2 − r1.
 */
const MOUND: Pile = (() => {
  const r1 = 3, r2 = 7, H = 2, w = r2 - r1;
  return {
    name: 'mound',
    surface: (x, y) => {
      const r = Math.hypot(x, y);
      if (r <= r1) return H;
      if (r >= r2) return 0;
      return (H * (1 + Math.cos((Math.PI * (r - r1)) / w))) / 2;
    },
    volume: Math.PI * H * (r1 * r1 + r1 * w + (w * w) / 2 - (2 * w * w) / (Math.PI * Math.PI)),
    rim: circleRim(r2),
  };
})();

const PILES = [CONE, FRUSTUM, MOUND] as const;

function cloudOf(xy: ReadonlyArray<[number, number]>, surface: Surface): Float32Array {
  const p = new Float32Array(xy.length * 3);
  for (let i = 0; i < xy.length; i++) {
    p[i * 3] = xy[i][0];
    p[i * 3 + 1] = xy[i][1];
    p[i * 3 + 2] = surface(xy[i][0], xy[i][1]);
  }
  return p;
}

// ── the harness: both answers for one selection ───────────────────────────

interface Units {
  /** Metres per native horizontal unit. */
  readonly lin: number;
  /** Metres per native vertical unit. */
  readonly vert: number;
}

const METRES: Units = { lin: 1, vert: 1 };

interface DualAnswer {
  readonly selected: number;
  /** The confidence tier the saved record carries, from its point count alone. */
  readonly recordConfidence: 'high' | 'medium' | 'low';
  /** Hull of the selected points in the horizontal plane, native units. */
  readonly hull: ReadonlyArray<{ x: number; y: number }>;
  readonly footprintM2: number;
  /** The record's reference and the band's base, native units. */
  readonly recordBase: number;
  readonly gridBase: number;
  /** Point-sample record, m³ (native × lin² × vert, as the toast and CSV show it). */
  readonly ps: { readonly fill: number; readonly cut: number; readonly net: number };
  /** Area-weighted grid on the same selection, m³ by the same factor. */
  readonly grid: {
    readonly fill: number;
    readonly cut: number;
    readonly net: number;
    readonly cellSize: number;
    readonly supportFraction: number;
    readonly coverage: StockpileAreaGridResult['coverage'];
    readonly authority: StockpileAuthority;
    readonly reason: string;
  };
  /** What the toast's band printed, when the suffix was run. */
  readonly toastSuffix?: string;
  /** The band's figure as the presenter computed it, m³. */
  readonly presenterM3: number;
}

function dualAnswer(positions: Float32Array, lasso: ReadonlyArray<{ x: number; y: number }>, units: Units = METRES, withToast = false): DualAnswer {
  const cloud = new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 'pile.las' });
  const host: LassoVolumeHost = {
    project: (x, y) => ({ x, y }),
    integrable: [['pile', { cloud }]],
    streamingParts: [],
    wasReduced: () => false,
    visibilityFor: () => null,
    worldUp: [0, 0, 1],
  };
  const out = computeLassoVolume({ host, lasso, referencePercentile: 0.05 });
  if (!out) throw new Error('lasso selected nothing');
  const { lin, vert } = units;
  const vol = lin * lin * vert;
  const record = deriveVolumeRecord(out.result, out.referenceZ, POINT_SAMPLE_VOLUME_METHOD);

  // The band, exactly as `stockpileToastSuffix` builds it from what the Viewer hands back.
  const sampled = out.anySourceReduced || out.budget.downsample;
  const stock = stockpileVolume({
    polygon: out.polygon3D,
    positions: out.selectedPositions,
    base: { mode: 'lowest-percentile', percentile: 0.05 },
    sourceReduced: out.anySourceReduced,
    linearUnitToMetres: lin,
    densityUnitKnown: true,
  });
  const baseZ = stock.breakdown.baseZ;
  const view = presentStockpileAreaGrid(
    out.polygon3D,
    out.selectedPositions,
    { z: baseZ, uncertainty: stock.breakdown.baseUncertainty },
    { sourceComplete: true, sampled, streaming: out.streamingContributed },
    { lin, vert, unitVerified: true },
  );
  // The presenter keeps only the fill; the grid is called again, with the
  // presenter's own arguments, for its cut, net and cell size.
  const pts: { x: number; y: number; z: number }[] = [];
  const sp = out.selectedPositions;
  for (let i = 0; i < sp.length / 3; i++) {
    const z = sp[i * 3 + 2];
    if (Number.isFinite(z)) pts.push({ x: sp[i * 3], y: sp[i * 3 + 1], z });
  }
  const hull = out.polygon3D.map((p) => ({ x: p[0], y: p[1] }));
  const g = stockpileAreaGrid({ points: pts, polygon: hull, base: { kind: 'constant', zM: baseZ } });
  const toastSuffix = withToast
    ? stockpileToastSuffix(out.polygon3D, out.selectedPositions, lin, {
      sourceReduced: out.anySourceReduced,
      densityUnitKnown: true,
      vert,
      streamingContributed: out.streamingContributed,
      streamingCoverage: null,
      walkSampled: out.budget.downsample,
    })
    : undefined;
  return {
    selected: out.selectedCount,
    recordConfidence: record.confidence,
    hull,
    footprintM2: out.result.footprintArea * lin * lin,
    recordBase: record.referenceZ,
    gridBase: baseZ,
    // `deriveVolumeRecord` always sets fill/cut/net; only a withheld grid
    // record (D2, never built in this harness) leaves them absent.
    ps: { fill: record.fill! * vol, cut: record.cut! * vol, net: record.net! * vol },
    grid: {
      fill: g.fillM3 * vol,
      cut: g.cutM3 * vol,
      net: g.netM3 * vol,
      cellSize: g.cellSizeM * lin,
      supportFraction: g.supportFraction,
      coverage: g.coverage,
      authority: view.authority,
      reason: view.reason,
    },
    toastSuffix,
    presenterM3: view.volumeM3,
  };
}

/** The integer the toast prints for a volume, e.g. "1,254". */
const toastInt = (v: number): string => Math.round(v).toLocaleString('en-US');

// ── truth by quadrature over a convex hull ────────────────────────────────

/**
 * ∫∫ max(0, f − base) over a convex polygon, by the midpoint rule on rows of
 * height ≤ step, each row cut to the polygon's span at its centre line.
 */
function volumeOverHull(
  hull: ReadonlyArray<{ x: number; y: number }>,
  f: Surface,
  base: number,
  step: number,
): number {
  let y0 = Infinity, y1 = -Infinity;
  for (const v of hull) { y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
  const rows = Math.max(1, Math.ceil((y1 - y0) / step));
  const dy = (y1 - y0) / rows;
  let total = 0;
  for (let j = 0; j < rows; j++) {
    const y = y0 + (j + 0.5) * dy;
    let x0 = Infinity, x1 = -Infinity;
    for (let i = 0, k = hull.length - 1; i < hull.length; k = i++) {
      const a = hull[k], b = hull[i];
      if ((a.y <= y && b.y >= y) || (b.y <= y && a.y >= y)) {
        if (a.y === b.y) { x0 = Math.min(x0, a.x, b.x); x1 = Math.max(x1, a.x, b.x); continue; }
        const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      }
    }
    if (!(x1 > x0)) continue;
    const cols = Math.max(1, Math.ceil((x1 - x0) / step));
    const dx = (x1 - x0) / cols;
    let row = 0;
    for (let i = 0; i < cols; i++) row += Math.max(0, f(x0 + (i + 0.5) * dx, y) - base);
    total += row * dx * dy;
  }
  return total;
}

/** The whole apron as a polygon, for checking the closed forms. */
const APRON_POLY = [
  { x: -A, y: -A }, { x: A, y: -A }, { x: A, y: A }, { x: -A, y: A },
];

// ── measuring the analytic ladder ─────────────────────────────────────────

const DENSITIES = [1, 10, 100] as const;
type Density = (typeof DENSITIES)[number];
/** Seeds per density: fewer where one run's scatter is already small. */
const SEEDS: Record<Density, number> = { 1: 32, 10: 12, 100: 4 };

interface Row {
  readonly key: string;
  readonly runs: number;
  readonly truth: number;
  readonly points: number;
  /** Hull area over apron area, mean across runs. */
  readonly footprint: number;
  /** Mean, min and max relative error against the truth inside the footprint. */
  readonly psErr: readonly [number, number, number];
  readonly gridErr: readonly [number, number, number];
  /** Root-mean-square relative error across runs. */
  readonly psRms: number;
  readonly gridRms: number;
  /** Runs in which the grid landed nearer the truth than the point sample. */
  readonly gridCloser: number;
  /** Mean relative gap (grid − point-sample) / point-sample, and mean |gap| in m³. */
  readonly gap: number;
  readonly gapAbsM3: number;
  readonly support: number;
  readonly cellSize: number;
  /** Count of runs per authority. */
  readonly authority: Readonly<Record<StockpileAuthority, number>>;
  /** Largest cut either estimator reported, m³; zero on a flat apron. */
  readonly maxCut: number;
  /** Runs whose hull cut into the pile, read against the hull integral rather than the closed form. */
  readonly cutRuns: number;
  /** The first run's toast suffix and presenter figure. */
  readonly toastSuffix: string;
  readonly toastM3: number;
}

const mean = (xs: ReadonlyArray<number>): number => xs.reduce((s, v) => s + v, 0) / xs.length;
const rms = (xs: ReadonlyArray<number>): number => Math.sqrt(mean(xs.map((v) => v * v)));

function measure(pile: Pile, sampling: SamplingName, density: Density): Row {
  const runs = SEEDS[density];
  const n = Math.round(density * APRON_AREA);
  const psErr: number[] = [], gridErr: number[] = [], gaps: number[] = [], gapAbs: number[] = [];
  const support: number[] = [], cell: number[] = [], footprint: number[] = [], points: number[] = [];
  let maxCut = 0, cutRuns = 0, gridCloser = 0;
  const authority: Record<StockpileAuthority, number> = { measured: 0, preview: 0, withheld: 0 };
  let toastSuffix = '', toastM3 = 0;
  for (let s = 0; s < runs; s++) {
    const seed = 0x51ed0000 + density * 1000 + s * 7 + pile.name.length * 131 + sampling.length * 17;
    const positions = cloudOf(SAMPLERS[sampling](n, lcg(seed)), pile.surface);
    const d = dualAnswer(positions, LASSO, METRES, s === 0);
    // The closed form is the truth only while the whole pile lies inside the
    // hull and both references sit on the apron. A sparse, clumped sample can
    // pull the hull in across the pile's edge; that run is read against the
    // surface integrated over the hull the app measured instead.
    let inside = d.recordBase === 0 && d.gridBase === 0;
    for (const [x, y] of pile.rim) if (!pointInPolygon2D(x, y, d.hull)) inside = false;
    const truthPs = inside ? pile.volume : volumeOverHull(d.hull, pile.surface, d.recordBase, 0.01);
    const truthGrid = inside ? pile.volume : volumeOverHull(d.hull, pile.surface, d.gridBase, 0.01);
    if (!inside) cutRuns++;
    const ep = d.ps.fill / truthPs - 1;
    const eg = d.grid.fill / truthGrid - 1;
    psErr.push(ep);
    gridErr.push(eg);
    if (Math.abs(eg) < Math.abs(ep)) gridCloser++;
    gaps.push(d.grid.fill / d.ps.fill - 1);
    gapAbs.push(Math.abs(d.grid.fill - d.ps.fill));
    support.push(d.grid.supportFraction);
    cell.push(d.grid.cellSize);
    footprint.push(d.footprintM2 / APRON_AREA);
    points.push(d.selected);
    authority[d.grid.authority]++;
    maxCut = Math.max(maxCut, d.ps.cut, d.grid.cut);
    if (s === 0) { toastSuffix = d.toastSuffix ?? ''; toastM3 = d.presenterM3; }
  }
  return {
    key: `${pile.name}/${sampling}/${density}`,
    runs,
    truth: pile.volume,
    points: Math.round(mean(points)),
    footprint: mean(footprint),
    psErr: [mean(psErr), Math.min(...psErr), Math.max(...psErr)],
    gridErr: [mean(gridErr), Math.min(...gridErr), Math.max(...gridErr)],
    psRms: rms(psErr),
    gridRms: rms(gridErr),
    gridCloser,
    gap: mean(gaps),
    gapAbsM3: mean(gapAbs),
    support: mean(support),
    cellSize: mean(cell),
    authority,
    maxCut,
    cutRuns,
    toastSuffix,
    toastM3,
  };
}

const pct = (v: number, d = 1): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;

function report(title: string, lines: ReadonlyArray<string>): void {
  // eslint-disable-next-line no-console
  if (REPORT) console.log([`\n${title}`, ...lines].join('\n'));
}

let ladder: Map<string, Row> | null = null;
function analyticLadder(): Map<string, Row> {
  if (ladder) return ladder;
  const rows = new Map<string, Row>();
  for (const pile of PILES) {
    for (const sampling of Object.keys(SAMPLERS) as SamplingName[]) {
      for (const density of DENSITIES) {
        const row = measure(pile, sampling, density);
        rows.set(row.key, row);
      }
    }
  }
  const all = [...rows.values()];
  report('analytic ladder', [
    '| case | runs | points | hull/apron | hull cut pile | point-sample err mean (range) | rms | grid err mean (range) | rms | grid closer | gap | support | cell m | M/P/W |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...all.map((r) =>
      `| ${r.key} | ${r.runs} | ${r.points} | ${r.footprint.toFixed(3)} | ${r.cutRuns} | ` +
      `${pct(r.psErr[0])} (${pct(r.psErr[1])} to ${pct(r.psErr[2])}) | ${(r.psRms * 100).toFixed(1)} | ` +
      `${pct(r.gridErr[0])} (${pct(r.gridErr[1])} to ${pct(r.gridErr[2])}) | ${(r.gridRms * 100).toFixed(1)} | ` +
      `${r.gridCloser}/${r.runs} | ${pct(r.gap)} | ${r.support.toFixed(3)} | ${r.cellSize.toFixed(2)} | ` +
      `${r.authority.measured}/${r.authority.preview}/${r.authority.withheld} |`),
    ...all.map((r) =>
      `  '${r.key}': [${r.psErr[0].toFixed(4)}, ${r.psRms.toFixed(4)}, ${r.gridErr[0].toFixed(4)}, ${r.gridRms.toFixed(4)}, ${r.support.toFixed(3)}],`),
  ]);
  ladder = rows;
  return rows;
}

// ── repository fixtures ───────────────────────────────────────────────────

/** Parse a comma- or header-led text point file into interleaved positions. */
function readPoints(rel: string, header: boolean): Float32Array {
  const text = readFileSync(resolve(ROOT, rel), 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const body = header ? lines.slice(1) : lines;
  const out = new Float32Array(body.length * 3);
  for (let i = 0; i < body.length; i++) {
    const f = body[i].split(',');
    out[i * 3] = Number(f[0]);
    out[i * 3 + 1] = Number(f[1]);
    out[i * 3 + 2] = Number(f[2]);
  }
  return out;
}

function squareLasso(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

interface FixtureRow {
  readonly id: string;
  readonly d: DualAnswer;
  /** Truth above each estimator's own reference, m³, when the scene has one. */
  readonly truthPs: number | null;
  readonly truthGrid: number | null;
}

const TAU = Math.PI * 2;
/** The closed-form ground surfaces of the rasterisation fixtures (make-fixtures.mjs). */
const RASTER_SURFACES: Record<string, Surface | null> = {
  'R01-tilted-plane': (x, y) => 100 + 0.08 * x - 0.05 * y,
  'R02-rolling-incommensurate': (x, y) => 60 + 3 * Math.sin((TAU * x) / 37) + 2 * Math.cos((TAU * y) / 23),
  // A third of the returns carry a random canopy lift, so no single surface is the truth.
  'R03-ridge-with-canopy': null,
  'R04-variable-density': (x, y) => 90 + 6 * Math.exp(-((x - 30) ** 2 + (y - 50) ** 2) / 400),
};

interface ChangeCase {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly b: ReadonlyArray<number | null>;
}

/** Epoch b of a change fixture as one return per 1 m cell centre; a null cell has none. */
function changeCloud(c: ChangeCase): Float32Array {
  const pts: number[] = [];
  for (let row = 0; row < c.height; row++) {
    for (let col = 0; col < c.width; col++) {
      const z = c.b[row * c.width + col];
      if (z !== null) pts.push(col + 0.5, row + 0.5, z);
    }
  }
  return Float32Array.from(pts);
}

const polyArea = (p: ReadonlyArray<{ x: number; y: number }>): number => {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return Math.abs(s) / 2;
};

/**
 * Area of an axis-aligned rectangle inside a convex polygon: the rectangle
 * clipped against each polygon edge in turn. Written here rather than taken
 * from the estimator, so the truth does not lean on the code it judges.
 */
function rectInConvex(hull: ReadonlyArray<{ x: number; y: number }>, x0: number, y0: number, x1: number, y1: number): number {
  let signed = 0;
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) signed += hull[j].x * hull[i].y - hull[i].x * hull[j].y;
  const orient = signed >= 0 ? 1 : -1;
  let poly = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  for (let i = 0; i < hull.length && poly.length > 0; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const side = (p: { x: number; y: number }): number => orient * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    const next: Array<{ x: number; y: number }> = [];
    for (let k = 0; k < poly.length; k++) {
      const cur = poly[k], prev = poly[(k + poly.length - 1) % poly.length];
      const sc = side(cur), sp = side(prev);
      if (sc >= 0) {
        if (sp < 0) { const t = sp / (sp - sc); next.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) }); }
        next.push(cur);
      } else if (sp >= 0) {
        const t = sp / (sp - sc);
        next.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
      }
    }
    poly = next;
  }
  return poly.length >= 3 ? polyArea(poly) : 0;
}

/** Truth for a change fixture: each observed cell a flat 1 m tile, clipped to the hull. */
function changeTruth(c: ChangeCase, hull: ReadonlyArray<{ x: number; y: number }>, base: number): number {
  let v = 0;
  for (let row = 0; row < c.height; row++) {
    for (let col = 0; col < c.width; col++) {
      const z = c.b[row * c.width + col];
      if (z === null || z <= base) continue;
      v += rectInConvex(hull, col, row, col + 1, row + 1) * (z - base);
    }
  }
  return v;
}

let fixtures: Map<string, FixtureRow> | null = null;
function fixtureRows(): Map<string, FixtureRow> {
  if (fixtures) return fixtures;
  const rows = new Map<string, FixtureRow>();

  for (const [id, surface] of Object.entries(RASTER_SURFACES)) {
    const positions = readPoints(`validation/external-oracles/rasterize/points/${id}.xyz`, false);
    const d = dualAnswer(positions, squareLasso(-1, -1, 81, 81), METRES, true);
    rows.set(id, {
      id,
      d,
      truthPs: surface ? volumeOverHull(d.hull, surface, d.recordBase, 0.02) : null,
      truthGrid: surface ? volumeOverHull(d.hull, surface, d.gridBase, 0.02) : null,
    });
  }

  const change = JSON.parse(readFileSync(resolve(ROOT, 'validation/external-oracles/change/fixtures.json'), 'utf8')) as {
    cases: ChangeCase[];
  };
  for (const id of ['C02-block-uplift', 'C07-holes', 'C08-ramp']) {
    const c = change.cases.find((k) => k.id === id)!;
    const d = dualAnswer(changeCloud(c), squareLasso(-1, -1, c.width + 1, c.height + 1), METRES, true);
    rows.set(id, { id, d, truthPs: changeTruth(c, d.hull, d.recordBase), truthGrid: changeTruth(c, d.hull, d.gridBase) });
  }

  // Real airborne survey: no truth, only the two answers side by side.
  const estonia = readPoints('validation/cross-implementation/pdal-pipeline/fixtures/pc-16-estonia-boreal.csv', true);
  rows.set('pc-16-estonia-boreal', {
    id: 'pc-16-estonia-boreal',
    d: dualAnswer(estonia, squareLasso(-1, -1, 151, 151), METRES, true),
    truthPs: null,
    truthGrid: null,
  });

  report('repository fixtures', [
    '| fixture | points | record ref | grid base | truth at ref | truth at base | point-sample fill | cut | net | err | grid fill | cut | net | err | support | cell m | authority | gap |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...[...rows.values()].map(({ id, d, truthPs, truthGrid }) =>
      `| ${id} | ${d.selected} | ${d.recordBase.toFixed(3)} | ${d.gridBase.toFixed(3)} | ` +
      `${truthPs === null ? 'n/a' : truthPs.toFixed(1)} | ${truthGrid === null ? 'n/a' : truthGrid.toFixed(1)} | ` +
      `${d.ps.fill.toFixed(1)} | ${d.ps.cut.toFixed(1)} | ${d.ps.net.toFixed(1)} | ${truthPs === null ? 'n/a' : pct(d.ps.fill / truthPs - 1, 2)} | ` +
      `${d.grid.fill.toFixed(1)} | ${d.grid.cut.toFixed(1)} | ${d.grid.net.toFixed(1)} | ${truthGrid === null ? 'n/a' : pct(d.grid.fill / truthGrid - 1, 2)} | ` +
      `${d.grid.supportFraction.toFixed(3)} | ${d.grid.cellSize.toFixed(2)} | ${d.grid.authority} | ${pct(d.grid.fill / d.ps.fill - 1)} |`),
    ...[...rows.values()].map(({ id, d }) =>
      `  '${id}': [${d.ps.fill.toFixed(2)}, ${d.grid.fill.toFixed(2)}, ${d.grid.supportFraction.toFixed(3)}, '${d.grid.authority}'],`),
  ]);
  fixtures = rows;
  return rows;
}

// ── sparse coverage and a concave lasso ───────────────────────────────────

interface SparseRow {
  readonly id: string;
  readonly d: DualAnswer;
  readonly truth: number;
}

let sparse: Map<string, SparseRow> | null = null;
function sparseRows(): Map<string, SparseRow> {
  if (sparse) return sparse;
  const rows = new Map<string, SparseRow>();
  const full = uniform(Math.round(10 * APRON_AREA), lcg(0x5a5e0001));
  // A strip along the far edges stays, so the hull still spans the apron and
  // the gap is inside the footprint rather than cut out of it.
  const edge = (x: number, y: number): boolean => x > A - 1 || y > A - 1;
  const cases: Array<[string, (x: number, y: number) => boolean, ReadonlyArray<{ x: number; y: number }>]> = [
    ['full coverage', () => true, LASSO],
    ['one quadrant unobserved', (x, y) => !(x > 0 && y > 0) || edge(x, y), LASSO],
    ['east of x = -3 unobserved', (x, y) => x <= -3 || edge(x, y), LASSO],
    // A lasso with a notch east of the pile: the notch holds no selected
    // points, and the convex hull spans it anyway.
    ['notched lasso', () => true, [
      { x: -A - 1, y: -A - 1 }, { x: A + 1, y: -A - 1 }, { x: A + 1, y: -7 },
      { x: 6.5, y: -7 }, { x: 6.5, y: 7 }, { x: A + 1, y: 7 },
      { x: A + 1, y: A + 1 }, { x: -A - 1, y: A + 1 },
    ]],
  ];
  for (const [id, keep, lasso] of cases) {
    const d = dualAnswer(cloudOf(full.filter(([x, y]) => keep(x, y)), CONE.surface), lasso, METRES, true);
    rows.set(id, { id, d, truth: CONE.volume });
  }
  report('sparse coverage, cone 10 pts/m² uniform', [
    '| case | points | hull m² | point-sample fill | err | grid fill | err | support | coverage | authority | toast |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...[...rows.values()].map(({ id, d, truth }) =>
      `| ${id} | ${d.selected} | ${d.footprintM2.toFixed(1)} | ${d.ps.fill.toFixed(1)} | ${pct(d.ps.fill / truth - 1)} | ` +
      `${d.grid.fill.toFixed(1)} | ${pct(d.grid.fill / truth - 1)} | ${d.grid.supportFraction.toFixed(3)} | ` +
      `${d.grid.coverage} | ${d.grid.authority} | ${d.toastSuffix} |`),
    ...[...rows.values()].map(({ id, d }) =>
      `  '${id}': [${d.ps.fill.toFixed(2)}, ${d.grid.fill.toFixed(2)}, ${d.grid.supportFraction.toFixed(3)}, '${d.grid.authority}'],`),
  ]);
  sparse = rows;
  return rows;
}

// ── units ─────────────────────────────────────────────────────────────────

const US_FT = 1200 / 3937;

interface UnitsRow {
  readonly id: string;
  readonly units: Units;
  readonly d: DualAnswer;
  /** The grid run with its own `linearUnitToMetres`, m³: what that option would report. */
  readonly gridOwnM3: number;
}

let unitRows: Map<string, UnitsRow> | null = null;
function unitsRows(): Map<string, UnitsRow> {
  if (unitRows) return unitRows;
  const rows = new Map<string, UnitsRow>();
  const xy = uniform(Math.round(10 * APRON_AREA), lcg(0x0417_0001));
  const variants: Array<[string, Units]> = [
    ['metres', { lin: 1, vert: 1 }],
    ['US survey feet', { lin: US_FT, vert: US_FT }],
    ['metres over US survey feet', { lin: 1, vert: US_FT }],
  ];
  for (const [id, units] of variants) {
    // The same pile written in native units: coordinates divided by the factor per axis.
    const native = new Float32Array(xy.length * 3);
    for (let i = 0; i < xy.length; i++) {
      native[i * 3] = xy[i][0] / units.lin;
      native[i * 3 + 1] = xy[i][1] / units.lin;
      native[i * 3 + 2] = CONE.surface(xy[i][0], xy[i][1]) / units.vert;
    }
    const lasso = LASSO.map((p) => ({ x: p.x / units.lin, y: p.y / units.lin }));
    const d = dualAnswer(native, lasso, units, true);
    const pts: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < xy.length; i++) pts.push({ x: native[i * 3], y: native[i * 3 + 1], z: native[i * 3 + 2] });
    const own = stockpileAreaGrid({
      points: pts,
      polygon: d.hull,
      base: { kind: 'constant', zM: d.gridBase },
      linearUnitToMetres: units.lin,
    });
    rows.set(id, { id, units, d, gridOwnM3: own.fillM3 });
  }
  report('units, cone 10 pts/m² uniform', [
    '| representation | lin | vert | point-sample m³ | grid m³ (app path) | grid m³ (own factor) | cell m |',
    '|---|---|---|---|---|---|---|',
    ...[...rows.values()].map(({ id, units, d, gridOwnM3 }) =>
      `| ${id} | ${units.lin.toFixed(7)} | ${units.vert.toFixed(7)} | ${d.ps.fill.toFixed(4)} | ${d.grid.fill.toFixed(4)} | ${gridOwnM3.toFixed(4)} | ${d.grid.cellSize.toFixed(4)} |`),
  ]);
  unitRows = rows;
  return rows;
}

// ── the measurements ──────────────────────────────────────────────────────

/**
 * The ladder as measured: [point-sample mean error, point-sample RMS error,
 * grid mean error, grid RMS error, grid support fraction], each error relative
 * to the closed-form volume. Every run is seeded, so a rerun reproduces these
 * to rounding. The tolerance is 0.15 percentage points, well under the
 * smallest difference any statement below rests on, so it absorbs rounding
 * and nothing an estimator change would do.
 */
const LADDER: Record<string, readonly [number, number, number, number, number]> = {
  'cone/uniform/1': [-0.0357, 0.1097, -0.0295, 0.0553, 0.984],
  'cone/uniform/10': [0.0060, 0.0275, -0.0041, 0.0077, 0.998],
  'cone/uniform/100': [-0.0005, 0.0061, -0.0010, 0.0011, 0.998],
  'cone/clustered/1': [-0.0486, 0.2992, -0.1980, 0.2413, 0.776],
  'cone/clustered/10': [-0.0315, 0.1056, -0.0371, 0.0464, 0.968],
  'cone/clustered/100': [-0.0077, 0.0100, -0.0029, 0.0031, 0.996],
  'cone/gradient/1': [-0.2438, 0.2520, -0.0544, 0.0964, 0.929],
  'cone/gradient/10': [-0.1780, 0.1812, -0.0117, 0.0180, 0.954],
  'cone/gradient/100': [-0.1855, 0.1859, -0.0144, 0.0145, 0.959],
  'frustum/uniform/1': [-0.0089, 0.1018, -0.0424, 0.0696, 0.987],
  'frustum/uniform/10': [0.0055, 0.0373, -0.0097, 0.0117, 0.998],
  'frustum/uniform/100': [0.0039, 0.0101, -0.0009, 0.0011, 0.998],
  'frustum/clustered/1': [-0.0883, 0.2786, -0.2640, 0.3084, 0.741],
  'frustum/clustered/10': [0.0151, 0.0776, -0.0321, 0.0363, 0.972],
  'frustum/clustered/100': [-0.0090, 0.0257, -0.0038, 0.0039, 0.996],
  'frustum/gradient/1': [-0.2350, 0.2525, -0.0463, 0.0835, 0.929],
  'frustum/gradient/10': [-0.1989, 0.2006, -0.0207, 0.0248, 0.951],
  'frustum/gradient/100': [-0.1936, 0.1941, -0.0163, 0.0172, 0.956],
  'mound/uniform/1': [-0.0156, 0.0873, -0.0167, 0.0453, 0.988],
  'mound/uniform/10': [0.0045, 0.0221, -0.0033, 0.0058, 0.998],
  'mound/uniform/100': [-0.0007, 0.0059, -0.0026, 0.0030, 0.998],
  'mound/clustered/1': [-0.0841, 0.2346, -0.2412, 0.2754, 0.763],
  'mound/clustered/10': [0.0063, 0.0544, -0.0319, 0.0340, 0.968],
  'mound/clustered/100': [-0.0053, 0.0294, -0.0035, 0.0039, 0.997],
  'mound/gradient/1': [-0.2115, 0.2224, -0.0309, 0.0682, 0.932],
  'mound/gradient/10': [-0.1832, 0.1846, -0.0321, 0.0336, 0.949],
  'mound/gradient/100': [-0.1652, 0.1653, -0.0200, 0.0201, 0.954],
};
const LADDER_TOL = 0.0015;

/** Runs per configuration whose hull cut into the pile, as measured. */
const CUT_RUNS: Record<string, number> = { 'cone/clustered/1': 1, 'mound/clustered/1': 1 };

/** Single runs as measured: [point-sample fill m³, grid fill m³, grid support, authority]. */
const SINGLE: Record<string, readonly [number, number, number, StockpileAuthority]> = {
  'R01-tilted-plane': [22920.15, 23062.85, 0.997, 'measured'],
  'R02-rolling-incommensurate': [27338.78, 27469.24, 0.997, 'measured'],
  'R03-ridge-with-canopy': [53688.14, 49053.95, 0.997, 'measured'],
  'R04-variable-density': [4450.06, 6774.70, 0.929, 'measured'],
  'C02-block-uplift': [40.00, 33.84, 1.000, 'measured'],
  'C07-holes': [33.35, 33.86, 0.958, 'measured'],
  'C08-ramp': [292.41, 340.69, 1.000, 'measured'],
  'pc-16-estonia-boreal': [245739.99, 236996.49, 0.993, 'measured'],
  'full coverage': [108.40, 112.09, 0.993, 'measured'],
  'one quadrant unobserved': [102.73, 94.64, 0.848, 'preview'],
  'east of x = -3 unobserved': [31.23, 11.80, 0.455, 'withheld'],
  'notched lasso': [120.61, 110.88, 0.906, 'measured'],
};

function expectSingle(id: string, d: DualAnswer): void {
  const [ps, grid, support, authority] = SINGLE[id];
  expect(d.ps.fill / ps - 1, `${id} point sample`).toBeCloseTo(0, 3);
  expect(d.grid.fill / grid - 1, `${id} grid`).toBeCloseTo(0, 3);
  expect(d.grid.supportFraction, `${id} support`).toBeCloseTo(support, 2);
  expect(d.grid.authority, `${id} authority`).toBe(authority);
}

/** Every answer the file produced, for the checks that hold across all of them. */
function everyAnswer(): Array<[string, DualAnswer]> {
  return [
    ...[...fixtureRows().values()].map((r): [string, DualAnswer] => [r.id, r.d]),
    ...[...sparseRows().values()].map((r): [string, DualAnswer] => [r.id, r.d]),
    ...[...unitsRows().values()].map((r): [string, DualAnswer] => [r.id, r.d]),
  ];
}

describe('the harness takes both answers from the app path', () => {
  it('prints in the toast the band figure measured here', () => {
    for (const [id, d] of everyAnswer()) {
      const expected = d.grid.authority === 'withheld'
        ? 'Stockpile: volume withheld'
        : `Stockpile: ${toastInt(d.presenterM3)} m³`;
      expect(d.toastSuffix, id).toContain(expected);
    }
    for (const r of analyticLadder().values()) {
      expect(r.toastSuffix, r.key).toContain(`Stockpile: ${toastInt(r.toastM3)} m³`);
    }
  }, 60_000);

  it('reads the grid figure the presenter reads', () => {
    for (const [id, d] of everyAnswer()) {
      expect(d.presenterM3, id).toBeCloseTo(d.grid.fill, 9);
    }
  });

  it('reads the closed form as truth wherever the pile lies inside the hull', () => {
    for (const r of analyticLadder().values()) {
      // Only the clumped 1 pt/m² sample ever pulls the hull across a pile
      // edge, once each for the cone and the mound.
      expect(r.cutRuns, r.key).toBe(CUT_RUNS[r.key] ?? 0);
      expect(r.maxCut, r.key).toBe(0);
    }
  });

  it('checks each closed form against quadrature of its surface', () => {
    for (const pile of PILES) {
      const q = volumeOverHull(APRON_POLY, pile.surface, 0, 0.005);
      expect(Math.abs(q / pile.volume - 1), pile.name).toBeLessThan(2e-4);
    }
  });
});

describe('analytic piles: where each estimator lands', () => {
  it('reproduces the measured ladder', () => {
    const rows = analyticLadder();
    expect(rows.size).toBe(Object.keys(LADDER).length);
    for (const [key, [psMean, psRms, gridMean, gridRms, support]] of Object.entries(LADDER)) {
      const r = rows.get(key)!;
      expect(Math.abs(r.psErr[0] - psMean), `${key} point-sample mean`).toBeLessThan(LADDER_TOL);
      expect(Math.abs(r.psRms - psRms), `${key} point-sample rms`).toBeLessThan(LADDER_TOL);
      expect(Math.abs(r.gridErr[0] - gridMean), `${key} grid mean`).toBeLessThan(LADDER_TOL);
      expect(Math.abs(r.gridRms - gridRms), `${key} grid rms`).toBeLessThan(LADDER_TOL);
      expect(Math.abs(r.support - support), `${key} support`).toBeLessThan(0.002);
    }
  }, 60_000);

  it('under a scanner gradient the point sample reads 16 to 25 % low at every density; the grid reads 1 to 6 % low', () => {
    for (const r of analyticLadder().values()) {
      if (!r.key.includes('/gradient/')) continue;
      expect(r.psErr[0], r.key).toBeLessThan(-0.16);
      expect(r.psErr[0], r.key).toBeGreaterThan(-0.25);
      expect(r.gridErr[0], r.key).toBeLessThan(0);
      expect(r.gridErr[0], r.key).toBeGreaterThan(-0.06);
      // More points do not close it: the bias is in how the points are weighted.
      expect(r.gap, r.key).toBeGreaterThan(0.17);
      // The grid is nearer the truth in all but at most two runs.
      expect(r.gridCloser, r.key).toBeGreaterThanOrEqual(r.runs - 2);
    }
  });

  it('under uniform sampling both centre on the truth; the grid reads slightly low and scatters less', () => {
    for (const r of analyticLadder().values()) {
      if (!r.key.includes('/uniform/')) continue;
      expect(r.gridErr[0], r.key).toBeLessThan(0);
      expect(r.gridRms, r.key).toBeLessThan(r.psRms);
      if (!r.key.endsWith('/1')) {
        expect(Math.abs(r.psErr[0]), r.key).toBeLessThan(0.01);
        expect(Math.abs(r.gridErr[0]), r.key).toBeLessThan(0.012);
      }
    }
  });

  it('clustered at 1 pt/m², neither is within 20 % and the grid says PREVIEW in every run', () => {
    for (const r of analyticLadder().values()) {
      if (!r.key.endsWith('/clustered/1')) continue;
      expect(r.psRms, r.key).toBeGreaterThan(0.2);
      expect(r.gridRms, r.key).toBeGreaterThan(0.2);
      // Only supported cells are counted, so the grid reads low by roughly the unsupported share.
      expect(r.gridErr[0], r.key).toBeLessThan(-0.19);
      expect(r.authority.preview, r.key).toBe(r.runs);
      // The point sample lands nearer in most runs here.
      expect(r.gridCloser, r.key).toBeLessThan(r.runs / 2);
    }
  });

  it('clustered at 10 pts/m², the grid says MEASURED in every run while reading 3 to 4 % low', () => {
    for (const r of analyticLadder().values()) {
      if (!r.key.endsWith('/clustered/10')) continue;
      expect(r.authority.measured, r.key).toBe(r.runs);
      expect(r.gridErr[0], r.key).toBeLessThan(-0.03);
      expect(r.gridErr[0], r.key).toBeGreaterThan(-0.04);
    }
  });
});

describe('repository fixtures', () => {
  it('reproduces the measured answers', () => {
    for (const { id, d } of fixtureRows().values()) expectSingle(id, d);
  }, 60_000);

  it('reads the variable-density surface 39 % low by point sample and 7 % low by grid', () => {
    const { d, truthPs, truthGrid } = fixtureRows().get('R04-variable-density')!;
    expect(d.ps.fill / truthPs! - 1).toBeLessThan(-0.35);
    expect(d.grid.fill / truthGrid! - 1).toBeLessThan(-0.05);
    expect(d.grid.fill / truthGrid! - 1).toBeGreaterThan(-0.08);
  });

  it('reads the two uniformly sampled surfaces within 1.1 %, the grid the nearer', () => {
    for (const id of ['R01-tilted-plane', 'R02-rolling-incommensurate']) {
      const { d, truthPs, truthGrid } = fixtureRows().get(id)!;
      const ep = d.ps.fill / truthPs! - 1;
      const eg = d.grid.fill / truthGrid! - 1;
      expect(Math.abs(ep), id).toBeLessThan(0.011);
      expect(Math.abs(eg), id).toBeLessThan(Math.abs(ep));
    }
  });

  it('recovers a sharp block exactly by point sample and loses 15 % of it by grid', () => {
    const { d, truthPs } = fixtureRows().get('C02-block-uplift')!;
    expect(truthPs).toBeCloseTo(40, 9);
    expect(d.ps.fill).toBeCloseTo(40, 6);
    expect(d.grid.fill / 40 - 1).toBeLessThan(-0.15);
  });

  it('can integrate the two answers against different references for one lasso', () => {
    // The record's reference is the 5th percentile of every selected height; the
    // band's base is the 5th percentile of the heights its polygon test keeps,
    // which drops the hull's top and right edges. On the ramp lattice the
    // dropped column moves the percentile off the zero row.
    const { d } = fixtureRows().get('C08-ramp')!;
    expect(d.recordBase).toBeCloseTo(0.095, 6);
    expect(d.gridBase).toBe(0);
  });

  it('on real airborne returns and on a canopy the two disagree with no truth to settle it', () => {
    const forest = fixtureRows().get('pc-16-estonia-boreal')!.d;
    expect(forest.grid.fill / forest.ps.fill - 1).toBeCloseTo(-0.036, 3);
    const canopy = fixtureRows().get('R03-ridge-with-canopy')!.d;
    expect(canopy.grid.fill / canopy.ps.fill - 1).toBeCloseTo(-0.086, 3);
  });
});

describe('sparse coverage and a concave lasso', () => {
  it('reproduces the measured answers', () => {
    for (const { id, d } of sparseRows().values()) expectSingle(id, d);
  });

  it('withholds the grid figure at 46 % support while the record keeps a high-confidence figure', () => {
    const { d, truth } = sparseRows().get('east of x = -3 unobserved')!;
    expect(d.grid.authority).toBe('withheld');
    expect(d.toastSuffix).not.toMatch(/\d m³/);
    expect(d.recordConfidence).toBe('high');
    expect(d.ps.fill / truth - 1).toBeLessThan(-0.7);
  });

  it('marks a missing quadrant PREVIEW, and reads it lower than the point sample does', () => {
    const { d, truth } = sparseRows().get('one quadrant unobserved')!;
    expect(d.grid.authority).toBe('preview');
    expect(d.grid.fill).toBeLessThan(d.ps.fill);
    expect(d.ps.fill / truth - 1).toBeLessThan(-0.05);
  });

  it('a notch in the lasso inflates the point sample by the hull it adds, and not the grid', () => {
    const full = sparseRows().get('full coverage')!.d;
    const notched = sparseRows().get('notched lasso')!.d;
    // The hull spans the notch whether or not it holds points.
    expect(notched.footprintM2 / full.footprintM2).toBeGreaterThan(0.99);
    expect(notched.ps.fill / full.ps.fill - 1).toBeGreaterThan(0.1);
    expect(Math.abs(notched.grid.fill / full.grid.fill - 1)).toBeLessThan(0.02);
  });
});

describe('units', () => {
  it('gives the same m³ from metres, US survey feet and a compound CRS on the app path', () => {
    const rows = unitsRows();
    const m = rows.get('metres')!.d;
    for (const [id, { d }] of rows) {
      expect(d.ps.fill / m.ps.fill - 1, id).toBeCloseTo(0, 6);
      expect(d.grid.fill / m.grid.fill - 1, id).toBeCloseTo(0, 6);
      expect(d.grid.cellSize / m.grid.cellSize - 1, id).toBeCloseTo(0, 6);
    }
  });

  it('the grid option that cubes one factor overstates a compound CRS by lin / vert', () => {
    for (const { id, units, d, gridOwnM3 } of unitsRows().values()) {
      expect(gridOwnM3 / d.grid.fill, id).toBeCloseTo(units.lin / units.vert, 6);
    }
  });
});

// ── authority on the sampled/streaming axis ─────────────────────────────────

/**
 * `stockpileAuthority` has two branches this file otherwise never reaches: an
 * incomplete source and a voxel-reduced sample each cap a grid at PREVIEW
 * ahead of its support fraction. `dualAnswer` derives `sampled` from
 * `out.anySourceReduced || out.budget.downsample` and `streaming` from
 * `out.streamingContributed`, and every case above walks an in-memory
 * `PointCloud` with `streamingParts: []` and `wasReduced: () => false`, so
 * both read false everywhere in this file: the support/coverage axis is the
 * only one exercised above. This drives `stockpileToastSuffix`, the same call
 * the toast makes, directly with the flags a voxel-reduced or a streaming
 * source sets, on the identical fully-supported selection the baseline case
 * reads MEASURED on, to confirm each still caps it at PREVIEW.
 */
function toastSuffixWithOverride(
  positions: Float32Array,
  lasso: ReadonlyArray<{ x: number; y: number }>,
  overrides: { readonly sourceReduced?: boolean; readonly streamingContributed?: boolean },
): string {
  const cloud = new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 'pile.las' });
  const host: LassoVolumeHost = {
    project: (x, y) => ({ x, y }),
    integrable: [['pile', { cloud }]],
    streamingParts: [],
    wasReduced: () => false,
    visibilityFor: () => null,
    worldUp: [0, 0, 1],
  };
  const out = computeLassoVolume({ host, lasso, referencePercentile: 0.05 });
  if (!out) throw new Error('lasso selected nothing');
  return stockpileToastSuffix(out.polygon3D, out.selectedPositions, 1, {
    sourceReduced: overrides.sourceReduced ?? false,
    densityUnitKnown: true,
    vert: 1,
    streamingContributed: overrides.streamingContributed ?? false,
    // Unknown resident coverage on a streaming source: not evidence of
    // completeness, so `sourceComplete` reads false the way the app's own
    // `stockpileToastSuffix` caller does when a streamed node count is null.
    streamingCoverage: null,
    walkSampled: false,
  });
}

describe('authority on the sampled/streaming axis, independent of support', () => {
  // The cone at 10 pts/m² uniform under the full lasso: the same selection
  // `sparseRows().get('full coverage')` builds, at 0.993 support, well clear
  // of the grid's own coverage threshold.
  const full = uniform(Math.round(10 * APRON_AREA), lcg(0x5a5e0001));
  const positions = cloudOf(full, CONE.surface);

  it('reads MEASURED at baseline, on the selection both override cases reuse', () => {
    const suffix = toastSuffixWithOverride(positions, LASSO, {});
    expect(suffix).toContain('MEASURED');
  });

  it('a voxel-reduced source caps the same well-supported grid at PREVIEW ("display sample")', () => {
    const suffix = toastSuffixWithOverride(positions, LASSO, { sourceReduced: true });
    expect(suffix).toContain('PREVIEW (display sample)');
    expect(suffix).not.toContain('MEASURED');
  });

  it('a streaming source of unknown coverage caps the same well-supported grid at PREVIEW ("streaming and not fully resident")', () => {
    const suffix = toastSuffixWithOverride(positions, LASSO, { streamingContributed: true });
    expect(suffix).toContain('PREVIEW (source is streaming and not fully resident)');
    expect(suffix).not.toContain('MEASURED');
  });
});
