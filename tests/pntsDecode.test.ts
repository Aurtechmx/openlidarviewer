/**
 * tests/pntsDecode.test.ts
 *
 * Coverage for the v0.3.7 PNTS (3D Tiles Point Cloud) binary decoder.
 *
 * Builds tiny in-memory PNTS files using a fixture helper and verifies
 * the decoded output matches what was encoded. Pins the header magic +
 * version + length checks, the POSITION / POSITION_QUANTIZED + RGB /
 * RGBA / NORMAL attribute paths, the RTC_CENTER global, and the
 * "not implemented yet" surface for RGB565 / NORMAL_OCT16P.
 */

import { describe, it, expect } from 'vitest';
import { decodePnts } from '../src/io/tiles3d/pntsDecode';

// ── fixture builder ────────────────────────────────────────────────────────

interface FixtureSpec {
  ftJson: object;
  ftBinBytes?: Uint8Array;
  /** Override the magic — for the bad-magic test. */
  magicOverride?: number;
  /** Override the version uint — for the bad-version test. */
  versionOverride?: number;
}

/** Build a PNTS file in memory from a Feature Table JSON + binary block. */
function buildPnts(spec: FixtureSpec): ArrayBuffer {
  const enc = new TextEncoder();
  let jsonText = JSON.stringify(spec.ftJson);
  // Spec requires the JSON section to be 4-byte aligned.
  while ((28 + jsonText.length) % 4 !== 0) jsonText += ' ';
  const jsonBytes = enc.encode(jsonText);
  const binBytes = spec.ftBinBytes ?? new Uint8Array(0);
  const total = 28 + jsonBytes.length + binBytes.length;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // Magic 'pnts' — little-endian = 0x73746e70
  dv.setUint32(0, spec.magicOverride ?? 0x73746e70, true);
  dv.setUint32(4, spec.versionOverride ?? 1, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, binBytes.length, true);
  dv.setUint32(20, 0, true); // batch table JSON
  dv.setUint32(24, 0, true); // batch table binary
  bytes.set(jsonBytes, 28);
  bytes.set(binBytes, 28 + jsonBytes.length);
  return buf;
}

