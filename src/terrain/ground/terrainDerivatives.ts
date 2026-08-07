/**
 * terrainDerivatives.ts
 *
 * Pure-data leaf — first-order terrain derivatives (slope and
 * aspect) computed with Horn's 3x3 method, the same estimator ArcGIS and
 * GDAL use. It replaces the previous crude "largest absolute drop to a
 * 4-neighbour" slope, which was anisotropic (it over-reported slope along
 * the axes and under-reported it on the diagonals) and had no aspect.
 *
 * Horn (1981) fits a plane to the 3x3 neighbourhood with a weighted
 * central difference. GRID CONVENTION: our rasters are NORTHING-UP —
 * `rasterizeDtm` maps row = floor((y − origin) / cell), so row+1 is one
 * cell NORTH (unlike image rasters, where row+1 is south). Hence:
 *
 *   dz/dx = ((zE + 2·zE + zE) − (zW + 2·zW + zW)) / (8·cell)   [weighted]
 *   dz/dy = ((zN + 2·zN + zN) − (zS + 2·zS + zS)) / (8·cell)   [= +∂z/∂northing]
 *   slope = hypot(dz/dx, dz/dy)            (rise/run, dimensionless)
 *   aspect = atan2(−dz/dy, −dz/dx)         (radians, math frame, downslope)
 *
 * Aspect is the DOWNSLOPE direction −∇z = (−dz/dx, −dz/dy) expressed as a
 * math-frame angle (CCW from east; π/2 = north). Because dz/dy here is
 * +∂z/∂northing, BOTH components must be negated — the ESRI textbook form
 * atan2(dz/dy, −dz/dx) assumes image rows (row+1 = south) and mirrored our
 * aspect north–south (v0.4.3 bug: hillshade lit the wrong flank).
 *
 * The weighting (corners 1, edges 2) makes the estimate isotropic and
 * smooths single-cell noise — which is exactly what the confidence
 * roughness term and any future hillshade need.
 *
 * BORDER POLICY: linear extrapolation, matching `gdaldem -compute_edges`.
 * A neighbour one step outside the grid is synthesised as 2·a − b, where a is
 * the edge value and b its inward neighbour — on a locally planar surface that
 * reconstructs the true neighbour exactly. Through v0.6.3 we CLAMPED instead
 * (replicating the edge row/column), which left the rise across the window
 * unchanged while halving the run, so every border slope read roughly HALF its
 * true value: 9.9 deg on a 19.3 deg plane, a shortfall of up to 16 deg with an
 * always-negative bias over the 2·(cols+rows)−4 cells of the outer ring. The
 * raster agreement matrix measured it (tests/rasterAgreementMatrix.test.ts,
 * "border only" legs); interior cells were never affected.
 *
 * The policy is gdaldem's, INCLUDING its corner asymmetry, so the two
 * implementations agree cell-for-cell rather than approximately. gdaldem
 * extrapolates PERPENDICULAR to an edge and CLAMPS ALONG it: its first/last-line
 * branch synthesises the outside row but takes `jmin = j` at j = 0, so at the
 * four corners the along-edge gradient is still halved. That is deliberate here
 * — reproducing it buys exact agreement with the reference implementation on the
 * whole ring, at a cost of 4 cells per raster. Extrapolating symmetrically would
 * be the better estimator at those corners (it recovers the true planar
 * gradient) but would diverge from gdaldem by up to 12.7 deg there; interop won.
 * Extrapolation needs two cells along the axis, so a grid thinner than 2 in one
 * direction falls back to clamping on that axis.
 *
 * WHAT EXTRAPOLATION COSTS. It is a bias-variance trade, not a free win, and the
 * matrix fixtures cannot show that because they are all analytically smooth.
 * Substituting the virtual column into the Horn numerator gives an edge
 * dz/dx = (S1 − S0)/(4·cell) against an interior (S₊ − S₋)/(8·cell), where each
 * Sk is a 1-2-1 weighted column sum: the same numerator spread over half the
 * divisor, so Var(edge) = 4·Var(interior) — TWICE the noise SD. Clamping kept the
 * divisor at 8·cell and so kept the interior noise level, paying ~50% bias
 * instead. MSE crosses over near σ ≈ G·cell/1.5, so on near-flat noisy ground
 * (G ≈ 0.02, σ ≈ 5 cm) clamping was actually the lower-error estimator.
 *
 * Extrapolation is still the right default: the bias it removes is systematic and
 * directional — always low, at every terrain scale, which corrupts thresholds and
 * classifications — while the noise it adds is symmetric and averages out.
 * Measured in tests/terrainDerivatives.test.ts ("border bias-variance trade"),
 * including the near-flat case where this choice loses.
 *
 * Any non-finite neighbour falls back to the centre value, so the result is
 * finite wherever the centre cell is finite. gdaldem instead propagates nodata
 * out of the window; that divergence is a deliberate policy difference (we
 * answer for every cell) and is recorded as its own leg in the matrix. An
 * extrapolation whose operands are not both finite degrades to the clamped edge
 * value, then to the centre — so around missing data the behaviour is exactly
 * what it was before this policy changed. Deterministic. No DOM, no three.js,
 * no I/O.
 */

