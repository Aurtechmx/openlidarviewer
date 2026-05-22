import { colorForMode, availableModes, defaultMode } from '../src/render/colorModes';
import { PointCloud } from '../src/model/PointCloud';

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

  test('positions-only cloud has exactly one mode', () => {
    expect(availableModes(makePositionsOnlyCloud())).toEqual(['elevation']);
  });

  test('full cloud has all four modes', () => {
    const modes = availableModes(makeFullCloud());
    expect(modes).toHaveLength(4);
    expect(modes).toContain('rgb');
    expect(modes).toContain('intensity');
    expect(modes).toContain('elevation');
    expect(modes).toContain('classification');
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