/** Pack interleaved float32 positions into a Uint8Array view. */
function packFloat32(values: number[]): Uint8Array {
  const f = new Float32Array(values);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** Pack interleaved uint8 colours. */
function packU8(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Pack interleaved uint16. */
function packU16(values: number[]): Uint8Array {
  const u = new Uint16Array(values);
  return new Uint8Array(u.buffer, u.byteOffset, u.byteLength);
}

/** Concatenate Uint8Arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── header validation ──────────────────────────────────────────────────────

describe('decodePnts — header validation', () => {
  it('rejects a buffer shorter than the 28-byte header', () => {
    expect(() => decodePnts(new ArrayBuffer(20))).toThrow(/header/);
  });

  it('rejects a wrong magic', () => {
    const buf = buildPnts({
      ftJson: { POINTS_LENGTH: 0 },
      magicOverride: 0xdeadbeef,
    });
    expect(() => decodePnts(buf)).toThrow(/magic/);
  });

  it('rejects a version other than 1', () => {
    const buf = buildPnts({
      ftJson: { POINTS_LENGTH: 0 },
      versionOverride: 2,
    });
    expect(() => decodePnts(buf)).toThrow(/version 2/);
  });

  it('rejects a declared byteLength that disagrees with the buffer', () => {
    const buf = buildPnts({ ftJson: { POINTS_LENGTH: 0 } });
    // Corrupt the byteLength field.
    new DataView(buf).setUint32(8, 0, true);
    expect(() => decodePnts(buf)).toThrow(/byteLength/);
  });

  it('rejects a Feature Table JSON that overruns the file', () => {
    const buf = buildPnts({ ftJson: { POINTS_LENGTH: 0 } });
    new DataView(buf).setUint32(12, buf.byteLength + 1, true);
    expect(() => decodePnts(buf)).toThrow(/overruns/);
  });
});

// ── POSITION (float32) ──────────────────────────────────────────────────────

describe('decodePnts — POSITION', () => {
  it('decodes 3 points with explicit float32 positions', () => {
    const positions = [
      1.5, 2.5, 3.5,
      -1, -2, -3,
      10, 20, 30,
    ];
    const buf = buildPnts({
      ftJson: { POINTS_LENGTH: 3, POSITION: { byteOffset: 0 } },
      ftBinBytes: packFloat32(positions),
    });
    const out = decodePnts(buf);
    expect(out.pointCount).toBe(3);
    expect(Array.from(out.positions)).toEqual(positions);
    expect(out.colors).toBeNull();
    expect(out.normals).toBeNull();
    expect(out.rtcCenter).toBeNull();
  });

  it('throws when neither POSITION nor POSITION_QUANTIZED is present', () => {
    const buf = buildPnts({ ftJson: { POINTS_LENGTH: 1 } });
    expect(() => decodePnts(buf)).toThrow(/POSITION/);
  });

  it('throws when POSITION overruns the binary block', () => {
    // Declare 3 points but ship only 12 bytes (one point) of positions.
    const buf = buildPnts({
      ftJson: { POINTS_LENGTH: 3, POSITION: { byteOffset: 0 } },
      ftBinBytes: packFloat32([1, 2, 3]),
    });
    expect(() => decodePnts(buf)).toThrow(/overruns/);
  });
});

// ── POSITION_QUANTIZED ─────────────────────────────────────────────────────

describe('decodePnts — POSITION_QUANTIZED', () => {
  it('decodes quantised positions through the volume offset + scale', () => {
    // Two points at u16 (0, 0, 0) and (65535, 65535, 65535) → after
    // dequant should be at (10, 20, 30) and (10 + scale[0], ...).
    const positions = [0, 0, 0, 65535, 65535, 65535];
    const buf = buildPnts({
      ftJson: {
        POINTS_LENGTH: 2,
        POSITION_QUANTIZED: { byteOffset: 0 },
        QUANTIZED_VOLUME_OFFSET: [10, 20, 30],
        QUANTIZED_VOLUME_SCALE: [100, 200, 300],
      },
      ftBinBytes: packU16(positions),
    });
    const out = decodePnts(buf);
    expect(out.positions[0]).toBeCloseTo(10, 5);
    expect(out.positions[1]).toBeCloseTo(20, 5);
    expect(out.positions[2]).toBeCloseTo(30, 5);
    expect(out.positions[3]).toBeCloseTo(110, 5);
    expect(out.positions[4]).toBeCloseTo(220, 5);
    expect(out.positions[5]).toBeCloseTo(330, 5);
  });

  it('throws when QUANTIZED_VOLUME_OFFSET or _SCALE is missing', () => {
    const buf = buildPnts({
      ftJson: {
        POINTS_LENGTH: 1,
        POSITION_QUANTIZED: { byteOffset: 0 },
      },
      ftBinBytes: packU16([0, 0, 0]),
    });
    expect(() => decodePnts(buf)).toThrow(/QUANTIZED_VOLUME/);
  });
});

// ── colours ────────────────────────────────────────────────────────────────

describe('decodePnts — RGB / RGBA', () => {
  it('decodes RGB (3 × uint8) into an interleaved byte buffer', () => {
    const positions = packFloat32([0, 0, 0, 1, 1, 1]);
    const colors = packU8([255, 0, 0, 0, 255, 0]);
    const buf = buildPnts({
      ftJson: {
        POINTS_LENGTH: 2,
        POSITION: { byteOffset: 0 },
        RGB: { byteOffset: positions.length },
      },
      ftBinBytes: concat(positions, colors),
    });
    const out = decodePnts(buf);
    expect(out.colors).not.toBeNull();
    expect(Array.from(out.colors!)).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it('decodes RGBA (4 × uint8) by dropping the alpha channel', () => {
    const positions = packFloat32([0, 0, 0]);
    const colors = packU8([255, 128, 64, 200]); // alpha = 200 is dropped
    const buf = buildPnts({
      ftJson: {
        POINTS_LENGTH: 1,
        POSITION: { byteOffset: 0 },
        RGBA: { byteOffset: positions.length },
      },
      ftBinBytes: concat(positions, colors),
    });
    const out = decodePnts(buf);
    expect(Array.from(out.colors!)).toEqual([255, 128, 64]);
  });

  it('surfaces RGB565 as a "not implemented" error', () => {
    const buf = buildPnts({
      ftJson: {
        POINTS_LENGTH: 1,
        POSITION: { byteOffset: 0 },
        RGB565: { byteOffset: 12 },
      },
      ftBinBytes: concat(packFloat32([0, 0, 0]), packU8([0, 0])),
    });
    expect(() => decodePnts(buf)).toThrow(/RGB565/);
  });
});

// ── normals + RTC_CENTER ───────────────────────────────────────────────────

describe('decodePnts — NORMAL + RTC_CENTER', () => {
  it('decodes float32 NORMAL when present', () => {
    const positions = packFloat32([0, 0, 0]);
    const normals = packFloat32([0, 0, 1]);
    const buf = buildPnts({
      ftJson: {
        POINTS_LENGTH: 1,
        POSITION: { byteOffset: 0 },
        NORMAL: { byteOffset: positions.length },
      },
      ftBinBytes: concat(positions, normals),
    });
    const out = decodePnts(buf);
    expect(Array.from(out.normals!)).toEqual([0, 0, 1]);
  });

  it('returns null normals when the tile omits them', () => {
    const positions = packFloat32([0, 0, 0]);
    const buf = buildPnts({
      ftJson: { POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } },
      ftBinBytes: positions,
    });
    const out = decodePnts(buf);
    expect(out.normals).toBeNull();
  });

  it('surfaces NORMAL_OCT16P as a "not implemented" error', () => {
    const buf = buildPnts({
      ftJson: {
        POINTS_LENGTH: 1,
        POSITION: { byteOffset: 0 },
        NORMAL_OCT16P: { byteOffset: 12 },
      },
      ftBinBytes: concat(packFloat32([0, 0, 0]), packU8([0, 0])),
    });
    expect(() => decodePnts(buf)).toThrow(/NORMAL_OCT16P/);
  });

  it('returns RTC_CENTER when the Feature Table JSON ships one', () => {
    const positions = packFloat32([0, 0, 0]);
    const buf = buildPnts({
      ftJson: {
        POINTS_LENGTH: 1,
        POSITION: { byteOffset: 0 },
        RTC_CENTER: [100, 200, 300],
      },
      ftBinBytes: positions,
    });
    const out = decodePnts(buf);
    expect(out.rtcCenter).toEqual([100, 200, 300]);
  });

  it('returns null RTC_CENTER when omitted', () => {
    const positions = packFloat32([0, 0, 0]);
    const buf = buildPnts({
      ftJson: { POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } },
      ftBinBytes: positions,
    });
    const out = decodePnts(buf);
    expect(out.rtcCenter).toBeNull();
  });
});
