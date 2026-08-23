/**
 * groundFilter.ts
 *
 * Pure-data ground classification — the first leaf of the
 * confidence-aware DTM spine. Given a set of
 * scan-local points and a small parameter bundle, it separates
 * bare-earth ("ground") returns from above-ground returns (vegetation,
 * buildings, noise) and emits the provisional ground surface grid that
 * `rasterizeDtm` / `cellConfidence` build on.
 *
 * WHY a Simple Morphological Filter (SMRF), not CSF.
 *   CSF (cloth simulation) is the desktop standard, but its only mature
 *   implementation is C++ with no maintained WebAssembly build — porting
 *   it is a multi-week sink for a solo dev. SMRF (Pingel, Clarke &
 *   McBride 2013) is grid-native, deterministic, and expressible as a
 *   few hundred lines of pure TypeScript with no dependencies. It also
 *   matches the way the rest of `src/terrain/` already thinks: in
 *   regular grids.
 *
 * WHAT THIS IMPLEMENTS (and, per the no-overclaim rule, what it does
 * NOT). This is a faithful implementation of the SMRF *core*:
 *   1. Minimum-elevation grid — rasterise points to a regular grid,
 *      take the lowest return per cell (the bare-earth candidate).
 *   2. Empty-cell inpaint — nearest-finite flood fill so the
 *      morphological passes operate on a continuous surface (SMRF uses
 *      a spring-metaphor inpaint; nearest-finite is a deterministic,
 *      dependency-free stand-in that is honest about being simpler).
 *   3. Progressive morphological opening — open the surface with a flat
 *      structuring element of growing radius and compare the drop
 *      against a slope-scaled threshold `dh = elevationThresholdM +
 *      slope · b · cellSize` (the cell run in z's unit — see
 *      `GroundFilterParams.cellSizeZUnits`). This is the heart shared by
 *      SMRF and Zhang's PMF.
 *   4. Point classification — a return is ground when it sits within a
 *      slope-scaled tolerance of the final opened surface beneath it.
 *
 *   TWO OPENING RULES, AND WHY BOTH ARE HERE. `openingMode` selects
 *   between them and defaults to `'cut-surface'`, the rule this filter
 *   has always run and the one every committed terrain product was
 *   measured under. It carries a single work surface through the window
 *   ladder and writes a cell down whenever the drop exceeds `dh`, so
 *   radius `b + 1` opens a surface radius `b` already lowered and the
 *   drops compound. On ground that genuinely falls away across the
 *   ladder that compounding cuts bare earth: measured against
 *   `filters.smrf` over the committed study scenes it marks 1599 of 2500
 *   cells on the rolling scene where the published rule marks 218.
 *
 *   `'object-mask'` is the rule as published (Pingel, Clarke & McBride
 *   2013) and as implemented in PDAL's `filters.smrf`. The surface is
 *   never written down; each radius opens the original, the drop is
 *   measured against the previous radius' opening, the result is a
 *   sticky object mask, and the masked cells are interpolated from their
 *   nearest unmasked neighbours before any point is classified.
 *   `structuringElement` selects the element shape independently and
 *   defaults to `'square'`; `'diamond'` is the L1 element the published
 *   filter uses. `tests/groundFilterPdalAgreement.test.ts` carries the
 *   measured agreement for the combination the study runs.
 *
 *   It does NOT implement SMRF's net-cutting refinement pass, its
 *   low-point pre-pass, or its image-processing-grade inpaint (the
 *   object-cell refill here is the same nearest-finite flood fill used
 *   for empty cells, where the published filter interpolates from k
 *   neighbours). The missing low-point pass is why a scene carrying
 *   gross below-ground blunders is not helped by `'object-mask'` alone;
 *   `floorPercentile` is this filter's separate answer to that.
 *
 *   LOW-OUTLIER DESPIKE. A gross below-ground blunder (multipath, water
 *   returns, sensor noise) can seed a false low surface, and grayscale
 *   opening removes peaks, not pits, so it does not self-correct. The
 *   `floorPercentile` option addresses this: instead of the strict
 *   per-cell minimum it takes the elevation at a low percentile of the
 *   cell's returns, so a lone blunder is ignored once a cell has enough
 *   returns. It defaults to 0 (strict minimum) at this leaf for
 *   backward-compatible behaviour; the pipeline orchestrator enables a
 *   small floor by default.
 *
 * HONESTY CONTRACT. Like every terrain leaf, the result carries
 * coverage provenance (`coverage`, `sourcePointCount`,
 * `analyzedPointCount`) plus the ordered `warnings` that explain any
 * quality reduction. Classification quality silently determines contour
 * quality downstream, so the result exposes enough for the caller to
 * surface "how trustworthy is this ground?" rather than hiding it.
 *
 * Pure data: no DOM, no three.js, no I/O. Node-testable. The worker
 * layer (the worker integration) adapts typed-array positions into the
 * `TerrainPoint[]` this module consumes; performance tiering lives
 * there, not here — this leaf optimises for correctness and clarity.
 */

