/**
 * contoursAt.ts
 *
 * isolines from a confidence-aware DTM, graded by the
 * evidence behind each segment. Implements marching squares directly in
 * TypeScript (zero dependency) rather than wrapping d3-contour.
 *
 * WHY hand-rolled instead of d3-contour (a documented deviation from
 * an alternative to d3-contour):
 *   - Per-segment honesty. d3-contour stitches whole isoband polygons;
 *     here every emitted segment lives inside exactly one grid cell, so
 *     it can be tagged with that cell's confidence directly — no
 *     post-hoc spatial join, no ambiguity about which cell a vertex
 *     "belongs" to. Evidence grading is the whole point of this feature,
 *     and per-cell segments are the natural unit for it.
 *   - Gap-aware breaks. A cell touching a no-data corner emits NO
 *     segment, so contours break honestly across data gaps instead of
 *     being interpolated straight through them.
 *   - Zero new dependency / zero lazy-chunk + build-guard churn, which
 *     matches the dependency-free, Node-testable ethos of the other pure-data
 *     leaves. Marching squares is a deterministic 50-year-old algorithm;
 *     correctness is pinned against analytic surfaces in the tests.
 *
 * The threshold→grade mapping is NOT redefined here: it is imported from
 * `cellConfidence` (`gradeForConfidence`) so the visual grammar has one
 * source of truth everywhere.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import {
  gradeForConfidence,
  type DtmGrid,
  type EvidenceGrade,
} from '../ground/cellConfidence';

/** One contour segment, in world (CRS) coordinates. */
export interface ContourSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** 0..100 — the minimum confidence of the cell that produced it. */
  readonly confidence: number;
  /** Render class derived from `confidence` via the shared grammar. */
  readonly grade: EvidenceGrade;
}

/** All segments at one elevation level. */
export interface ContourLevel {
  readonly value: number;
  readonly segments: ContourSegment[];
}

/** The full contour result for a DTM at one interval. */
export interface ContourSet {
  readonly levels: ContourLevel[];
  readonly intervalM: number;
  /** Echoes the grid CRS so exporters never lose georeferencing. */
  readonly crs: string | null;
  readonly verticalDatum: string | null;
  /** Min/max finite, covered elevation found (NaN when none). */
  readonly minZ: number;
  readonly maxZ: number;
  readonly warnings: string[];
}

/** Options for {@link contoursAt}. */
export interface ContoursAtParams {
  /** Contour interval in source linear units. Must be > 0. */
  readonly intervalM: number;
  /** Explicit level list — overrides `intervalM`-derived levels. */
  readonly levels?: ReadonlyArray<number>;
  /** Safety cap on number of levels. Default 200. */
  readonly maxLevels?: number;
}

/**
 * Marching-squares segment table, indexed by the 4-bit corner mask
 * `b0|b1<<1|b2<<2|b3<<3` where corners are CCW from bottom-left
 * (v0 BL, v1 BR, v2 TR, v3 TL). Each entry lists edge pairs to connect;
 * edges are 0=bottom(v0-v1) 1=right(v1-v2) 2=top(v2-v3) 3=left(v3-v0).
 * Saddle cases 5 and 10 use the simple (non-center-resolved) pairing.
 */
const SEGMENT_TABLE: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [], // 0
  [[3, 0]], // 1
  [[0, 1]], // 2
  [[3, 1]], // 3
  [[1, 2]], // 4
  [
    [3, 0],
    [1, 2],
  ], // 5 (saddle)
  [[0, 2]], // 6
  [[3, 2]], // 7
  [[2, 3]], // 8
  [[2, 0]], // 9
  [
    [0, 1],
    [2, 3],
  ], // 10 (saddle)
  [[2, 1]], // 11
  [[1, 3]], // 12
  [[1, 0]], // 13
  [[0, 3]], // 14
  [], // 15
];

/**
 * Compute graded contour segments from a DTM. Deterministic. Cells that
 * touch a no-data corner (coverage 0 or non-finite height) are skipped
 * so contours break across gaps rather than being faked through them.
 */
