import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLas, classificationMaskFor } from '../src/io/loadLas';

/** Read a fixture as a tightly-sliced ArrayBuffer (no pooled Node padding). */
function loadFixture(name: string): ArrayBuffer {
  const file = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

// Ground truth from FIXTURES.md.
const KNOWN_FIRST_GLOBAL: [number, number, number] = [500123.456, 4100876.789, 210.25];
const KNOWN_MIN: [number, number, number] = [500123.456, 4100876.789, 210.25];
const KNOWN_MAX: [number, number, number] = [500134.5, 4100887.5, 215.0];

describe('loadLas — tiny.las fixture (uncompressed)', () => {
  test('point count is 12', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las', 'tiny.las');
    expect(pc.pointCount).toBe(12);
  });

  test('declaredPointCount is set from the header', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    expect(pc.declaredPointCount).toBe(12);
  });

  test('origin is the floored min bounds', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    expect(pc.origin).toEqual([500123, 4100876, 210]);
  });

  test('sourceFormat is las', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    expect(pc.sourceFormat).toBe('las');
  });

  test('first recentered point + origin reconstructs the global coord to <= 1e-3 m', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    for (let axis = 0; axis < 3; axis++) {
      const reconstructed = pc.positions[axis] + pc.origin[axis];
      expect(Math.abs(reconstructed - KNOWN_FIRST_GLOBAL[axis])).toBeLessThanOrEqual(1e-3);
    }
  });

  test('all points reconstruct within the declared global bounds (<= 1e-3 m)', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    const { min, max } = pc.bounds();
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(min[axis] + pc.origin[axis] - KNOWN_MIN[axis])).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(max[axis] + pc.origin[axis] - KNOWN_MAX[axis])).toBeLessThanOrEqual(1e-3);
    }
  });

  test('intensity and classification are decoded', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    expect(pc.intensity).toBeInstanceOf(Uint16Array);
    expect(pc.intensity!.length).toBe(12);
    expect(pc.classification).toBeInstanceOf(Uint8Array);
    expect(pc.classification!.length).toBe(12);
  });
});

