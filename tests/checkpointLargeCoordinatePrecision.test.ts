/**
 * checkpointLargeCoordinatePrecision.test.ts — a deterministic, CI-safe proof
 * that the independent-checkpoint harness MUST recentre a tile onto a local
 * origin before its coordinates enter the Float32 geometry buffers.
 *
 * The defect this guards against: USGS 3DEP tiles carry world UTM coordinates
 * (northings ~3.19M m over Houston, ~4.65M m over Rogue). Float32 ULP at those
 * magnitudes is ~0.25–0.5 m, so storing a raw world coordinate into the
 * Float32-backed decode buffer snaps it to a sub-metre grid and destroys the
 * centimetric/decimetric residual signal a 0.10 m vertical-accuracy study is
 * built to measure. The production loader (`src/io/loadLas.ts`) never lets that
 * happen: it derives a per-cloud integer origin with `computeOrigin(header.min)`
 * and subtracts it in Float64 before the f32 downcast.
 *
 * Method. A dense synthetic Class-2 ground plane is built at realistic world
 * magnitudes and pushed through two decode variants of the SAME DTM builder:
 *   - 'ideal'     — recentred, stored in Float64 (the numerical ground truth).
 *   - 'recentred' — recentred, stored in Float32 (production).
 * Reference checkpoint elevations are defined as the ideal sample minus a known
 * injected Δz, so any rasteriser sampling bias is shared by both variants and
 * cancels out of the residual, leaving only the Float32 quantisation on view.
 * A separate storage-invariant test proves the [0,0,0] naive path is prohibited:
 * a realistic fractional coordinate cannot survive Float32 at these magnitudes
 * unless it is recentred onto the integer origin first.
 *
 * No external files, no env gate: the point set is constructed in the test.
 */
import { describe, it, expect } from 'vitest';
import { computeOrigin } from '../src/io/coordinateBridge';
import { DtmSurfaceModel } from '../src/terrain/validate/dtmSurfaceModel';

// A sloped ground plane at real world UTM magnitudes. The slope is what turns a
// horizontal (XY) Float32 snap into a vertical height error — exactly how the
// naive path corrupts a residual study.
const Z0 = 800; // base elevation, m (NAVD88-scale)
const SLOPE_X = 0.1; // 10 % cross-slope
const SLOPE_Y = 0.15; // 15 % down-slope
const CELL_SIZE_M = 1;
const PATCH_M = 40; // 40 m × 40 m patch
const STEP_M = 0.5; // dense ground returns, 0.5 m spacing

const trueHeight = (worldX: number, worldY: number, x0: number, y0: number): number =>
  Z0 + SLOPE_X * (worldX - x0) + SLOPE_Y * (worldY - y0);

// Known vertical differences injected at four interior checkpoints.
const INJECTED_DZ = [0.01, 0.03, 0.05, 0.1] as const;

type Mode = 'ideal' | 'recentred';

interface Site {
  readonly name: string;
  readonly e0: number; // world easting origin of the patch
  readonly n0: number; // world northing origin of the patch
}

const SITES: readonly Site[] = [
  { name: 'Houston', e0: 260_000, n0: 3_195_000 },
  { name: 'Rogue', e0: 460_000, n0: 4_650_000 },
];

const checkpointXY = (site: Site, k: number): [number, number] => [
  site.e0 + 8 + k * 6, // 8, 14, 20, 26 m into the patch
  site.n0 + 8 + k * 6,
];

/**
 * Build the DTM for one site under one decode mode and return the sampled DTM
 * height at each of the four checkpoint locations, expressed in the common
 * WORLD vertical frame (the model's local sample plus its vertical origin), so
 * the three modes are directly comparable and only the horizontal Float32 snap
 * — the documented defect — separates them.
 */