export function contoursAt(dtm: DtmGrid, params: ContoursAtParams): ContourSet {
  const warnings: string[] = [];
  const { cols, rows, cellSizeM, originH1, originH2, z, confidence, coverage } = dtm;

  // Elevation range over covered cells.
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < z.length; i++) {
    if (coverage[i] === 0 || !Number.isFinite(z[i])) continue;
    if (z[i] < minZ) minZ = z[i];
    if (z[i] > maxZ) maxZ = z[i];
  }
  if (!Number.isFinite(minZ) || cols < 2 || rows < 2) {
    warnings.push('insufficient covered cells for contours');
    return {
      levels: [],
      intervalM: params.intervalM,
      crs: dtm.crs,
      verticalDatum: dtm.verticalDatum,
      minZ: Number.NaN,
      maxZ: Number.NaN,
      warnings,
    };
  }

  // Resolve levels.
  const maxLevels = params.maxLevels ?? 200;
  let levelValues: number[];
  if (params.levels && params.levels.length > 0) {
    levelValues = [...params.levels].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  } else {
    const interval = params.intervalM;
    if (!Number.isFinite(interval) || interval <= 0) {
      warnings.push('intervalM invalid — no contours produced');
      return {
        levels: [],
        intervalM: interval,
        crs: dtm.crs,
        verticalDatum: dtm.verticalDatum,
        minZ,
        maxZ,
        warnings,
      };
    }
    levelValues = [];
    // Compute levels as `first + k*interval` (not repeated `+=`) so float
    // error cannot accumulate and shift later levels off their interval.
    const first = Math.ceil(minZ / interval) * interval;
    const count = Math.floor((maxZ - first) / interval + 1e-9) + 1;
    for (let k = 0; k < count; k++) levelValues.push(first + k * interval);
  }
  if (levelValues.length > maxLevels) {
    warnings.push(
      `level count ${levelValues.length} exceeds cap ${maxLevels} — truncated (interval too fine for the elevation range?)`,
    );
    levelValues = levelValues.slice(0, maxLevels);
  }

  const levels: ContourLevel[] = levelValues.map((value) => ({ value, segments: [] }));

  // Corner world positions for a cell at (col,row).
  const cornerXY = (col: number, row: number): [number, number][] => [
    [originH1 + col * cellSizeM, originH2 + row * cellSizeM], // v0 BL
    [originH1 + (col + 1) * cellSizeM, originH2 + row * cellSizeM], // v1 BR
    [originH1 + (col + 1) * cellSizeM, originH2 + (row + 1) * cellSizeM], // v2 TR
    [originH1 + col * cellSizeM, originH2 + (row + 1) * cellSizeM], // v3 TL
  ];

  // Interpolate the crossing point on an edge for level v.
  const edgePoint = (
    edge: number,
    p: [number, number][],
    zc: [number, number, number, number],
    v: number,
  ): [number, number] => {
    const [aIdx, bIdx] = EDGE_CORNERS[edge];
    const za = zc[aIdx];
    const zb = zc[bIdx];
    const denom = zb - za;
    const t = Math.abs(denom) < 1e-12 ? 0.5 : (v - za) / denom;
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    return [p[aIdx][0] + tc * (p[bIdx][0] - p[aIdx][0]), p[aIdx][1] + tc * (p[bIdx][1] - p[aIdx][1])];
  };

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const i0 = row * cols + col;
      const i1 = row * cols + (col + 1);
      const i2 = (row + 1) * cols + (col + 1);
      const i3 = (row + 1) * cols + col;
      // Gap-aware: any no-data corner → no honest contour through here.
      if (
        coverage[i0] === 0 ||
        coverage[i1] === 0 ||
        coverage[i2] === 0 ||
        coverage[i3] === 0 ||
        !Number.isFinite(z[i0]) ||
        !Number.isFinite(z[i1]) ||
        !Number.isFinite(z[i2]) ||
        !Number.isFinite(z[i3])
      ) {
        continue;
      }
      const zc: [number, number, number, number] = [z[i0], z[i1], z[i2], z[i3]];
      const cellConf = Math.min(confidence[i0], confidence[i1], confidence[i2], confidence[i3]);
      const grade = gradeForConfidence(cellConf);
      const p = cornerXY(col, row);

      for (let li = 0; li < levelValues.length; li++) {
        const v = levelValues[li];
        const mask =
          (zc[0] >= v ? 1 : 0) |
          (zc[1] >= v ? 2 : 0) |
          (zc[2] >= v ? 4 : 0) |
          (zc[3] >= v ? 8 : 0);
        const pairs = SEGMENT_TABLE[mask];
        if (pairs.length === 0) continue;
        for (const [ea, eb] of pairs) {
          const a = edgePoint(ea, p, zc, v);
          const b = edgePoint(eb, p, zc, v);
          // Skip degenerate zero-length segments (a corner sat exactly on
          // the level), which would otherwise pollute counts and exports.
          if (a[0] === b[0] && a[1] === b[1]) continue;
          levels[li].segments.push({
            x1: a[0],
            y1: a[1],
            x2: b[0],
            y2: b[1],
            confidence: cellConf,
            grade,
          });
        }
      }
    }
  }

  return {
    levels,
    intervalM: params.intervalM,
    crs: dtm.crs,
    verticalDatum: dtm.verticalDatum,
    minZ,
    maxZ,
    warnings,
  };
}

/** Corner indices each edge sits between (matches SEGMENT_TABLE edges). */
const EDGE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // edge 0 bottom: v0-v1
  [1, 2], // edge 1 right:  v1-v2
  [2, 3], // edge 2 top:    v2-v3
  [3, 0], // edge 3 left:   v3-v0
];
