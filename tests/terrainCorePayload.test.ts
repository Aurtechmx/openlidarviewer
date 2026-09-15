/**
 * terrainCorePayload.test.ts
 *
 * A persisted TerrainCore must come back as the computed one: every grid byte
 * for byte, every scalar including the non-finite ones JSON cannot carry, and
 * the contour stage downstream must not be able to tell the two apart. The
 * codec also has to refuse what it does not model instead of approximating it.
 * The cloud is small so the core computes in well under a second. Its params
 * are the projected metre frame the benchmarks use. The comparator treats NaN
 * as equal to NaN, which the built-in equality does not.
 */
import { describe, it, expect } from 'vitest';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import type { TerrainCore, TerrainCoreParams } from '../src/terrain/contour/analyseContours';
import { encodeTerrainCore, decodeTerrainCore, TERRAIN_CORE_PAYLOAD_VERSION } from '../src/terrain/contour/terrainCorePayload';

export function smallCloud(n = 3000, seed = 7): Float32Array {
  const xyz = new Float32Array(n * 3);
  let s = seed >>> 0;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / side;
    const gy = Math.floor(i / side) / side;
    xyz[i * 3] = gx * 200 + (rnd() - 0.5) * 0.5;
    xyz[i * 3 + 1] = gy * 200 + (rnd() - 0.5) * 0.5;
    xyz[i * 3 + 2] = 50 + 4 * Math.sin(gx * 6) * Math.cos(gy * 5) + (rnd() - 0.5) * 0.2;
  }
  return xyz;
}
export const SMALL_PARAMS: TerrainCoreParams = { cellSizeM: 4, crs: 'EPSG:32610', verticalUnitToMetres: 1, horizontalUnitToMetres: 1 };

/** Deep equality where NaN equals NaN and typed arrays compare by bytes. */
export function sameCore(a: unknown, b: unknown, path = ''): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b) || a === b ? null : `${path}: ${a} != ${b}`;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return `${path}: view vs non-view`;
    if (a.constructor !== b.constructor) return `${path}: ${a.constructor.name} vs ${b.constructor.name}`;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (x.length !== y.length) return `${path}: byte length`;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `${path}: byte ${i}`;
    return null;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? null : `${path}: ${String(a)} != ${String(b)}`;
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
  if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
  for (const k of ka) {
    const r = sameCore((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (r) return r;
  }
  return null;
}

describe('terrain core payload', () => {
  const core = computeTerrainCore(smallCloud(), SMALL_PARAMS);

  it('round-trips a computed core with every grid and scalar intact', () => {
    const bytes = encodeTerrainCore(core);
    expect(bytes).not.toBeNull();
    const back = decodeTerrainCore(bytes!);
    expect('core' in back).toBe(true);
    expect(sameCore((back as { core: TerrainCore }).core, core)).toBeNull();
  });

  it('carries NaN and the infinities, which JSON alone drops', () => {
    const withNonFinite = { ...core, minZ: Number.NaN, maxZ: Number.POSITIVE_INFINITY, elevationRangeM: Number.NEGATIVE_INFINITY };
    const back = decodeTerrainCore(encodeTerrainCore(withNonFinite as TerrainCore)!) as { core: TerrainCore };
    expect(Number.isNaN(back.core.minZ)).toBe(true);
    expect(back.core.maxZ).toBe(Number.POSITIVE_INFINITY);
    expect(back.core.elevationRangeM).toBe(Number.NEGATIVE_INFINITY);
  });

  it('the contour stage cannot tell a restored core from the computed one', () => {
    const back = (decodeTerrainCore(encodeTerrainCore(core)!) as { core: TerrainCore }).core;
    const a = contoursFromCore(core, { intervalM: 1 });
    const b = contoursFromCore(back, { intervalM: 1 });
    expect(sameCore(b, a)).toBeNull();
  });

  it('restored grids own fresh buffers', () => {
    const back = (decodeTerrainCore(encodeTerrainCore(core)!) as { core: TerrainCore }).core;
    expect(back.dtm.z).not.toBe(core.dtm.z);
    expect(back.dtm.z.byteOffset).toBe(0);
    expect(back.dtm.z.buffer.byteLength).toBe(core.dtm.z.byteLength);
  });

  it('refuses a core carrying something it does not model', () => {
    expect(encodeTerrainCore({ ...core, quality: new Map() } as unknown as TerrainCore)).toBeNull();
    expect(encodeTerrainCore({ ...core, gate: { run: () => 1 } } as unknown as TerrainCore)).toBeNull();
    expect(encodeTerrainCore({ ...core, crs: new Date() } as unknown as TerrainCore)).toBeNull();
  });

  it('misses a payload of another format version instead of guessing', () => {
    const bytes = encodeTerrainCore(core)!;
    const hlen = new DataView(bytes.buffer).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen)));
    header.format = TERRAIN_CORE_PAYLOAD_VERSION + 1;
    const h2 = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(4 + h2.byteLength + (bytes.byteLength - 4 - hlen));
    new DataView(out.buffer).setUint32(0, h2.byteLength, true);
    out.set(h2, 4);
    out.set(bytes.subarray(4 + hlen), 4 + h2.byteLength);
    expect(decodeTerrainCore(out)).toEqual({ failure: 'format-mismatch' });
  });

  it('a truncated payload is malformed, never a shorter core', () => {
    const bytes = encodeTerrainCore(core)!;
    expect(decodeTerrainCore(bytes.subarray(0, bytes.byteLength - 10))).toEqual({ failure: 'malformed' });
    expect(decodeTerrainCore(new Uint8Array(2))).toEqual({ failure: 'malformed' });
  });
});
