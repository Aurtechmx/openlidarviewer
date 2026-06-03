/**
 * tests/localDensitySizeAndSky.test.ts
 *
 * Coverage for A.3 (local-density adaptive sizing) and A.5 (sky
 * presets). Pins the size-curve, the cap behaviour, and the sky
 * catalogue.
 */

import { describe, it, expect } from 'vitest';
import { localDensitySizes } from '../src/render/localDensitySize';
import {
  getSkyDefinition,
  SKY_PRESET_ORDER,
} from '../src/render/skyPresets';

function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

describe('localDensitySizes — per-point density-aware sizing', () => {
  it('returns a scale factor for every point', () => {
    const positions = pack([
      [0, 0, 0],
      [10, 10, 0],
    ]);
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 10,
    });
    expect(out).toHaveLength(2);
  });

  it('returns an empty array for an empty cloud', () => {
    const out = localDensitySizes({
      positions: new Float32Array(0),
      cellSize: 1,
      referenceDensity: 10,
    });
    expect(out).toHaveLength(0);
  });

  it('a uniform-density cloud at the reference density gets scale = 1', () => {
    // Single cell containing 10 points → density = 10 pts/m². Reference
    // density = 10 → expected scale = 1.
    const positions = pack(Array.from({ length: 10 }, () => [0.5, 0.5, 0] as [number, number, number]));
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 10,
    });
    for (const v of out) {
      expect(v).toBeCloseTo(1, 5);
    }
  });

  it('sparse cells get a larger scale factor than dense ones', () => {
    // First 9 points in one cell (dense), 1 point far away in its own cell.
    const dense: [number, number, number][] = Array.from(
      { length: 9 },
      () => [0.1, 0.1, 0] as [number, number, number],
    );
    const sparse: [number, number, number] = [100, 100, 0];
    const positions = pack([...dense, sparse]);
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 10,
    });
    const denseScale = out[0];
    const sparseScale = out[9];
    expect(sparseScale).toBeGreaterThan(denseScale);
  });

  it('honours the minScale / maxScale caps', () => {
    // Massive density swing — without caps the scale would blow up.
    const dense: [number, number, number][] = Array.from(
      { length: 1000 },
      () => [0.5, 0.5, 0] as [number, number, number],
    );
    const sparse: [number, number, number] = [100, 100, 0];
    const positions = pack([...dense, sparse]);
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 10,
      minScale: 0.7,
      maxScale: 1.5,
    });
    // Float32 precision can produce values like 0.6999999... when the
    // clamp output is stored back through a Float32Array; allow a tiny
    // tolerance on both sides of the cap range.
    const tol = 1e-5;
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0.7 - tol);
      expect(v).toBeLessThanOrEqual(1.5 + tol);
    }
  });
});

describe('skyPresets — radial-gradient backgrounds', () => {
  it('exposes a definition for every preset in SKY_PRESET_ORDER', () => {
    for (const id of SKY_PRESET_ORDER) {
      const def = getSkyDefinition(id);
      expect(def.background.length).toBeGreaterThan(0);
      expect(def.fallbackColor).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
  });

  it('every definition uses a radial-gradient or a flat hex colour', () => {
    // v0.3.7 inspection / polish presets all use radial-gradient.
    // v0.3.8 added 'black' as a flat #000000 backdrop for hero shots
    // and chroma-key compositing; the assertion accepts either shape.
    for (const id of SKY_PRESET_ORDER) {
      const bg = getSkyDefinition(id).background;
      const ok = bg.includes('radial-gradient') || /^#[0-9a-fA-F]{3,8}$/.test(bg);
      expect(ok, `sky preset '${id}' has unrecognised background shape: ${bg}`).toBe(true);
    }
  });

  it('the catalogue has exactly ten presets (5 inspection + 4 v0.3.7 polish + 1 v0.3.8 black)', () => {
    expect(SKY_PRESET_ORDER).toHaveLength(10);
  });

  it('exposes the v0.3.7 polish presets — studio-dark / blueprint / survey-light / terrain', () => {
    expect(SKY_PRESET_ORDER).toContain('studio-dark');
    expect(SKY_PRESET_ORDER).toContain('blueprint');
    expect(SKY_PRESET_ORDER).toContain('survey-light');
    expect(SKY_PRESET_ORDER).toContain('terrain');
  });

  it('exposes the v0.3.8 Stream A black preset for hero shots', () => {
    expect(SKY_PRESET_ORDER).toContain('black');
    const def = getSkyDefinition('black');
    expect(def.fallbackColor).toBe('#000000');
    expect(def.background).toBe('#000000');
  });

  it('studio-dark falls back to the documented #0B0F14 colour', () => {
    expect(getSkyDefinition('studio-dark').fallbackColor).toBe('#0B0F14');
  });
});