describe('loadLas — tiny.laz fixture (compressed)', () => {
  test('point count is 12', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz', 'tiny.laz');
    expect(pc.pointCount).toBe(12);
  });

  test('sourceFormat is laz', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz');
    expect(pc.sourceFormat).toBe('laz');
  });

  test('first recentered point + origin reconstructs the global coord to <= 1e-3 m', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz');
    for (let axis = 0; axis < 3; axis++) {
      const reconstructed = pc.positions[axis] + pc.origin[axis];
      expect(Math.abs(reconstructed - KNOWN_FIRST_GLOBAL[axis])).toBeLessThanOrEqual(1e-3);
    }
  });

  test('all points reconstruct within the declared global bounds (<= 1e-3 m)', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz');
    const { min, max } = pc.bounds();
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(min[axis] + pc.origin[axis] - KNOWN_MIN[axis])).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(max[axis] + pc.origin[axis] - KNOWN_MAX[axis])).toBeLessThanOrEqual(1e-3);
    }
  });

  test('intensity and classification are decoded', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz');
    expect(pc.intensity).toBeInstanceOf(Uint16Array);
    expect(pc.intensity!.length).toBe(12);
    expect(pc.classification).toBeInstanceOf(Uint8Array);
    expect(pc.classification!.length).toBe(12);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// classificationMaskFor — legacy vs extended point formats
// ────────────────────────────────────────────────────────────────────────────

describe('classificationMaskFor', () => {
  test('point formats 0-5 mask to the low 5 bits (the flags are separate)', () => {
    for (const fmt of [0, 1, 2, 3, 4, 5]) {
      expect(classificationMaskFor(fmt)).toBe(0x1f);
    }
  });

  test('point formats 6-10 use the full classification byte', () => {
    for (const fmt of [6, 7, 8, 9, 10]) {
      expect(classificationMaskFor(fmt)).toBe(0xff);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Synthetic LAS 1.2, point format 0 — exercises the legacy-record path that
// the bundled fixtures (point format 6) do not reach.
// ────────────────────────────────────────────────────────────────────────────

interface SynthPoint {
  x: number;
  y: number;
  z: number;
  intensity: number;
  /** Raw classification byte, including any flag bits in bits 5-7. */
  classByte: number;
}

/** Build a minimal uncompressed LAS 1.2, point data record format 0. */
function makeLasFormat0(points: SynthPoint[], declaredCount?: number): ArrayBuffer {
  const HEADER = 227;
  const REC = 20;
  const buf = new ArrayBuffer(HEADER + points.length * REC);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  u8[0] = 0x4c; // 'L'
  u8[1] = 0x41; // 'A'
  u8[2] = 0x53; // 'S'
  u8[3] = 0x46; // 'F'
  view.setUint8(24, 1); // version major
  view.setUint8(25, 2); // version minor — LAS 1.2
  view.setUint16(94, HEADER, true); // header size
  view.setUint32(96, HEADER, true); // offset to point data
  view.setUint32(100, 0, true); // VLR count
  view.setUint8(104, 0); // point data record format 0
  view.setUint16(105, REC, true); // point data record length
  view.setUint32(107, declaredCount ?? points.length, true); // legacy point count
  for (let a = 0; a < 3; a++) view.setFloat64(131 + a * 8, 0.001, true); // scale
  for (let a = 0; a < 3; a++) view.setFloat64(155 + a * 8, 0, true); // offset
  // Bounds are left at zero — they only seed the (irrelevant here) origin.

  for (let i = 0; i < points.length; i++) {
    const base = HEADER + i * REC;
    view.setInt32(base, points[i].x, true);
    view.setInt32(base + 4, points[i].y, true);
    view.setInt32(base + 8, points[i].z, true);
    view.setUint16(base + 12, points[i].intensity, true);
    view.setUint8(base + 15, points[i].classByte); // classification byte
  }
  return buf;
}

describe('loadLas — legacy classification masking (point format 0)', () => {
  test('the synthetic, key-point, and withheld flag bits are masked off', async () => {
    const buf = makeLasFormat0([
      { x: 0, y: 0, z: 0, intensity: 100, classByte: 2 }, // ground, no flags
      { x: 0, y: 0, z: 0, intensity: 100, classByte: 0x80 | 2 }, // withheld + ground
      { x: 0, y: 0, z: 0, intensity: 100, classByte: 0x20 | 6 }, // synthetic + building
    ]);
    const pc = await loadLas(buf, 'las');
    // Without the 0x1f mask these would decode as [2, 130, 38].
    expect(Array.from(pc.classification!)).toEqual([2, 2, 6]);
  });
});

describe('loadLas — header point-count clamping', () => {
  test('a header claiming more points than the file holds is clamped, not thrown', async () => {
    const point: SynthPoint = { x: 1000, y: 2000, z: 3000, intensity: 50, classByte: 1 };
    // Header declares 8 points; the file only contains 3.
    const buf = makeLasFormat0([point, point, point], 8);
    const pc = await loadLas(buf, 'las');
    expect(pc.pointCount).toBe(3); // clamped to what the file can hold
    expect(pc.declaredPointCount).toBe(8); // the header value is still reported
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Stride decode — the v0.2.7 fast-load path
// ────────────────────────────────────────────────────────────────────────────

describe('loadLas — stride decode', () => {
  /** A set of "x,y,z" keys for every point in a cloud. */
  function pointKeys(cloud: { positions: Float32Array; pointCount: number }): Set<string> {
    const keys = new Set<string>();
    for (let p = 0; p < cloud.pointCount; p++) {
      keys.add(
        `${cloud.positions[p * 3]},${cloud.positions[p * 3 + 1]},${cloud.positions[p * 3 + 2]}`,
      );
    }
    return keys;
  }

  test('stride 3 stratified-samples the 12-point fixture to 4 real records', async () => {
    const full = await loadLas(loadFixture('tiny.las'), 'las');
    const strided = await loadLas(loadFixture('tiny.las'), 'las', 'tiny.las', 3);
    expect(strided.pointCount).toBe(4); // ceil(12 / 3)
    // Every kept point is an exact record of the full decode — the sampler
    // never invents or interpolates points.
    const fullKeys = pointKeys(full);
    for (let p = 0; p < strided.pointCount; p++) {
      const key = `${strided.positions[p * 3]},${strided.positions[p * 3 + 1]},${strided.positions[p * 3 + 2]}`;
      expect(fullKeys.has(key)).toBe(true);
    }
  });

  test('stride 2 halves the 12-point fixture', async () => {
    const strided = await loadLas(loadFixture('tiny.las'), 'las', 'tiny.las', 2);
    expect(strided.pointCount).toBe(6); // ceil(12 / 2)
  });

  test('a stride decode is deterministic — two loads agree exactly', async () => {
    const a = await loadLas(loadFixture('tiny.las'), 'las', 'tiny.las', 3);
    const b = await loadLas(loadFixture('tiny.las'), 'las', 'tiny.las', 3);
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
  });

  test('stride decode also works on compressed LAZ', async () => {
    const strided = await loadLas(loadFixture('tiny.laz'), 'laz', 'tiny.laz', 3);
    expect(strided.pointCount).toBe(4);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// laz-perf module reuse — the v0.2.7 decoder-init cache
// ────────────────────────────────────────────────────────────────────────────

describe('loadLas — laz-perf module reuse', () => {
  test('two sequential LAZ decodes through the reused WASM module agree', async () => {
    const a = await loadLas(loadFixture('tiny.laz'), 'laz');
    const b = await loadLas(loadFixture('tiny.laz'), 'laz');
    expect(a.pointCount).toBe(12);
    expect(b.pointCount).toBe(12);
    // The reused module must produce a bit-identical decode the second time.
    for (let i = 0; i < a.positions.length; i++) {
      expect(b.positions[i]).toBe(a.positions[i]);
    }
  });
});