import type { TerrainPoint, TerrainCoverageMode } from '../TerrainContracts';

/** Which axis is the vertical (elevation) axis in the source frame. */
export type VerticalAxis = 'z' | 'y';

/**
 * How the progressive morphological opening decides which cells carry
 * above-ground objects.
 *
 * `'cut-surface'` — the original OpenLiDARViewer behaviour. One work surface is
 * carried through the window ladder and a cell is written down to the opened
 * height whenever the drop exceeds the threshold, so radius `b + 1` opens a
 * surface that radius `b` already lowered.
 *
 * `'object-mask'` — the behaviour published as SMRF (Pingel, Clarke & McBride
 * 2013) and implemented in PDAL's `filters.smrf`. The minimum-elevation surface
 * is never written down. Each radius opens the ORIGINAL surface, the drop is
 * measured against the PREVIOUS radius' opening rather than against a lowered
 * surface, and the outcome is a sticky per-cell object mask. Cells the mask
 * marks are then interpolated from their nearest unmarked neighbours before any
 * point is classified, so a cell that held a building contributes the
 * surrounding bare earth instead of the roof-minus-window height.
 *
 * The difference is not cosmetic. Under `'cut-surface'` a cell on curved ground
 * accumulates one drop per radius, so a scene whose ground genuinely falls away
 * over 16 cells is cut as though it held structure. See
 * `tests/groundFilterPdalAgreement.test.ts` for the measured size of that.
 */
export type GroundOpeningMode = 'cut-surface' | 'object-mask';

/**
 * Shape of the flat structuring element the progressive opening uses.
 *
 * `'square'` (default) — the 8-connected box OpenLiDARViewer has always used. It
 * is separable, so a radius-`b` pass costs two 1-D sweeps.
 *
 * `'diamond'` — the 4-connected L1 element PDAL's `filters.smrf` uses
 * (`erodeDiamond` / `dilateDiamond`). A radius-`b` diamond covers
 * `2b² + 2b + 1` cells against the box's `(2b + 1)²`, so a gross below-ground
 * blunder propagates through the erosion ladder far more slowly. On a scene
 * carrying such blunders the box lets a handful of pits swallow the whole grid
 * by the time the ladder reaches radius 16; the diamond does not.
 *
 * Both are decomposable, so eroding by radius 1 `b` times equals eroding by
 * radius `b` for either shape, which is what makes the progressive ladder exact
 * rather than an approximation.
 */
export type GroundStructuringElement = 'square' | 'diamond';

