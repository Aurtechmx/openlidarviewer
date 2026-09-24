/**
 * terrainAccessTypes.ts — the grid a traversability model reads, the profile
 * that bounds it, and what a cell's fate may be.
 *
 * Mirrors the split `src/simulation/flowPulse/flowTypes.ts` makes for the same
 * reason: this module knows nothing about `DtmGrid`, `DemRaster` or the DSM, so
 * a 3×3 terrain can be written by hand in a test. The adapter that knows both
 * sides lives in `dtmTerrainAccessGrid.ts`.
 *
 * ── WHY CONFIDENCE TRAVELS WITH THE GRID, NOT JUST VALIDITY ─────────────────
 * A flow grid only needs to know whether a cell has an elevation. Terrain
 * Access also needs to know how much to trust it: §12.4/§15 of the governing
 * prompt require "weak evidence affects eligibility", and the only per-cell
 * trust signal the terrain core already computes is `DtmGrid.confidence`
 * (0..100, see `cellConfidence.ts`). Carrying it here — rather than requiring
 * every caller to re-derive it — keeps one confidence number in the codebase.
 *
 * ── WHY PROFILE UNITS ARE TANGENTS, NOT DEGREES ─────────────────────────────
 * `TerrainAccessProfile.maxLongitudinalGrade` / `maxCrossSlope` are rise/run
 * TANGENTS (dimensionless), the same unit `hornSlopeAspect`'s `slope` field
 * already uses. The governing prompt's illustrative JSON config (§24) writes
 * `maxLongitudinalGradeDeg` for a human-facing file format; that conversion is
 * a UI/export concern for the later phase. Comparing a tangent against a
 * tangent computed by `directionalGrade.ts` needs no trigonometry in the A*
 * hot path and cannot silently disagree about whether a number is degrees or
 * a ratio. `maxStepHeight`, `vehicleWidth` and `vehicleLength` are METRES —
 * only reachable once `dtmTerrainAccessGrid.ts` has resolved the horizontal
 * and vertical scale, which is exactly the `UNITS_UNRESOLVED` refusal gate in
 * `terrainAccessRunner.ts`.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/** A cell's elevation, validity and evidence, on a fixed-size grid. */
export interface TerrainAccessGrid {
  /** Elevation per cell, metres, row-major. Not read where `valid[i] === 0`. */
  readonly z: Float32Array;
  /** 1 where the cell carries an elevation the model may read, 0 otherwise. */
  readonly valid: Uint8Array;
  /**
   * 0..100 trust per cell, the terrain core's `DtmGrid.confidence` unchanged.
   * 0 where `valid[i] === 0` (a NoData cell has no evidence to score).
   */
  readonly confidence: Float32Array;
  /**
   * The DTM's per-cell provenance code (`CellCoverage` in `cellConfidence.ts`:
   * 0 none, 1 interpolated, 2 measured), passed through unchanged so route
   * diagnostics can report the measured/interpolated/low-confidence split a
   * route actually crosses. Null when the grid was built without that
   * provenance (e.g. a hand-built test fixture) — diagnostics then withhold
   * the split rather than assuming every valid cell was measured.
   */
  readonly coverage: Uint8Array | null;
  /**
   * Optional above-ground return evidence, metres — `DSM − DTM` on the same
   * grid, aligned cell-for-cell. Null when no DSM/nDSM was supplied: the
   * obstruction constraint is then inactive rather than silently zero, which
   * would read as "confirmed clear" instead of "not evaluated".
   */
  readonly heightAboveGround: Float32Array | null;
  /**
   * Optional ROI mask — 1 = inside the declared region, 0 = outside. Null
   * means no ROI was declared, so every cell with an elevation is in scope.
   * A cell with `allowed[i] === 0` is hard-blocked with reason `outside-roi`.
   */
  readonly allowed: Uint8Array | null;
  readonly cols: number;
  readonly rows: number;
  /** East–west cell length in metres. */
  readonly cellMetresX: number;
  /** North–south cell length in metres. */
  readonly cellMetresY: number;
}

/** Throws unless the grid's dimensions and arrays agree. */
export function assertTerrainAccessGrid(grid: TerrainAccessGrid): void {
  const { cols, rows, z, valid, confidence, coverage, heightAboveGround, allowed, cellMetresX, cellMetresY } = grid;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new RangeError(`terrainAccessGrid: cols and rows must be positive integers; got ${cols}×${rows}`);
  }
  const n = cols * rows;
  if (z.length !== n || valid.length !== n || confidence.length !== n) {
    throw new RangeError(
      `terrainAccessGrid: z (${z.length}), valid (${valid.length}) and confidence (${confidence.length}) `
      + `must all be cols×rows (${n})`,
    );
  }
  if (coverage && coverage.length !== n) {
    throw new RangeError(`terrainAccessGrid: coverage must be cols×rows (${n}); got ${coverage.length}`);
  }
  if (heightAboveGround && heightAboveGround.length !== n) {
    throw new RangeError(`terrainAccessGrid: heightAboveGround must be cols×rows (${n}); got ${heightAboveGround.length}`);
  }
  if (allowed && allowed.length !== n) {
    throw new RangeError(`terrainAccessGrid: allowed must be cols×rows (${n}); got ${allowed.length}`);
  }
  for (const [name, m] of [['cellMetresX', cellMetresX], ['cellMetresY', cellMetresY]] as const) {
    if (!(Number.isFinite(m) && m > 0)) {
      throw new RangeError(`terrainAccessGrid: ${name} must be a finite positive length; got ${m}`);
    }
  }
}

