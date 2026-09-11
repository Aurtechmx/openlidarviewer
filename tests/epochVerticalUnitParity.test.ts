/**
 * epochVerticalUnitParity.test.ts — the epoch DTM builder scales Z by the
 * vertical unit, not just the horizontal one.
 *
 * `dtmOnGrid` computes `vertToMetres` and hands it to the ground-filter
 * thresholds, then called `buildSurfaceFromRaster` WITHOUT it. That function
 * feeds the factor to two consumers: `removeSpikes`, whose blunder floor is an
 * absolute 0.30 m, and the cell-confidence roughness term, which converts a
 * vertical rise to metres. With the factor missing both read raw source units,
 * so on a compound frame (metre horizontal, foot vertical) the 0.30 m floor
 * became 0.30 FEET, about 0.091 m, and removed real sub-30 cm relief that the
 * metre-framed twin kept.
 *
 * The test states it as a physical invariant rather than by inspecting the
 * call: one surface, described twice, must produce one DTM. If the vertical
 * factor is dropped again, the foot description despikes differently and the
 * two stop agreeing.
 */

import { describe, it, expect } from 'vitest';
import { buildSharedEpochDtms, type EpochCloud } from '../src/terrain/change/compareEpochs';

const M_PER_FT = 0.3048;

/**
 * A 40 x 40 m plane carrying a shallow 0.20 m step — deliberately BELOW the
 * 0.30 m blunder floor, so a correctly scaled despike keeps it and a despike
 * running on feet (floor ~0.091 m) is tempted to treat it as a spike.
 */
function site(zScale: number): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 40; x += 1) {
    for (let y = 0; y <= 40; y += 1) {
      const zMetres = 10 + (x > 20 ? 0.2 : 0) + ((x * 7 + y * 13) % 5) * 0.01;
      pts.push(x, y, zMetres / zScale);
    }
  }
  return new Float32Array(pts);
}

const metreEpoch = (): EpochCloud => ({
  positions: site(1),
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
  linearUnitToMetres: 1,
  verticalUnitToMetres: 1,
});

/** The identical site with Z in feet, and the frame saying so. */
const footVerticalEpoch = (): EpochCloud => ({
  positions: site(M_PER_FT),
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
  linearUnitToMetres: 1,
  verticalUnitToMetres: M_PER_FT,
});

/** The same site on a GEOGRAPHIC frame: degrees horizontally, Z declared. */
const geoEpoch = (zScale: number): EpochCloud => ({
  // 40 x 40 m expressed in degrees at the equator, so the shared grid is fine.
  positions: (() => {
    const src = site(zScale);
    const out = new Float32Array(src.length);
    const DEG = 1 / 111_320;
    for (let i = 0; i < src.length; i += 3) {
      out[i] = src[i] * DEG; out[i + 1] = src[i + 1] * DEG; out[i + 2] = src[i + 2];
    }
    return out;
  })(),
  crs: 'EPSG:4326',
  verticalDatum: 'EPSG:5703',
  isGeographic: true,
  verticalUnitToMetres: zScale,
});

describe('a geographic frame honours its declared vertical scale', () => {
  it('produces the same epoch surface from a metre-Z and a foot-Z description', () => {
    // dtmOnGrid forced the vertical factor to 1 on a geographic frame, so a
    // foot-vertical compound frame ran the SMRF thresholds and the despike
    // floor in feet while the Analyse panel converted them for the same scan.
    const inMetres = buildSharedEpochDtms(geoEpoch(1), geoEpoch(1));
    const inFeet = buildSharedEpochDtms(geoEpoch(M_PER_FT), geoEpoch(M_PER_FT));
    expect(inMetres).not.toBeNull();
    expect(inFeet).not.toBeNull();
    const m = (inMetres as NonNullable<typeof inMetres>).before;
    const f = (inFeet as NonNullable<typeof inFeet>).before;
    const measured = (g: { z: Float32Array }): number => [...g.z].filter((v) => Number.isFinite(v)).length;
    expect(measured(f), 'the foot description lost cells the metre description kept').toBe(measured(m));
    let maxDelta = 0;
    for (let i = 0; i < m.z.length; i++) {
      if (!Number.isFinite(m.z[i]) || !Number.isFinite(f.z[i])) continue;
      maxDelta = Math.max(maxDelta, Math.abs(m.z[i] - f.z[i] * M_PER_FT));
    }
    expect(maxDelta).toBeLessThan(1e-3);
    // Four full ground-filter + DTM builds. Comfortably inside the default
    // timeout on its own, and past it under v8 coverage instrumentation, which
    // is where CI runs it: the assertions were never the failure, the clock
    // was.
  }, 120_000);
});

describe('the epoch DTM is invariant to how the vertical unit is described', () => {
  it('produces the same surface from a metre-Z and a foot-Z description of one site', () => {
    const inMetres = buildSharedEpochDtms(metreEpoch(), metreEpoch());
    const inFeet = buildSharedEpochDtms(footVerticalEpoch(), footVerticalEpoch());
    expect(inMetres).not.toBeNull();
    expect(inFeet).not.toBeNull();

    const m = (inMetres as NonNullable<typeof inMetres>).before;
    const f = (inFeet as NonNullable<typeof inFeet>).before;
    expect(f.cols).toBe(m.cols);
    expect(f.rows).toBe(m.rows);

    // Cell coverage is the despike-sensitive part: a floor that is 3.3 times
    // too small removes cells the metre run keeps.
    const measured = (g: { z: Float32Array }): number =>
      [...g.z].filter((v) => Number.isFinite(v)).length;
    expect(measured(f), 'the foot description lost cells the metre description kept')
      .toBe(measured(m));

    // And the retained heights agree once converted back, so the surface is the
    // same surface and not merely the same shape.
    let maxDelta = 0;
    for (let i = 0; i < m.z.length; i++) {
      if (!Number.isFinite(m.z[i]) || !Number.isFinite(f.z[i])) continue;
      maxDelta = Math.max(maxDelta, Math.abs(m.z[i] - f.z[i] * M_PER_FT));
    }
    expect(maxDelta, 'heights disagree beyond float32 tolerance').toBeLessThan(1e-3);
    // See the sibling above: four ground-filter + DTM builds, timed out under
    // coverage instrumentation rather than failing an assertion.
  }, 120_000);
});