/** Tunable parameters for {@link classifyGroundSmrf}. */
export interface GroundFilterParams {
  /** Grid cell size, in source linear units. Must be > 0. */
  readonly cellSizeM: number;
  /**
   * Maximum morphological window radius, in cells. The filter opens the
   * surface with radii `1..maxWindowCells`. Larger removes larger
   * above-ground structures (buildings) at the cost of work. Must be
   * >= 1.
   */
  readonly maxWindowCells: number;
  /**
   * Expected maximum terrain slope as rise/run (e.g. 0.15 = 15 %). Sets
   * how aggressively the slope-scaled threshold grows with window size.
   * Must be >= 0.
   */
  readonly slope: number;
  /**
   * Base elevation tolerance, in source linear units. A return within
   * this height of the opened surface is ground even on flat terrain.
   * Must be >= 0.
   */
  readonly elevationThresholdM: number;
  /**
   * Optional additional tolerance scaled by the local ground-surface
   * slope (steeper ground => looser tolerance, since real ground varies
   * more there). Defaults to 0 (flat tolerance). In source linear units.
   */
  readonly scalingFactorM?: number;
  /**
   * Grid cell size expressed in the unit of the VERTICAL axis, for the
   * slope-scaled threshold growth. That growth multiplies a rise/run slope by
   * a horizontal run (`slope · b · cellSize`) and compares the product against
   * Δz, so the run must share z's unit: in a geographic frame the horizontal
   * cell is in DEGREES while z is metric, and the raw degree value starves the
   * growth term by ~1/111,320 — the threshold never rises above its base and
   * legitimate slope ground is rejected. Defaults to `cellSizeM` (projected
   * frames, where the horizontal and vertical units agree).
   */
  readonly cellSizeZUnits?: number;
  /**
   * Hard cap on the slope-scaled elevation threshold, source linear units.
   * Classic SMRF caps the threshold so a large window on steep ground cannot
   * grow the tolerance high enough to swallow low buildings, vehicles or
   * walls as "ground". Default 2.5 m. Set Infinity to disable the cap.
   */
  readonly maxElevationThresholdM?: number;
  /**
   * Despike floor: instead of the strict per-cell minimum, take the
   * elevation at this low percentile (0..50) of the cell's returns. This
   * rejects gross below-ground blunders (multipath, water, sensor noise)
   * that would otherwise seed a false low ground surface. `0` (default)
   * keeps the strict minimum.
   *
   * GUARANTEE (v0.4.3 audit fix): any value > 0 excludes AT LEAST the single
   * lowest return once a cell has ≥ 3 returns. The bare nearest-rank formula
   * alone made small percentiles a silent no-op — `ceil(0.05·n)−1 = 0` for
   * every n ≤ 20, i.e. essentially always at auto cell sizing — so the
   * documented despike never actually ran. Cells with 1–2 returns keep the
   * minimum (there is no evidence to call either return a blunder).
   */
  readonly floorPercentile?: number;
  /** Vertical axis of the source frame. Defaults to `'z'`. */
  readonly verticalAxis?: VerticalAxis;
  /**
   * Which progressive-opening rule to run. Defaults to `'cut-surface'`, the
   * behaviour every committed terrain product was measured under. See
   * {@link GroundOpeningMode}.
   */
  readonly openingMode?: GroundOpeningMode;
  /**
   * Structuring-element shape for the opening. Defaults to `'square'`, the
   * shape every committed terrain product was measured under. See
   * {@link GroundStructuringElement}.
   */
  readonly structuringElement?: GroundStructuringElement;
}

/** Result of {@link classifyGroundSmrf}. */
export interface GroundFilterResult {
  /**
   * Per-point ground flag, parallel to the input array. `1` = ground,
   * `0` = above-ground / not-ground. Length === input length.
   */
  readonly isGround: Uint8Array;
  /**
   * Provisional bare-earth surface, row-major (`row * cols + col`).
   * Heights are in source linear units. Never NaN after inpaint, but a
   * cell that received no source point is flagged in {@link hadData}.
   */
  readonly groundSurface: Float32Array;
  /** `1` where the cell held at least one source point, else `0`. */
  readonly hadData: Uint8Array;
  /**
   * `1` where the progressive opening judged the cell to hold an above-ground
   * object, else `0`. Row-major like {@link groundSurface}.
   *
   * Both opening modes report it, so the two are directly comparable: under
   * `'object-mask'` it is the mask the ladder accumulated, and under
   * `'cut-surface'` it is the set of cells the ladder wrote down. All zeroes on
   * the trusted-classification path, which runs no opening.
   */
  readonly objectCells: Uint8Array;
  /** How many cells {@link objectCells} marks. */
  readonly objectCellCount: number;
  /** Grid width in cells. */
  readonly cols: number;
  /** Grid height in cells. */
  readonly rows: number;
  /** Cell size used (echoes the param). */
  readonly cellSizeM: number;
  /** Horizontal origin (minimum of the first horizontal axis). */
  readonly originH1: number;
  /** Horizontal origin (minimum of the second horizontal axis). */
  readonly originH2: number;
  // ── honesty contract ──────────────────────────────────────────────
  readonly coverage: TerrainCoverageMode;
  readonly sourcePointCount: number;
  readonly analyzedPointCount: number;
  /** How many returns were classified as ground. */
  readonly groundPointCount: number;
  /** Ordered, human-readable caveats. */
  readonly warnings: string[];
}

/** Extract the (horizontal-1, horizontal-2, vertical) triplet for a point. */
function axes(
  p: TerrainPoint,
  vertical: VerticalAxis,
): readonly [number, number, number] {
  // Z-up (default): horizontals are x,y; vertical is z.
  // Y-up: horizontals are x,z; vertical is y.
  return vertical === 'y' ? [p.x, p.z, p.y] : [p.x, p.y, p.z];
}

/**
 * Classify ground vs above-ground returns with a Simple Morphological
 * Filter. Deterministic: identical input + params always yields an
 * identical result.
 *
 * Degenerate inputs are handled honestly rather than thrown:
 *   - empty input → empty result with a warning;
 *   - all points coincident / zero horizontal extent → single-cell grid;
 *   - non-finite params → clamped with a warning.
 */