/**
 * The user-declared mobility profile (governing prompt §12.3). No field has a
 * hidden safe default: every limit the model enforces is a value this
 * interface requires the caller to state.
 */
export interface TerrainAccessProfile {
  /** Human label for the profile, e.g. "Illustrative — confirm for your platform". */
  readonly name: string;
  /** Rise/run tangent. A move whose longitudinal grade exceeds this is blocked. */
  readonly maxLongitudinalGrade: number;
  /** Rise/run tangent. A move whose cross slope exceeds this is blocked. */
  readonly maxCrossSlope: number;
  /** Metres. An edge whose elevation discontinuity exceeds this is blocked. */
  readonly maxStepHeight: number;
  /** Vector Ruggedness Measure, [0, 1], or null to leave ruggedness unconstrained. */
  readonly maxRuggedness: number | null;
  /** Metres. Used for morphological width-dilation of hard-blocked cells. */
  readonly vehicleWidth: number;
  /** Metres, or null. Reported in diagnostics; not enforced as swept-body collision. */
  readonly vehicleLength: number | null;
  /** 0..100. A cell below this confidence is weak evidence (see `unknownPolicy`). */
  readonly minimumTerrainConfidence: number;
  /** How weak-evidence cells (confidence below the minimum) are treated. */
  readonly unknownPolicy: 'block' | 'penalize';
  /** Metres, or null to leave above-ground obstruction unconstrained/unevaluated. */
  readonly obstacleHeightThreshold: number | null;
}

/** One field of {@link TerrainAccessProfile} failing validation. */
export interface ProfileProblem {
  readonly field: string;
  readonly reason: string;
}

/**
 * Validate a profile's own arithmetic — every limit finite and physically
 * sensible — before it is allowed to gate a single cell. Returns an empty
 * array when the profile is usable.
 */
export function validateProfile(profile: TerrainAccessProfile): readonly ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  const positive = (field: string, v: number): void => {
    if (!(Number.isFinite(v) && v > 0)) problems.push({ field, reason: `must be a finite value > 0; got ${v}` });
  };
  const nonNegative = (field: string, v: number): void => {
    if (!(Number.isFinite(v) && v >= 0)) problems.push({ field, reason: `must be a finite value ≥ 0; got ${v}` });
  };

  if (typeof profile.name !== 'string' || profile.name.trim() === '') {
    problems.push({ field: 'name', reason: 'must be a non-empty label' });
  }
  positive('maxLongitudinalGrade', profile.maxLongitudinalGrade);
  positive('maxCrossSlope', profile.maxCrossSlope);
  nonNegative('maxStepHeight', profile.maxStepHeight);
  if (profile.maxRuggedness != null) {
    if (!(Number.isFinite(profile.maxRuggedness) && profile.maxRuggedness > 0 && profile.maxRuggedness <= 1)) {
      problems.push({ field: 'maxRuggedness', reason: `must be null or in (0, 1]; got ${profile.maxRuggedness}` });
    }
  }
  // 0 is a legitimate declaration (a pedestrian/point-footprint profile
  // declares no width to clear), so this is only non-negative, not positive.
  nonNegative('vehicleWidth', profile.vehicleWidth);
  if (profile.vehicleLength != null) positive('vehicleLength', profile.vehicleLength);
  if (!(Number.isFinite(profile.minimumTerrainConfidence)
    && profile.minimumTerrainConfidence >= 0 && profile.minimumTerrainConfidence <= 100)) {
    problems.push({
      field: 'minimumTerrainConfidence',
      reason: `must be a finite value in [0, 100]; got ${profile.minimumTerrainConfidence}`,
    });
  }
  if (profile.unknownPolicy !== 'block' && profile.unknownPolicy !== 'penalize') {
    problems.push({ field: 'unknownPolicy', reason: `must be 'block' or 'penalize'; got ${String(profile.unknownPolicy)}` });
  }
  if (profile.obstacleHeightThreshold != null) positive('obstacleHeightThreshold', profile.obstacleHeightThreshold);

  return problems;
}

/**
 * The eight neighbour offsets, in the order ties are broken — for Terrain
 * Access specifically. Written out independently of
 * `flowPulse/flowTypes.ts`'s `D8_NEIGHBOURS` even though the order matches:
 * the two simulations use it for unrelated purposes (drainage direction vs.
 * A* expansion order), and a future change to one method's tie-break must not
 * silently ripple into the other through a shared constant.
 */
export const TERRAIN_ACCESS_NEIGHBOURS: readonly (readonly [number, number])[] = Object.freeze([
  [1, 0],   // E
  [1, 1],   // SE
  [0, 1],   // S
  [-1, 1],  // SW
  [-1, 0],  // W
  [-1, -1], // NW
  [0, -1],  // N
  [1, -1],  // NE
]);

/** Reasons a cell (node) is hard-blocked regardless of the direction entered. */
export type NodeBlockReason =
  | 'no-data'
  | 'outside-roi'
  | 'low-confidence'
  | 'ruggedness'
  | 'obstruction'
  /** Not itself one of the declared limits: the cell is close enough to a
   * limit-blocked cell that the declared vehicle width cannot clear it. */
  | 'vehicle-width';

/** Reasons a specific directed edge is hard-blocked. */
export type EdgeBlockReason =
  | 'longitudinal-grade'
  | 'cross-slope'
  | 'step-height';

/** Every declared hard-block reason, node or edge. */
export type BlockReason = NodeBlockReason | EdgeBlockReason;