/** Slope (rise/run) and aspect (radians) per cell, row-major. */
export interface TerrainDerivatives {
  /** Slope as rise/run (dimensionless). 0 on flat ground. */
  readonly slope: Float32Array;
  /**
   * Aspect in radians — the DOWNSLOPE direction in the math frame (CCW from
   * east; π/2 = north), atan2(−dz/dy, −dz/dx) on the northing-up grid.
   * 0 where slope is ~0.
   */
  readonly aspect: Float32Array;
}

/**
 * Compute Horn slope + aspect over a row-major elevation grid. Cells
 * whose centre is non-finite yield slope 0 / aspect 0 (no surface to
 * differentiate). `cellMetresX` must be > 0; otherwise slope is 0 grid-wide.
 *
 * `cellMetresY` defaults to `cellMetresX` (square cells). Pass a distinct value
 * for an anisotropic grid — notably a geographic (lat/lon) raster, where a
 * square degree cell is NOT square in metres: 1° of longitude spans
 * `cos(latitude)` × the metres of 1° of latitude. Without separate east/west
 * (X) and north/south (Y) metres the east–west gradient is mis-scaled and
 * slope/aspect come out anisotropically wrong off the equator.
 */
export function hornSlopeAspect(
  z: Float32Array,
  cols: number,
  rows: number,
  cellMetresX: number,
  cellMetresY: number = cellMetresX,
  zScale = 1,
): TerrainDerivatives {
  const n = cols * rows;
  const slope = new Float32Array(n);
  const aspect = new Float32Array(n);
  if (n === 0 || !(cellMetresX > 0) || !(cellMetresY > 0)) return { slope, aspect };
  // Rise/run must share a unit. The cell sizes are metres, so the elevation
  // (rise) must be too: `zScale` = verticalUnitToMetres converts a native-unit
  // grid (e.g. a state-plane-FEET DTM) before the ratio. slope scales linearly
  // in the rise, so multiplying the final tangent by `zScale` is exact; aspect
  // is a direction and is invariant under a uniform positive scale, so it is
  // left untouched. zScale 1 (metric, or Z already in metres) is a no-op.
  const zs = Number.isFinite(zScale) && zScale > 0 ? zScale : 1;

  const clampR = (r: number): number => {
    if (r < 0) return 0;
    if (r >= rows) return rows - 1;
    return r;
  };
  const clampC = (c: number): number => {
    if (c < 0) return 0;
    if (c >= cols) return cols - 1;
    return c;
  };

  /** In-grid read (indices clamped), preserving a non-finite value. */
  const raw = (r: number, c: number): number => z[clampR(r) * cols + clampC(c)];

  /** In-grid read (indices clamped); a non-finite cell degrades to the centre. */
  const at = (r: number, c: number, fallback: number): number => {
    const v = raw(r, c);
    return Number.isFinite(v) ? v : fallback;
  };

  /**
   * The virtual cell one step outside the grid: 2·a − b, from the edge value a
   * and its inward neighbour b — both RAW, so a missing one is visible here
   * rather than already replaced by the centre. Degrades to a (the old clamp)
   * when b is missing and to the centre when a is too, so the field stays finite
   * wherever the centre is finite and missing-data behaviour is unchanged.
   * Extrapolating from a substituted centre value instead would let a hole throw
   * the border further than clamping did.
   */
  const virt = (a: number, b: number, centre: number): number => {
    if (!Number.isFinite(a)) return centre;
    return Number.isFinite(b) ? 2 * a - b : a;
  };

  // Scratch 3x3 window, slot (dr+1)*3 + (dc+1) — so [a b c / d e f / g h i2]
  // with dr = −1 the SOUTH row and dr = +1 the NORTH row (northing-up).
  const w = new Float64Array(9);

  /**
   * Fill `w` for cell (row, col) under gdaldem's `-compute_edges` policy:
   * extrapolate PERPENDICULAR to an edge, clamp ALONG it. The row-edge branch is
   * tested first, which is what puts the along-edge clamp at the four corners
   * (gdaldem's first/last-line branch does the same). An axis thinner than 2
   * cells cannot be extrapolated and stays clamped.
   */
  const fillWindow = (row: number, col: number, e: number): void => {
    if (rows >= 2 && (row === 0 || row === rows - 1)) {
      // Row edge: the outside row is synthesised from this row and the one
      // inward of it. Columns are CLAMPED, corners included.
      const inner = row === 0 ? 1 : rows - 2;
      const outward = row === 0 ? -1 : 1;
      for (let dc = -1; dc <= 1; dc++) {
        const cc = clampC(col + dc);
        w[(outward + 1) * 3 + (dc + 1)] = virt(raw(row, cc), raw(inner, cc), e);
        w[1 * 3 + (dc + 1)] = at(row, cc, e);
        w[(1 - outward) * 3 + (dc + 1)] = at(inner, cc, e);
      }
      return;
    }
    if (cols >= 2 && (col === 0 || col === cols - 1)) {
      // Column edge with real rows above and below (a row edge would have been
      // caught above). clampR keeps a 1-row grid safe.
      const inner = col === 0 ? 1 : cols - 2;
      const outward = col === 0 ? -1 : 1;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = clampR(row + dr);
        w[(dr + 1) * 3 + (outward + 1)] = virt(raw(rr, col), raw(rr, inner), e);
        w[(dr + 1) * 3 + 1] = at(rr, col, e);
        w[(dr + 1) * 3 + (1 - outward)] = at(rr, inner, e);
      }
      return;
    }
    // Interior — unchanged. clampR/clampC are no-ops here except on a grid too
    // thin for either branch to apply, where they reproduce the old clamp.
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) w[(dr + 1) * 3 + (dc + 1)] = at(row + dr, col + dc, e);
    }
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const e = z[i];
      if (!Number.isFinite(e)) {
        slope[i] = 0;
        aspect[i] = 0;
        continue;
      }
      // 3x3 neighbourhood (a b c / d e f / g h i2), border-extrapolated per the
      // header, NaN→centre.
      fillWindow(row, col, e);
      const a = w[0];
      const b = w[1];
      const c = w[2];
      const d = w[3];
      const f = w[5];
      const g = w[6];
      const h = w[7];
      const ii = w[8];

      // Northing-up grid: row+1 (g, h, ii) is NORTH, row−1 (a, b, c) is
      // south, so dzdy is +∂z/∂northing.
      const dzdx = (c + 2 * f + ii - (a + 2 * d + g)) / (8 * cellMetresX);
      const dzdy = (g + 2 * h + ii - (a + 2 * b + c)) / (8 * cellMetresY);
      slope[i] = Math.hypot(dzdx, dzdy) * zs;
      // Aspect = downslope direction −∇z in the math frame: negate BOTH
      // gradient components. atan2(+dzdy, −dzdx) (the image-row ESRI form)
      // mirrored aspect north–south on this northing-up grid.
      aspect[i] = dzdx === 0 && dzdy === 0 ? 0 : Math.atan2(-dzdy, -dzdx);
    }
  }
  return { slope, aspect };
}