export function classifyGroundSmrf(
  points: ReadonlyArray<TerrainPoint>,
  params: GroundFilterParams,
): GroundFilterResult {
  const warnings: string[] = [];
  const vertical: VerticalAxis = params.verticalAxis ?? 'z';

  const cellSizeM = finitePositive(params.cellSizeM, 1, 'cellSizeM', warnings);
  // The cell run the slope-scaled threshold grows by, in z's unit (see the
  // param doc) — identical to cellSizeM whenever horizontal and vertical
  // units agree, so projected frames are untouched.
  const cellSizeZUnits = finitePositive(
    params.cellSizeZUnits ?? cellSizeM,
    cellSizeM,
    'cellSizeZUnits',
    warnings,
  );
  const maxWindowCells = Math.max(
    1,
    Math.floor(finitePositive(params.maxWindowCells, 1, 'maxWindowCells', warnings)),
  );
  const slope = finiteNonNeg(params.slope, 0.15, 'slope', warnings);
  const elevationThresholdM = finiteNonNeg(
    params.elevationThresholdM,
    0.5,
    'elevationThresholdM',
    warnings,
  );
  const scalingFactorM = finiteNonNeg(params.scalingFactorM ?? 0, 0, 'scalingFactorM', warnings);
  // Cap the slope-scaled tolerance growth, but never below the base tolerance
  // — the cap limits how far slope can *inflate* the threshold, it must not
  // shrink a base tolerance the caller set deliberately.
  const maxElevationThresholdM = Math.max(
    elevationThresholdM,
    params.maxElevationThresholdM != null && params.maxElevationThresholdM > 0
      ? params.maxElevationThresholdM
      : 2.5,
  );
  let floorPercentile = params.floorPercentile ?? 0;
  if (!Number.isFinite(floorPercentile) || floorPercentile < 0) floorPercentile = 0;
  if (floorPercentile > 50) floorPercentile = 50;
  // An unrecognised mode falls back to the shipped one WITH a warning rather
  // than silently picking a rule the caller did not ask for.
  let openingMode: GroundOpeningMode = params.openingMode ?? 'cut-surface';
  if (openingMode !== 'cut-surface' && openingMode !== 'object-mask') {
    warnings.push(`openingMode invalid (${String(openingMode)}); using cut-surface`);
    openingMode = 'cut-surface';
  }
  let structuringElement: GroundStructuringElement = params.structuringElement ?? 'square';
  if (structuringElement !== 'square' && structuringElement !== 'diamond') {
    warnings.push(`structuringElement invalid (${String(structuringElement)}); using square`);
    structuringElement = 'square';
  }

  const sourcePointCount = points.length;
  if (sourcePointCount === 0) {
    warnings.push('no points — nothing to classify');
    return emptyResult(cellSizeM, warnings);
  }

  // ── 1. bounds (finite points only) ────────────────────────────────
  let minH1 = Infinity;
  let minH2 = Infinity;
  let maxH1 = -Infinity;
  let maxH2 = -Infinity;
  let analyzed = 0;
  for (const p of points) {
    const [h1, h2, v] = axes(p, vertical);
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    analyzed++;
    if (h1 < minH1) minH1 = h1;
    if (h2 < minH2) minH2 = h2;
    if (h1 > maxH1) maxH1 = h1;
    if (h2 > maxH2) maxH2 = h2;
  }
  if (analyzed === 0) {
    warnings.push('all points non-finite — nothing to classify');
    return emptyResult(cellSizeM, warnings);
  }
  if (analyzed < sourcePointCount) {
    warnings.push(`${sourcePointCount - analyzed} non-finite points skipped`);
  }

  const cols = Math.max(1, Math.floor((maxH1 - minH1) / cellSizeM) + 1);
  const rows = Math.max(1, Math.floor((maxH2 - minH2) / cellSizeM) + 1);
  const nCells = cols * rows;

  const cellOf = (h1: number, h2: number): number => {
    let col = Math.floor((h1 - minH1) / cellSizeM);
    let row = Math.floor((h2 - minH2) / cellSizeM);
    if (col < 0) col = 0;
    else if (col >= cols) col = cols - 1;
    if (row < 0) row = 0;
    else if (row >= rows) row = rows - 1;
    return row * cols + col;
  };

  // ── 2. minimum-elevation grid (optionally despiked) ───────────────
  const minGrid = new Float32Array(nCells).fill(Number.NaN);
  const hadData = new Uint8Array(nCells);
  if (floorPercentile <= 0) {
    // Fast path: strict per-cell minimum.
    for (const p of points) {
      const [h1, h2, v] = axes(p, vertical);
      if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
      const c = cellOf(h1, h2);
      if (hadData[c] === 0 || v < minGrid[c]) minGrid[c] = v;
      hadData[c] = 1;
    }
  } else {
    // Despike path: take the low-percentile return per cell so a single
    // gross below-ground blunder cannot seed the surface.
    const buckets = new Map<number, number[]>();
    for (const p of points) {
      const [h1, h2, v] = axes(p, vertical);
      if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
      const c = cellOf(h1, h2);
      const arr = buckets.get(c);
      if (arr) arr.push(v);
      else buckets.set(c, [v]);
      hadData[c] = 1;
    }
    const q = floorPercentile / 100;
    for (const [c, arr] of buckets) {
      arr.sort((a, b) => a - b);
      // Nearest-rank index, with the documented despike FLOOR: once a cell
      // has ≥ 3 returns, skip at least the single lowest one. Without the
      // floor, ceil(q·n)−1 is 0 for n ≤ ceil(1/q)·… (n ≤ 20 at q = 0.05),
      // so the despike the pipeline enables by default never fired — the
      // strict minimum (and any blunder) still won (v0.4.3 audit finding).
      const rankIdx = Math.ceil(q * arr.length) - 1;
      const minSkip = arr.length >= 3 ? 1 : 0;
      const idx = Math.min(arr.length - 1, Math.max(rankIdx, minSkip));
      minGrid[c] = arr[idx];
    }
  }

  // ── 3. inpaint empty cells (nearest-finite flood fill) ────────────
  const surface = inpaintNearest(minGrid, hadData, cols, rows);

  // ── 4. progressive morphological opening ──────────────────────────
  // The threshold at radius `b`, shared by both modes. Capped so a large window
  // on steep ground can't grow the tolerance high enough to admit low objects
  // (SMRF hard cap). The growth term takes the z-unit cell run: slope · run
  // compares against a Δz, so a degree-valued run would pin dh at the base.
  const thresholdAt = (b: number): number =>
    Math.min(maxElevationThresholdM, elevationThresholdM + slope * b * cellSizeZUnits);

  const objectCells = new Uint8Array(nCells);
  let groundSurface: Float32Array;

  if (openingMode === 'object-mask') {
    // Published SMRF. The surface is never written down, so the drop a cell can
    // show at radius `b` is the drop from radius `b - 1`'s opening and not the
    // sum of every drop the ladder has taken so far. `prevSurface` starts at the
    // minimum-elevation surface and advances to each opening in turn.
    //
    // The erosion is progressive: radius `b`'s erosion is radius `b - 1`'s
    // eroded one more cell. A flat square structuring element decomposes, so
    // eroding by radius 1 `b` times is exactly eroding the ORIGINAL surface by
    // radius `b` — which is the point, since the original is what stays intact.
    let prevSurface = surface;
    let erosion = surface;
    for (let b = 1; b <= maxWindowCells; b++) {
      erosion = erodeBy(erosion, cols, rows, 1, structuringElement);
      const opened = dilateBy(erosion, cols, rows, b, structuringElement);
      const dh = thresholdAt(b);
      for (let i = 0; i < nCells; i++) {
        if (prevSurface[i] - opened[i] > dh) objectCells[i] = 1;
      }
      prevSurface = opened;
    }
    // Object cells hold a height nobody surveyed as bare earth, so they are
    // dropped and refilled from the nearest cell the mask left standing rather
    // than kept at their opened value. `inpaintNearest` is the same
    // nearest-finite flood fill step 3 uses for cells that held no return; the
    // published filter's `knnfill` differs in interpolating from k neighbours,
    // which is an accuracy refinement over the same idea.
    let objectFree = 0;
    const keep = new Uint8Array(nCells);
    for (let i = 0; i < nCells; i++) {
      if (objectCells[i] === 0) {
        keep[i] = 1;
        objectFree++;
      }
    }
    if (objectFree === 0) {
      // Every cell marked. There is no bare earth left to interpolate FROM, and
      // a flood fill would return zeros, so the surface is left as measured and
      // the caller is told the scene carried no unmarked cell.
      warnings.push('progressive opening marked every cell as object; ground surface left un-interpolated');
      groundSurface = surface.slice();
    } else {
      groundSurface = inpaintNearest(surface, keep, cols, rows);
    }
  } else {
    // Original behaviour. Work surface is mutated each window radius; a cell is
    // cut down to the opened height when the drop exceeds the threshold, and
    // radius b + 1 then opens the surface radius b already lowered.
    const work = surface.slice();
    for (let b = 1; b <= maxWindowCells; b++) {
      const opened = morphOpen(work, cols, rows, b, structuringElement);
      const dh = thresholdAt(b);
      for (let i = 0; i < nCells; i++) {
        if (work[i] - opened[i] > dh) {
          work[i] = opened[i];
          objectCells[i] = 1;
        }
      }
    }
    groundSurface = work;
  }

  let objectCellCount = 0;
  for (let i = 0; i < nCells; i++) objectCellCount += objectCells[i];

  // ── 5. classify points against the opened surface ─────────────────
  const slopeGrid = surfaceSlope(groundSurface, cols, rows, cellSizeZUnits);
  const isGround = new Uint8Array(sourcePointCount);
  let groundPointCount = 0;
  for (let pi = 0; pi < sourcePointCount; pi++) {
    const [h1, h2, v] = axes(points[pi], vertical);
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    const c = cellOf(h1, h2);
    const tol = Math.min(
      maxElevationThresholdM,
      elevationThresholdM + scalingFactorM * slopeGrid[c],
    );
    // Ground when the return is at or below the opened surface within
    // tolerance. Returns well ABOVE the surface (buildings, canopy) are
    // not ground; returns slightly below (the surface itself) are.
    if (v - groundSurface[c] <= tol) {
      isGround[pi] = 1;
      groundPointCount++;
    }
  }

  return {
    isGround,
    groundSurface,
    hadData,
    objectCells,
    objectCellCount,
    cols,
    rows,
    cellSizeM,
    originH1: minH1,
    originH2: minH2,
    coverage: 'full' as TerrainCoverageMode,
    sourcePointCount,
    analyzedPointCount: analyzed,
    groundPointCount,
    warnings,
  };
}

