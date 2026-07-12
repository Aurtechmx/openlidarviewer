import {
  colorForMode,
  availableModes,
  defaultMode,
  colorByScalar,
  colorByElevation,
  colorByIntensity,
  DEFAULT_ELEVATION_PALETTE,
  DEFAULT_SCALAR_PALETTE,
} from '../src/render/colorModes';
import { PointCloud } from '../src/model/PointCloud';
import {
  COVERAGE_STRONG,
  COVERAGE_MODERATE,
  COVERAGE_WEAK,
  COVERAGE_NONE,
} from '../src/terrain/surface/coverageHeatmap';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Cloud with all attributes, Z values 0,1,2,3 (monotonically increasing). */
function makeFullCloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([
      0, 0, 0,   // Z=0 — lowest
      1, 0, 1,   // Z=1
      2, 0, 2,   // Z=2
      3, 0, 3,   // Z=3 — highest
    ]),
    colors: new Uint8Array([
      255,   0,   0,   // red
        0, 255,   0,   // green
        0,   0, 255,   // blue
      128, 128, 128,   // grey
    ]),
    intensity: new Uint16Array([0, 100, 200, 300]),
    classification: new Uint8Array([2, 3, 5, 6]),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'full.las',
  });
}

/** Cloud with only positions (no optional attributes). */
function makePositionsOnlyCloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 10, 1, 0, 20, 2, 0, 30]),
    origin: [0, 0, 0],
    sourceFormat: 'obj',
    name: 'bare.obj',
  });
}

/** Cloud carrying per-point normals — three axis-aligned unit vectors. */
function makeNormalsCloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    normals: new Float32Array([
      1, 0, 0, // +X
      0, 1, 0, // +Y
      0, 0, 1, // +Z
    ]),
    origin: [0, 0, 0],
    sourceFormat: 'e57',
    name: 'normals.e57',
  });
}

// ────────────────────────────────────────────────────────────────────────────
// colorForMode — rgb
// ────────────────────────────────────────────────────────────────────────────