/**
 * Cells whose Horn window drew on at least one value that was NOT measured at
 * that location — 1 = synthesised, 0 = every one of the nine came from the grid.
 *
 * Two distinct causes, deliberately folded into one flag because they have the
 * same consequence for a reader of the output:
 *
 *  - THE OUTER RING. A border window leaves the grid, so a neighbour is
 *    extrapolated (or, at a corner's along-edge axis, replicated). That value is
 *    an estimate; the cell's slope carries twice the interior noise, and on
 *    curved ground a real bias (see the header).
 *  - HOLE HALOS. Where a neighbour is non-finite we substitute the centre value
 *    and still answer, which biases the gradient toward zero. gdaldem instead
 *    propagates nodata out of the window and answers for nothing there.
 *
 * Neither is visible in the products themselves: a halved-looking slope and a
 * fully-supported one are the same float. The agreement matrix says so in as many
 * words — the nodata halo "carries no marker distinguishing those cells from
 * fully-supported ones" — and this is that marker. It is deliberately NOT part of
 * `CellStatus` (quality/dtmCellStatus.ts): that is a mutually-exclusive
 * precedence chain about data support, and "my window crossed the grid edge" is
 * orthogonal to it — a border cell can be perfectly well measured.
 *
 * A cell whose own centre is non-finite is NOT flagged: it has no derivative at
 * all (slope and aspect are 0 there), so there is nothing to qualify.
 *
 * Pure geometry plus finiteness — no cell sizes, no gradients. Deterministic.
 */
export function synthesisedNeighbourMask(
  z: Float32Array,
  cols: number,
  rows: number,
): Uint8Array {
  const mask = new Uint8Array(Math.max(0, cols * rows));
  if (cols <= 0 || rows <= 0) return mask;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (!Number.isFinite(z[i])) continue; // no derivative to qualify
      if (row === 0 || col === 0 || row === rows - 1 || col === cols - 1) {
        mask[i] = 1; // window leaves the grid
        continue;
      }
      for (let dr = -1; dr <= 1 && mask[i] === 0; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!Number.isFinite(z[(row + dr) * cols + (col + dc)])) {
            mask[i] = 1; // hole halo
            break;
          }
        }
      }
    }
  }
  return mask;
}

/** How many cells {@link synthesisedNeighbourMask} flags. */
export function countSynthesisedNeighbours(
  z: Float32Array,
  cols: number,
  rows: number,
): number {
  const mask = synthesisedNeighbourMask(z, cols, rows);
  let n = 0;
  for (const m of mask) n += m;
  return n;
}

/** Convenience: just the slope grid (rise/run). `cellMetresY` defaults to X. */
export function hornSlope(
  z: Float32Array,
  cols: number,
  rows: number,
  cellMetresX: number,
  cellMetresY: number = cellMetresX,
  zScale = 1,
): Float32Array {
  return hornSlopeAspect(z, cols, rows, cellMetresX, cellMetresY, zScale).slope;
}