/**
 * Build a {@link GroundFilterResult} that TRUSTS an authoritative ground
 * classification instead of re-deriving one with SMRF. Every finite point in
 * `points` is treated as ground (the caller has already selected the ASPRS
 * class-2 subset), so `isGround` is all-ones over the finite returns and the
 * DTM rasterised from it is a measured cell wherever a ground return exists —
 * SMRF's progressive opening can no longer discard steep-slope ground it
 * mistook for structure.
 *
 * The grid geometry (origin / cols / rows) and the provisional `groundSurface`
 * (min-elevation grid + nearest-finite inpaint) are computed EXACTLY as
 * {@link classifyGroundSmrf} would, so this result is a drop-in substitute for
 * the SMRF one; only the classification decision differs. The morphological
 * opening and slope-scaled point test are skipped — that is the whole point.
 *
 * Deterministic. Degenerate inputs (empty / all non-finite) return the same
 * honest empty result the SMRF path does.
 */
export function groundFromTrustedClassification(
  points: ReadonlyArray<TerrainPoint>,
  params: { readonly cellSizeM: number; readonly verticalAxis?: VerticalAxis },
): GroundFilterResult {
  const warnings: string[] = [];
  const vertical: VerticalAxis = params.verticalAxis ?? 'z';
  const cellSizeM = finitePositive(params.cellSizeM, 1, 'cellSizeM', warnings);

  const sourcePointCount = points.length;
  if (sourcePointCount === 0) {
    warnings.push('no points — nothing to classify');
    return emptyResult(cellSizeM, warnings);
  }

  // Bounds over the finite returns (identical rule to classifyGroundSmrf).
  let minH1 = Infinity;
  let minH2 = Infinity;
  let maxH1 = -Infinity;
  let maxH2 = -Infinity;
  let analyzed = 0;
  for (const p of points) {
    const [h1, h2, v] = axes(p, vertical);
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    analyzed++;
    if (h1 < minH1) minH1 = h1;
    if (h2 < minH2) minH2 = h2;
    if (h1 > maxH1) maxH1 = h1;
    if (h2 > maxH2) maxH2 = h2;
  }
  if (analyzed === 0) {
    warnings.push('all points non-finite — nothing to classify');
    return emptyResult(cellSizeM, warnings);
  }
  if (analyzed < sourcePointCount) {
    warnings.push(`${sourcePointCount - analyzed} non-finite points skipped`);
  }

  const cols = Math.max(1, Math.floor((maxH1 - minH1) / cellSizeM) + 1);
  const rows = Math.max(1, Math.floor((maxH2 - minH2) / cellSizeM) + 1);
  const nCells = cols * rows;

  const cellOf = (h1: number, h2: number): number => {
    let col = Math.floor((h1 - minH1) / cellSizeM);
    let row = Math.floor((h2 - minH2) / cellSizeM);
    if (col < 0) col = 0;
    else if (col >= cols) col = cols - 1;
    if (row < 0) row = 0;
    else if (row >= rows) row = rows - 1;
    return row * cols + col;
  };

  // Minimum-elevation grid + provisional surface, so the returned result
  // carries a valid bare-earth surface like the SMRF path (used for provenance,
  // never for the delivered DTM, which rasterizeDtm builds from the points).
  const minGrid = new Float32Array(nCells).fill(Number.NaN);
  const hadData = new Uint8Array(nCells);
  const isGround = new Uint8Array(sourcePointCount);
  let groundPointCount = 0;
  for (let pi = 0; pi < sourcePointCount; pi++) {
    const [h1, h2, v] = axes(points[pi], vertical);
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    // Every finite classified-ground return is ground — no morphological test.
    isGround[pi] = 1;
    groundPointCount++;
    const c = cellOf(h1, h2);
    if (hadData[c] === 0 || v < minGrid[c]) minGrid[c] = v;
    hadData[c] = 1;
  }
  const groundSurface = inpaintNearest(minGrid, hadData, cols, rows);

  return {
    isGround,
    groundSurface,
    hadData,
    // No opening runs on this path, so no cell is judged to hold an object.
    objectCells: new Uint8Array(nCells),
    objectCellCount: 0,
    cols,
    rows,
    cellSizeM,
    originH1: minH1,
    originH2: minH2,
    coverage: 'full' as TerrainCoverageMode,
    sourcePointCount,
    analyzedPointCount: analyzed,
    groundPointCount,
    warnings,
  };
}

