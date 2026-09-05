/**
 * The capture fingerprint may not be inferred from numbers whose unit is unknown.
 *
 * The signal builder scaled a raw extent by `unitFactor(...) ?? 1` — "treat the
 * source as metres". That factor produces the footprint area and the pts/m²
 * density, and those two figures are what the capture classifier reads to decide
 * whether a scan is phone, terrestrial, drone or aerial LiDAR, and then to attach
 * literature-derived accuracy expectations to that call. A local cloud in feet,
 * millimetres or arbitrary units was graded as though its numbers were metres,
 * and a confident capture type was asserted from it.
 *
 * There is no honest metric figure without a known unit, so the metric signals
 * are simply absent. The non-metric ones (format, point count, sensor string)
 * are unaffected — they never depended on a scale.
 */
import { describe, it, expect } from 'vitest';
import {
  signalsForStaticCloud,
  signalsForStreamingCloud,
} from '../src/diagnostics/provenanceSignals';

const BOUNDS = { min: [0, 0, 0] as const, max: [2000, 1600, 240] as const };

describe('static cloud signals', () => {
  it('states no extent or density when no unit is declared', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz', pointCount: 6_400_000, bounds: () => BOUNDS, metadata: {},
    });
    expect(s.extent).toBeUndefined();
    expect(s.densityPerSqM).toBeUndefined();
    // The unit-free facts survive: they never rested on a scale.
    expect(s.pointCount).toBe(6_400_000);
    expect(s.sourceFormat).toBe('laz');
  });

  it('states them when the unit IS declared', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz', pointCount: 6_400_000, bounds: () => BOUNDS,
      metadata: { crs: { linearUnitToMetres: 1 } },
    });
    expect(s.extent).toEqual([2000, 1600, 240]);
    expect(s.densityPerSqM).toBeCloseTo(2, 10);
  });

  it('converts a foot CRS rather than reading its numbers as metres', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz', pointCount: 6_400_000, bounds: () => BOUNDS,
      metadata: { crs: { linearUnitToMetres: 0.3048 } },
    });
    expect(s.extent![0]).toBeCloseTo(2000 * 0.3048, 9);
    // Denser in metres than in feet — the same points over a smaller real area.
    expect(s.densityPerSqM!).toBeGreaterThan(2);
  });

  it('the RESOLVED frame overrides the declaration, in both directions', () => {
    // The file declares metres; the user resolved to feet. The correction wins.
    const corrected = signalsForStaticCloud(
      { sourceFormat: 'laz', pointCount: 6_400_000, bounds: () => BOUNDS,
        metadata: { crs: { linearUnitToMetres: 1 } } },
      { metresPerUnit: 0.3048 },
    );
    expect(corrected.extent![0]).toBeCloseTo(2000 * 0.3048, 9);

    // The file declares metres; the user resolved to Local coordinates. A
    // resolved frame that states no unit is authoritative, NOT a reason to fall
    // back to the declaration it replaced.
    const localised = signalsForStaticCloud(
      { sourceFormat: 'laz', pointCount: 6_400_000, bounds: () => BOUNDS,
        metadata: { crs: { linearUnitToMetres: 1 } } },
      { metresPerUnit: null },
    );
    expect(localised.extent).toBeUndefined();
    expect(localised.densityPerSqM).toBeUndefined();
  });
});

describe('streaming cloud signals', () => {
  const bounds = (): readonly number[] => [0, 0, 0, 2000, 1600, 240];

  it('states no extent or density when no unit is declared', () => {
    const s = signalsForStreamingCloud({
      kind: 'copc', sourcePointCount: 6_400_000, dataBounds: bounds, crs: () => null,
    } as never);
    expect(s.extent).toBeUndefined();
    expect(s.densityPerSqM).toBeUndefined();
  });

  it('states them for a declared metre frame, and follows a resolved override', () => {
    const declared = signalsForStreamingCloud({
      kind: 'copc', sourcePointCount: 6_400_000, dataBounds: bounds,
      crs: () => ({ linearUnitToMetres: 1 }),
    } as never);
    expect(declared.densityPerSqM).toBeCloseTo(2, 10);

    const overridden = signalsForStreamingCloud(
      { kind: 'copc', sourcePointCount: 6_400_000, dataBounds: bounds,
        crs: () => ({ linearUnitToMetres: 1 }) } as never,
      { metresPerUnit: null },
    );
    expect(overridden.densityPerSqM).toBeUndefined();
  });
});