describe('colorForMode — rgb', () => {
  test('returns the cloud own colors byte-for-byte', () => {
    const cloud = makeFullCloud();
    const result = colorForMode('rgb', cloud);
    expect(result).toEqual(cloud.colors!);
  });

  test('throws when colors are absent', () => {
    const cloud = makePositionsOnlyCloud();
    expect(() => colorForMode('rgb', cloud)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorForMode — intensity
// ────────────────────────────────────────────────────────────────────────────

describe('colorForMode — intensity', () => {
  test('returns a Uint8Array with 3 bytes per point', () => {
    const cloud = makeFullCloud();
    const result = colorForMode('intensity', cloud);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(cloud.pointCount * 3);
  });

  test('maps min intensity to 0 and max to 255 (greyscale)', () => {
    const cloud = makeFullCloud(); // intensity: [0, 100, 200, 300]
    const result = colorForMode('intensity', cloud);
    // Point 0 (intensity 0 — min) should be R=G=B=0
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
    // Point 3 (intensity 300 — max) should be R=G=B=255
    expect(result[9]).toBe(255);
    expect(result[10]).toBe(255);
    expect(result[11]).toBe(255);
  });

  test('intermediate intensity maps to a grey between 0 and 255', () => {
    const cloud = makeFullCloud(); // intensity 100 out of 300 → ~85
    const result = colorForMode('intensity', cloud);
    const grey1 = result[3]; // R of point 1
    expect(grey1).toBeGreaterThan(0);
    expect(grey1).toBeLessThan(255);
    // R=G=B (greyscale)
    expect(result[3]).toBe(result[4]);
    expect(result[4]).toBe(result[5]);
  });

  test('throws when intensity is absent', () => {
    const cloud = makePositionsOnlyCloud();
    expect(() => colorForMode('intensity', cloud)).toThrow();
  });

  test('uniform intensity does not throw (all values identical)', () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      intensity: new Uint16Array([500, 500]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'uniform.las',
    });
    expect(() => colorForMode('intensity', cloud)).not.toThrow();
    const result = colorForMode('intensity', cloud);
    // When min===max the output should be a constant (0 or 255 are both fine)
    expect(result[0]).toBe(result[3]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorForMode — elevation
// ────────────────────────────────────────────────────────────────────────────

describe('colorForMode — elevation', () => {
  test('returns a Uint8Array with 3 bytes per point', () => {
    const cloud = makeFullCloud();
    const result = colorForMode('elevation', cloud);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(cloud.pointCount * 3);
  });

  test('higher Z points map to a higher position on the colour ramp', () => {
    // Z values: 0, 1, 2, 3 — each successive point should map to a strictly
    // higher `t` on the ramp.  We verify this by checking that all four
    // output colours are distinct AND that the red channel (which rises from
    // 0 at the blue end to 255 at the red end) is strictly non-decreasing
    // between the first (coldest) and last (hottest) points.
    const cloud = makeFullCloud();  // Z = 0, 1, 2, 3
    const result = colorForMode('elevation', cloud);

    const red = (i: number) => result[i * 3];

    // The ramp goes blue (r=0) → … → red (r=255):
    // red channel is non-decreasing from coldest to hottest point overall.
    expect(red(3)).toBeGreaterThanOrEqual(red(0));

    // The four Z values are distinct, so the four output colours must be distinct.
    const colourOf = (i: number) =>
      `${result[i*3]},${result[i*3+1]},${result[i*3+2]}`;
    const unique = new Set([colourOf(0), colourOf(1), colourOf(2), colourOf(3)]);
    expect(unique.size).toBe(4);
  });

  test('lowest Z point is the cool end of the ramp (blue-dominant)', () => {
    const cloud = makeFullCloud(); // Z=0 is lowest
    const result = colorForMode('elevation', cloud);
    const r = result[0];
    const b = result[2];
    // At the cold end blue should dominate
    expect(b).toBeGreaterThan(r);
  });

  test('highest Z point is the hot end of the ramp (red-dominant)', () => {
    const cloud = makeFullCloud(); // Z=3 is highest
    const result = colorForMode('elevation', cloud);
    const r = result[9];
    const b = result[11];
    // At the hot end red should dominate
    expect(r).toBeGreaterThan(b);
  });

  test('works on positions-only cloud (elevation always available)', () => {
    const cloud = makePositionsOnlyCloud(); // Z: 10, 20, 30
    expect(() => colorForMode('elevation', cloud)).not.toThrow();
    const result = colorForMode('elevation', cloud);
    expect(result.length).toBe(3 * 3);
  });

  test('single-point cloud does not throw', () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 5]),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'one.ply',
    });
    expect(() => colorForMode('elevation', cloud)).not.toThrow();
  });

  test('upAxis=1 colours a Y-up scan by Y, not Z', () => {
    // Y rises 0→3; Z held constant. With upAxis=1 (Y-up phone scan) height is
    // Y, so the four points get four distinct ramp colours. With the default
    // Z-up the constant-Z cloud collapses to a single colour — proving the bug
    // (a Y-up scan coloured along a flat axis) and the fix.
    const positions = new Float32Array([0, 0, 9, 1, 1, 9, 2, 2, 9, 3, 3, 9]);
    const cloud = new PointCloud({
      positions,
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'yup.ply',
    });
    const colourOf = (arr: Uint8Array, i: number) => `${arr[i * 3]},${arr[i * 3 + 1]},${arr[i * 3 + 2]}`;

    const yUp = colorForMode('elevation', cloud, { upAxis: 1 });
    expect(new Set([0, 1, 2, 3].map((i) => colourOf(yUp, i))).size).toBe(4);

    const zUpDefault = colorForMode('elevation', cloud);
    expect(new Set([0, 1, 2, 3].map((i) => colourOf(zUpDefault, i))).size).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorByScalar — the generic scalar → perceptual-ramp core
// ────────────────────────────────────────────────────────────────────────────

describe('colorByScalar', () => {
  // Cividis endpoints (control points from colorModes.ts) — the CVD-safe
  // default the scalar modes pin to.
  const CIVIDIS_LO = [0, 32, 76];
  const CIVIDIS_HI = [253, 231, 37];

  test('returns a Uint8Array with 3 bytes per point', () => {
    const out = colorByScalar([0, 1, 2], 3, 0, 2);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(9);
  });

  test('defaults to the CVD-safe Cividis ramp — min hits the bottom stop, max the top', () => {
    expect(DEFAULT_SCALAR_PALETTE).toBe('cividis');
    const out = colorByScalar([0, 10], 2, 0, 10);
    expect([out[0], out[1], out[2]]).toEqual(CIVIDIS_LO);
    expect([out[3], out[4], out[5]]).toEqual(CIVIDIS_HI);
  });

  test('distinct values map to distinct ramp colours', () => {
    const out = colorByScalar([0, 1, 2, 3], 4, 0, 3);
    const colourOf = (i: number) => `${out[i * 3]},${out[i * 3 + 1]},${out[i * 3 + 2]}`;
    expect(new Set([0, 1, 2, 3].map(colourOf)).size).toBe(4);
  });

  test('degenerate min === max paints every point the bottom colour', () => {
    const out = colorByScalar([5, 5, 5], 3, 5, 5);
    for (let i = 0; i < 3; i++) {
      expect([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]).toEqual(CIVIDIS_LO);
    }
  });

  test('a NaN value is skipped — its bytes stay (0,0,0), neighbours unaffected', () => {
    const out = colorByScalar([0, Number.NaN, 10], 3, 0, 10);
    expect([out[0], out[1], out[2]]).toEqual(CIVIDIS_LO);
    expect([out[3], out[4], out[5]]).toEqual([0, 0, 0]);
    expect([out[6], out[7], out[8]]).toEqual(CIVIDIS_HI);
  });

  test('values outside [min, max] clamp to the ramp endpoints', () => {
    const out = colorByScalar([-100, 100], 2, 0, 10);
    expect([out[0], out[1], out[2]]).toEqual(CIVIDIS_LO);
    expect([out[3], out[4], out[5]]).toEqual(CIVIDIS_HI);
  });

  test('honours an explicit palette', () => {
    // Turbo's top stop is a dark red (122, 4, 2) — nothing like Cividis yellow.
    const out = colorByScalar([0, 1], 2, 0, 1, 'turbo');
    expect([out[3], out[4], out[5]]).toEqual([122, 4, 2]);
  });

  test('reads Float64 sources with huge absolute values without precision collapse', () => {
    // GPS adjusted standard time — ~3.2e8 s with sub-second deltas. A Float32
    // round-trip would quantise all four to the same value.
    const base = 3.2e8;
    const values = new Float64Array([base, base + 0.25, base + 0.5, base + 1]);
    const out = colorByScalar(values, 4, base, base + 1);
    const colourOf = (i: number) => `${out[i * 3]},${out[i * 3 + 1]},${out[i * 3 + 2]}`;
    expect(new Set([0, 1, 2, 3].map(colourOf)).size).toBe(4);
    expect([out[0], out[1], out[2]]).toEqual(CIVIDIS_LO);
    expect([out[9], out[10], out[11]]).toEqual(CIVIDIS_HI);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorByElevation — parity pin for the colorByScalar refactor
// ────────────────────────────────────────────────────────────────────────────

describe('colorByElevation routed through the scalar core', () => {
  test('byte-identical to colorByScalar over the extracted up-axis values', () => {
    const zs = [0, 1.5, Number.NaN, 3, -2];
    const positions = new Float32Array(zs.length * 3);
    for (let i = 0; i < zs.length; i++) positions[i * 3 + 2] = zs[i];
    const viaElevation = colorByElevation(positions, zs.length, -2, 3);
    const viaScalar = colorByScalar(
      Float32Array.from(zs), zs.length, -2, 3, DEFAULT_ELEVATION_PALETTE,
    );
    expect(viaElevation).toEqual(viaScalar);
  });

  test('upAxis parity — Y-up extraction matches the scalar core over Y', () => {
    const ys = [10, 20, 30];
    const positions = new Float32Array([7, 10, 9, 7, 20, 9, 7, 30, 9]);
    const viaElevation = colorByElevation(positions, 3, 10, 30, 'viridis', 1);
    const viaScalar = colorByScalar(ys, 3, 10, 30, 'viridis');
    expect(viaElevation).toEqual(viaScalar);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorByIntensity — optional colormap path
// ────────────────────────────────────────────────────────────────────────────

describe('colorByIntensity with a palette', () => {
  test('stays greyscale when no palette is passed (back-compat)', () => {
    const out = colorByIntensity([0, 50, 100], 3, 0, 100);
    for (let i = 0; i < 3; i++) {
      expect(out[i * 3]).toBe(out[i * 3 + 1]);
      expect(out[i * 3 + 1]).toBe(out[i * 3 + 2]);
    }
  });

  test('ramps through the palette when one is passed', () => {
    const out = colorByIntensity([0, 100], 2, 0, 100, 'cividis');
    expect([out[0], out[1], out[2]]).toEqual([0, 32, 76]);
    expect([out[3], out[4], out[5]]).toEqual([253, 231, 37]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorForMode — gpsTime / returnNumber (continuous scalar modes)
// ────────────────────────────────────────────────────────────────────────────

describe('colorForMode — gpsTime', () => {
  /** Cloud carrying a Float64 GPS-time channel with huge absolute values. */
  function makeGpsTimeCloud(): PointCloud {
    const base = 3.2e8;
    return new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      gpsTime: new Float64Array([base, base + 1, base + 2, base + 3]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'gps.las',
    });
  }

  test('ramps early → late acquisition time on Cividis (min bottom, max top)', () => {
    const out = colorForMode('gpsTime', makeGpsTimeCloud());
    expect(out.length).toBe(4 * 3);
    expect([out[0], out[1], out[2]]).toEqual([0, 32, 76]);
    expect([out[9], out[10], out[11]]).toEqual([253, 231, 37]);
  });

  test('normalises per-cloud so sub-range deltas on huge Float64 values stay distinct', () => {
    const out = colorForMode('gpsTime', makeGpsTimeCloud());
    const colourOf = (i: number) => `${out[i * 3]},${out[i * 3 + 1]},${out[i * 3 + 2]}`;
    expect(new Set([0, 1, 2, 3].map(colourOf)).size).toBe(4);
  });

  test('throws when gpsTime is absent', () => {
    expect(() => colorForMode('gpsTime', makePositionsOnlyCloud())).toThrow();
  });
});

describe('colorForMode — returnNumber', () => {
  function makeReturnCloud(): PointCloud {
    return new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      returnNumber: new Uint8Array([1, 2, 3]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'returns.las',
    });
  }

  test('ramps first → last return on Cividis (min bottom, max top)', () => {
    const out = colorForMode('returnNumber', makeReturnCloud());
    expect(out.length).toBe(3 * 3);
    expect([out[0], out[1], out[2]]).toEqual([0, 32, 76]);
    expect([out[6], out[7], out[8]]).toEqual([253, 231, 37]);
  });

  test('throws when returnNumber is absent', () => {
    expect(() => colorForMode('returnNumber', makePositionsOnlyCloud())).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorForMode — classification
// ────────────────────────────────────────────────────────────────────────────

describe('colorForMode — classification', () => {
  test('returns a Uint8Array with 3 bytes per point', () => {
    const cloud = makeFullCloud();
    const result = colorForMode('classification', cloud);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(cloud.pointCount * 3);
  });

  test('two points with the same class code get the same colour', () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      classification: new Uint8Array([5, 5, 3]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'same-class.las',
    });
    const result = colorForMode('classification', cloud);
    // Points 0 and 1 share class 5
    expect(result[0]).toBe(result[3]);
    expect(result[1]).toBe(result[4]);
    expect(result[2]).toBe(result[5]);
    // Point 2 has class 3 — should differ from class 5
    // (palette entries for class 5 and class 3 are distinct)
    const sameAsPoint0 =
      result[6] === result[0] &&
      result[7] === result[1] &&
      result[8] === result[2];
    expect(sameAsPoint0).toBe(false);
  });

  test('throws when classification is absent', () => {
    const cloud = makePositionsOnlyCloud();
    expect(() => colorForMode('classification', cloud)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorForMode — normal
// ────────────────────────────────────────────────────────────────────────────

describe('colorForMode — normal', () => {
  test('returns a Uint8Array with 3 bytes per point', () => {
    const cloud = makeNormalsCloud();
    const result = colorForMode('normal', cloud);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(cloud.pointCount * 3);
  });

  test('encodes a unit normal direction as RGB (component −1…+1 → 0…255)', () => {
    const cloud = makeNormalsCloud(); // normals: +X, +Y, +Z
    const result = colorForMode('normal', cloud);
    // +X normal → R full, G and B at the midpoint (0 → 127/128).
    expect(result[0]).toBe(255);
    expect(result[1]).toBeGreaterThanOrEqual(127);
    expect(result[1]).toBeLessThanOrEqual(128);
    // +Y normal → G full.
    expect(result[4]).toBe(255);
    // +Z normal → B full.
    expect(result[8]).toBe(255);
  });

  test('normalises an un-normalised normal before encoding', () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0]),
      normals: new Float32Array([5, 0, 0]), // length 5, points +X
      origin: [0, 0, 0],
      sourceFormat: 'e57',
      name: 'long-normal.e57',
    });
    const result = colorForMode('normal', cloud);
    // After normalising, the +X direction still maps R to full.
    expect(result[0]).toBe(255);
  });

  test('throws when normals are absent', () => {
    const cloud = makePositionsOnlyCloud();
    expect(() => colorForMode('normal', cloud)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colorForMode — coverage (DTM-confidence heatmap on the cloud)
// ────────────────────────────────────────────────────────────────────────────

describe('colorForMode — coverage', () => {
  // A 2x2 confidence grid at origin (0,0), 1 m cells:
  //   col0,row0 strong   col1,row0 moderate
  //   col0,row1 weak      col1,row1 empty (no data)
  const coverageGrid = {
    confidence: new Float32Array([
      80, 50, // row 0: strong, moderate
      10, 0,  // row 1: weak, empty
    ]),
    coverage: new Uint8Array([2, 1, 1, 0]),
    cols: 2,
    rows: 2,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
  };

  test('tints each point by the confidence of the cell it falls in', () => {
    // Points placed in the centre of each of the four cells.
    const cloud = new PointCloud({
      positions: new Float32Array([
        0.5, 0.5, 0, // → col0,row0 strong (green)
        1.5, 0.5, 0, // → col1,row0 moderate (yellow)
        0.5, 1.5, 0, // → col0,row1 weak (red)
        1.5, 1.5, 0, // → col1,row1 empty (grey)
      ]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'cov.las',
    });
    const out = colorForMode('coverage', cloud, { coverageGrid });
    expect(out.length).toBe(4 * 3);
    expect([out[0], out[1], out[2]]).toEqual([
      COVERAGE_STRONG.r, COVERAGE_STRONG.g, COVERAGE_STRONG.b,
    ]);
    expect([out[3], out[4], out[5]]).toEqual([
      COVERAGE_MODERATE.r, COVERAGE_MODERATE.g, COVERAGE_MODERATE.b,
    ]);
    expect([out[6], out[7], out[8]]).toEqual([
      COVERAGE_WEAK.r, COVERAGE_WEAK.g, COVERAGE_WEAK.b,
    ]);
    // Empty cell → neutral dim grey, not a coverage colour.
    expect([out[9], out[10], out[11]]).toEqual([
      COVERAGE_NONE.r, COVERAGE_NONE.g, COVERAGE_NONE.b,
    ]);
  });

  test('points outside the analysed grid get the neutral grey', () => {
    const cloud = new PointCloud({
      positions: new Float32Array([
        -5, -5, 0, // left/below the grid
        100, 100, 0, // right/above the grid
      ]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'outside.las',
    });
    const out = colorForMode('coverage', cloud, { coverageGrid });
    expect([out[0], out[1], out[2]]).toEqual([
      COVERAGE_NONE.r, COVERAGE_NONE.g, COVERAGE_NONE.b,
    ]);
    expect([out[3], out[4], out[5]]).toEqual([
      COVERAGE_NONE.r, COVERAGE_NONE.g, COVERAGE_NONE.b,
    ]);
  });

  test('without a coverage grid, every point is the neutral grey (no throw)', () => {
    const cloud = makePositionsOnlyCloud();
    expect(() => colorForMode('coverage', cloud)).not.toThrow();
    const out = colorForMode('coverage', cloud);
    for (let i = 0; i < cloud.pointCount; i++) {
      expect([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]).toEqual([
        COVERAGE_NONE.r, COVERAGE_NONE.g, COVERAGE_NONE.b,
      ]);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// availableModes
// ────────────────────────────────────────────────────────────────────────────

describe('availableModes', () => {
  test('elevation is always included', () => {
    const cloud = makePositionsOnlyCloud();
    expect(availableModes(cloud)).toContain('elevation');
  });

  test('rgb included only when colors present', () => {
    expect(availableModes(makeFullCloud())).toContain('rgb');
    expect(availableModes(makePositionsOnlyCloud())).not.toContain('rgb');
  });

  test('intensity included only when intensity present', () => {
    expect(availableModes(makeFullCloud())).toContain('intensity');
    expect(availableModes(makePositionsOnlyCloud())).not.toContain('intensity');
  });

  test('classification included only when classification present', () => {
    expect(availableModes(makeFullCloud())).toContain('classification');
    expect(availableModes(makePositionsOnlyCloud())).not.toContain('classification');
  });

  test('normal included only when normals present', () => {
    expect(availableModes(makeNormalsCloud())).toContain('normal');
    expect(availableModes(makeFullCloud())).not.toContain('normal');
  });

  test('gpsTime included only when the channel is present', () => {
    const withGps = new PointCloud({
      positions: new Float32Array([0, 0, 0]),
      gpsTime: new Float64Array([3.2e8]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'gps.las',
    });
    expect(availableModes(withGps)).toContain('gpsTime');
    expect(availableModes(makePositionsOnlyCloud())).not.toContain('gpsTime');
  });

  test('returnNumber included only when the channel is present', () => {
    const withReturns = new PointCloud({
      positions: new Float32Array([0, 0, 0]),
      returnNumber: new Uint8Array([1]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'returns.las',
    });
    expect(availableModes(withReturns)).toContain('returnNumber');
    expect(availableModes(makePositionsOnlyCloud())).not.toContain('returnNumber');
  });

  test('honesty gate — a pointSourceId channel adds NO ramp mode (categorical id)', () => {
    const withSource = new PointCloud({
      positions: new Float32Array([0, 0, 0]),
      pointSourceId: new Uint16Array([7]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'source.las',
    });
    expect(availableModes(withSource)).toEqual(availableModes(makePositionsOnlyCloud()));
  });

  test('positions-only cloud has exactly two modes (elevation + density)', () => {
    // Density is always available — it derives from positions alone.
    expect(availableModes(makePositionsOnlyCloud())).toEqual(['elevation', 'density']);
  });

  test('full cloud has all colour modes its data supports plus density', () => {
    const modes = availableModes(makeFullCloud());
    // rgb + intensity + elevation + classification + density (no normals on
    // the fixture). Five total.
    expect(modes).toHaveLength(5);
    expect(modes).toContain('rgb');
    expect(modes).toContain('intensity');
    expect(modes).toContain('elevation');
    expect(modes).toContain('classification');
    expect(modes).toContain('density');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// defaultMode
// ────────────────────────────────────────────────────────────────────────────

describe('defaultMode', () => {
  test('returns rgb when colors are present', () => {
    expect(defaultMode(makeFullCloud())).toBe('rgb');
  });

  test('returns elevation when colors are absent', () => {
    expect(defaultMode(makePositionsOnlyCloud())).toBe('elevation');
  });
});