// ── morphology helpers (exported for unit testing) ──────────────────

/**
 * Nearest-finite flood fill. Empty cells (`hadData[i] === 0`) receive
 * the value of the nearest cell that had data, by multi-source BFS over
 * 8-connectivity. Deterministic: BFS frontier is processed in index
 * order so ties resolve identically every run. If NO cell has data the
 * input is returned with zeros (caller already guarded against this).
 */
export function inpaintNearest(
  grid: Float32Array,
  hadData: Uint8Array,
  cols: number,
  rows: number,
): Float32Array {
  const n = cols * rows;
  const out = grid.slice();
  let frontier: number[] = [];
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (hadData[i] === 1) {
      filled[i] = 1;
      frontier.push(i);
    }
  }
  if (frontier.length === 0) return out.fill(0);
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      const col = i % cols;
      const row = (i - col) / cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
          const j = r * cols + c;
          if (filled[j] === 1) continue;
          filled[j] = 1;
          out[j] = out[i];
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Morphological opening (erosion then dilation) with a flat square
 * structuring element of radius `b` cells. The square SE is separable,
 * so each pass is two 1-D windowed extrema. NaN values are ignored
 * (treated as absent) so the helper is safe on un-inpainted grids too.
 */
export function morphOpen(
  grid: Float32Array,
  cols: number,
  rows: number,
  b: number,
  se: GroundStructuringElement = 'square',
): Float32Array {
  const eroded = erodeBy(grid, cols, rows, b, se);
  return dilateBy(eroded, cols, rows, b, se);
}