function sampleAt(site: Site, mode: Mode): number[] {
  const { e0, n0 } = site;

  const worldX: number[] = [];
  const worldY: number[] = [];
  const worldZ: number[] = [];
  for (let dx = 0; dx <= PATCH_M; dx += STEP_M) {
    for (let dy = 0; dy <= PATCH_M; dy += STEP_M) {
      const X = e0 + dx;
      const Y = n0 + dy;
      worldX.push(X);
      worldY.push(Y);
      worldZ.push(trueHeight(X, Y, e0, n0));
    }
  }

  const minX = Math.min(...worldX);
  const minY = Math.min(...worldY);
  const minZ = Math.min(...worldZ);
  const origin: [number, number, number] = computeOrigin([minX, minY, minZ]);

  // The decode buffer: Float32 for the two decode variants, Float64 for the
  // ideal reference. The world→local subtraction is always done in Float64
  // first (as `recenter()` does), narrowing to the buffer's type on assignment.
  const store: Float32Array | Float64Array =
    mode === 'ideal'
      ? new Float64Array(worldX.length * 3)
      : new Float32Array(worldX.length * 3);
  for (let i = 0; i < worldX.length; i++) {
    store[i * 3 + 0] = worldX[i] - origin[0];
    store[i * 3 + 1] = worldY[i] - origin[1];
    store[i * 3 + 2] = worldZ[i] - origin[2];
  }

  const trainPts: Array<{ x: number; y: number; z: number }> = [];
  let gMinX = Infinity;
  let gMaxX = -Infinity;
  let gMinY = Infinity;
  let gMaxY = -Infinity;
  for (let i = 0; i < worldX.length; i++) {
    const x = store[i * 3 + 0];
    const y = store[i * 3 + 1];
    const z = store[i * 3 + 2];
    trainPts.push({ x, y, z });
    if (x < gMinX) gMinX = x;
    if (x > gMaxX) gMaxX = x;
    if (y < gMinY) gMinY = y;
    if (y > gMaxY) gMaxY = y;
  }

  const grid = {
    originH1: gMinX,
    originH2: gMinY,
    cols: Math.max(1, Math.ceil((gMaxX - gMinX) / CELL_SIZE_M) + 1),
    rows: Math.max(1, Math.ceil((gMaxY - gMinY) / CELL_SIZE_M) + 1),
    cellSizeM: CELL_SIZE_M,
  };
  const model = new DtmSurfaceModel({
    grid,
    aggregation: 'median',
    despike: false,
    verticalUnitToMetres: 1,
  });
  model.fit(trainPts);

  const sampled: number[] = [];
  for (let k = 0; k < INJECTED_DZ.length; k++) {
    const [cx, cy] = checkpointXY(site, k);
    const z = model.predict(cx - origin[0], cy - origin[1]);
    expect(z).not.toBeNull();
    sampled.push((z as number) + origin[2]); // back to the world vertical frame
  }
  return sampled;
}

describe('checkpoint harness large-coordinate precision', () => {
  for (const site of SITES) {
    // The ideal (Float64) sample is the numerical ground truth; the injected
    // reference elevations hang off it, so the rasteriser's own slope-sampling
    // bias is common to every mode and drops out of the recovered Δz.
    const ideal = sampleAt(site, 'ideal');
    const references = INJECTED_DZ.map((dz, k) => ideal[k] - dz);

    it(`recentred (Float32) decode recovers injected Δz at ${site.name} magnitudes`, () => {
      const sampled = sampleAt(site, 'recentred');
      for (let k = 0; k < INJECTED_DZ.length; k++) {
        const recovered = sampled[k] - references[k];
        const err = Math.abs(recovered - INJECTED_DZ[k]);
        // eslint-disable-next-line no-console
        console.log(
          `[recentred ${site.name}] injected ${INJECTED_DZ[k]} m -> recovered ${recovered.toFixed(6)} m (err ${err.toExponential(2)} m)`,
        );
        expect(err).toBeLessThan(1e-3); // well under the 0.01 m signal floor
      }
    });

    it(`naive [0,0,0] storage cannot hold ${site.name} coordinates to the study's tolerance`, () => {
      // The invariant that PROHIBITS the naive path, proven at its root: a
      // realistic fractional survey coordinate (checkpoints and returns are not
      // on integer metres) cannot survive a Float32 round-trip at these world
      // magnitudes, but survives losslessly once recentred onto the integer
      // origin first — exactly what `computeOrigin` + Float64 subtraction do.
      const originN = computeOrigin([site.e0, site.n0, 0])[1];
      let worstNaive = 0;
      let worstRecentred = 0;
      for (let k = 0; k < INJECTED_DZ.length; k++) {
        const [, cy] = checkpointXY(site, k);
        const northing = cy + 0.37; // realistic sub-metre fractional part

        const naive = Math.fround(northing);
        const naiveErr = Math.abs(naive - northing);
        worstNaive = Math.max(worstNaive, naiveErr);

        const recentred = Math.fround(northing - originN) + originN;
        const recentredErr = Math.abs(recentred - northing);
        worstRecentred = Math.max(worstRecentred, recentredErr);

        // eslint-disable-next-line no-console
        console.log(
          `[storage ${site.name}] N=${northing.toFixed(2)}  naive f32 err ${naiveErr.toExponential(2)} m  recentred f32 err ${recentredErr.toExponential(2)} m`,
        );
      }
      // Naive storage loses more than the 0.01 m signal floor; recentred keeps
      // it to sub-millimetre. This is why the harness MUST recentre and why the
      // [0,0,0] origin is prohibited for a decimetric checkpoint study.
      expect(worstNaive).toBeGreaterThan(0.01);
      expect(worstRecentred).toBeLessThan(1e-3);
    });
  }
});