/** Erosion by a flat radius-`b` element of the given shape. */
function erodeBy(
  grid: Float32Array,
  cols: number,
  rows: number,
  b: number,
  se: GroundStructuringElement,
): Float32Array {
  return se === 'diamond'
    ? diamondExtreme(grid, cols, rows, b, 'min')
    : windowExtreme(grid, cols, rows, b, 'min');
}

/** Dilation by a flat radius-`b` element of the given shape. */
function dilateBy(
  grid: Float32Array,
  cols: number,
  rows: number,
  b: number,
  se: GroundStructuringElement,
): Float32Array {
  return se === 'diamond'
    ? diamondExtreme(grid, cols, rows, b, 'max')
    : windowExtreme(grid, cols, rows, b, 'max');
}

/**
 * Radius-`b` L1 (diamond) min/max, applied as `b` radius-1 passes. The diamond
 * is decomposable, so the repeated pass IS the radius-`b` element and not an
 * approximation of it. There is no separable form, which is why this costs `b`
 * sweeps where the box costs two. NaN is ignored, matching
 * {@link windowExtreme}.
 */
function diamondExtreme(
  grid: Float32Array,
  cols: number,
  rows: number,
  b: number,
  mode: 'min' | 'max',
): Float32Array {
  const pick = mode === 'min' ? Math.min : Math.max;
  let cur = grid;
  for (let pass = 0; pass < b; pass++) {
    const next = new Float32Array(grid.length);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        let acc = cur[i];
        if (col > 0) acc = merge(acc, cur[i - 1], pick);
        if (col < cols - 1) acc = merge(acc, cur[i + 1], pick);
        if (row > 0) acc = merge(acc, cur[i - cols], pick);
        if (row < rows - 1) acc = merge(acc, cur[i + cols], pick);
        next[i] = acc;
      }
    }
    cur = next;
  }
  return cur;
}

/** Fold one neighbour into an accumulator, skipping non-finite values. */
function merge(acc: number, val: number, pick: (a: number, b: number) => number): number {
  if (!Number.isFinite(val)) return acc;
  return Number.isFinite(acc) ? pick(acc, val) : val;
}

/** Separable 1-D windowed min/max over a flat square radius-`b` window. */
function windowExtreme(
  grid: Float32Array,
  cols: number,
  rows: number,
  b: number,
  mode: 'min' | 'max',
): Float32Array {
  const pick = mode === 'min' ? Math.min : Math.max;
  const horizontal = new Float32Array(grid.length);
  // pass 1 — horizontal
  for (let row = 0; row < rows; row++) {
    const base = row * cols;
    for (let col = 0; col < cols; col++) {
      let acc = Number.NaN;
      const lo = Math.max(0, col - b);
      const hi = Math.min(cols - 1, col + b);
      for (let c = lo; c <= hi; c++) {
        const val = grid[base + c];
        if (!Number.isFinite(val)) continue;
        acc = Number.isNaN(acc) ? val : pick(acc, val);
      }
      horizontal[base + col] = acc;
    }
  }
  // pass 2 — vertical
  const out = new Float32Array(grid.length);
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      let acc = Number.NaN;
      const lo = Math.max(0, row - b);
      const hi = Math.min(rows - 1, row + b);
      for (let r = lo; r <= hi; r++) {
        const val = horizontal[r * cols + col];
        if (!Number.isFinite(val)) continue;
        acc = Number.isNaN(acc) ? val : pick(acc, val);
      }
      out[row * cols + col] = acc;
    }
  }
  return out;
}

/**
 * Per-cell ground-surface slope as rise/run, from the maximum absolute
 * height difference to the 4-connected neighbours divided by the cell
 * size. Used only to widen the point-classification tolerance on steep
 * ground — not a reported metric.
 */
export function surfaceSlope(
  surface: Float32Array,
  cols: number,
  rows: number,
  cellRunZUnits: number,
): Float32Array {
  // Slope must be dimensionless (rise/run). The rise is a Δz in the surface's
  // vertical unit, so the run must be the cell size expressed in that SAME unit
  // — `cellSizeZUnits`, not the metric cell size. On a metric frame the two
  // coincide; on foot-Z or geographic-XY they do not, and dividing a native Δz
  // by a metric run would tilt the slope the SMRF tolerance reacts to. This is
  // the same dimensional fix already applied to the morphological-opening
  // threshold and to despike / cellConfidence roughness.
  const out = new Float32Array(surface.length);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const z = surface[i];
      let maxDiff = 0;
      if (col > 0) maxDiff = Math.max(maxDiff, Math.abs(z - surface[i - 1]));
      if (col < cols - 1) maxDiff = Math.max(maxDiff, Math.abs(z - surface[i + 1]));
      if (row > 0) maxDiff = Math.max(maxDiff, Math.abs(z - surface[i - cols]));
      if (row < rows - 1) maxDiff = Math.max(maxDiff, Math.abs(z - surface[i + cols]));
      out[i] = cellRunZUnits > 0 ? maxDiff / cellRunZUnits : 0;
    }
  }
  return out;
}

// ── small guards ────────────────────────────────────────────────────

function emptyResult(cellSizeM: number, warnings: string[]): GroundFilterResult {
  return {
    isGround: new Uint8Array(0),
    groundSurface: new Float32Array(0),
    hadData: new Uint8Array(0),
    objectCells: new Uint8Array(0),
    objectCellCount: 0,
    cols: 0,
    rows: 0,
    cellSizeM,
    originH1: 0,
    originH2: 0,
    coverage: 'full',
    sourcePointCount: 0,
    analyzedPointCount: 0,
    groundPointCount: 0,
    warnings,
  };
}

function finitePositive(v: number, fallback: number, name: string, warnings: string[]): number {
  if (Number.isFinite(v) && v > 0) return v;
  warnings.push(`${name} invalid (${v}); using ${fallback}`);
  return fallback;
}

function finiteNonNeg(v: number, fallback: number, name: string, warnings: string[]): number {
  if (Number.isFinite(v) && v >= 0) return v;
  warnings.push(`${name} invalid (${v}); using ${fallback}`);
  return fallback;
}
