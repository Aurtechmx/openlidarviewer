/**
 * provenanceSignals.test.ts
 *
 * Regression net for the two field-shape bugs that left the Inspector's
 * Provenance section stuck on its empty-state placeholder after a real LAS
 * load:
 *
 *   1. `PointCloud.bounds` is a method, not a property. Reading it as a
 *      property got the function reference, then `.max[0]` threw TypeError,
 *      and the post-load try/catch swallowed it.
 *   2. `CloudMetadata` uses `captureSensor` / `sourceSoftware`. The signal
 *      helper used to read `sensorString` / `softwareString`, so the
 *      classifier never saw the LAS VLR strings.
 */

import { describe, it, expect } from 'vitest';
import {
  signalsForStaticCloud,
  signalsForStreamingCloud,
} from '../src/diagnostics/provenanceSignals';
import { classify } from '../src/diagnostics/provenance';

describe('signalsForStaticCloud — bounds is a method', () => {
  it('calls bounds() and computes a finite extent', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 1_000_000,
      bounds: () => ({
        min: [0, 0, 0],
        max: [100, 200, 30],
      }),
    });
    expect(s.extent).toEqual([100, 200, 30]);
    // density = 1_000_000 / (100 * 200) = 50 pts/m²
    expect(s.densityPerSqM).toBe(50);
  });

  it('survives a throwing bounds() without losing the rest of the payload', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 5_000,
      bounds: () => {
        throw new Error('bounds blew up');
      },
    });
    // Extent missing, density missing — but no exception escaped.
    expect(s.extent).toBeUndefined();
    expect(s.densityPerSqM).toBeUndefined();
    expect(s.sourceFormat).toBe('laz');
    expect(s.pointCount).toBe(5_000);
  });

  it('handles a cloud without bounds() (mid-load, pre-bounds-computation)', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'ply',
      pointCount: 100,
    });
    expect(s.extent).toBeUndefined();
    expect(s.densityPerSqM).toBeUndefined();
  });

  it('converts a foot-CRS extent + density to metres / pts·m⁻² for the classifier', () => {
    const FT = 0.3048;
    const s = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 1_000_000,
      bounds: () => ({ min: [0, 0, 0], max: [100, 200, 30] }), // feet
      metadata: { crs: { linearUnitToMetres: FT } },
    });
    // Extent → metres; density graded against pts/m² thresholds, not pts/ft².
    expect(s.extent![0]).toBeCloseTo(100 * FT, 6);
    expect(s.extent![1]).toBeCloseTo(200 * FT, 6);
    expect(s.densityPerSqM).toBeCloseTo(1_000_000 / (100 * FT * (200 * FT)), 4);
  });

  it('leaves a metre-CRS (or unit-less) extent unchanged', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 1_000_000,
      bounds: () => ({ min: [0, 0, 0], max: [100, 200, 30] }),
      metadata: { crs: { linearUnitToMetres: 1 } },
    });
    expect(s.extent).toEqual([100, 200, 30]);
    expect(s.densityPerSqM).toBe(50);
  });

  it('uses the declared file total for density + count when the cloud was strided', () => {
    // Loader strided 9.6M → 3.7M for display; the capture-type density must
    // describe the file (≈ 979 pts/m²), not the rendered subset (≈ 379).
    const s = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 3_714_345,
      declaredPointCount: 9_597_830,
      bounds: () => ({ min: [0, 0, 0], max: [78.8, 124.4, 18.9] }),
    });
    expect(s.pointCount).toBe(9_597_830);
    // 9_597_830 / (78.8 * 124.4) ≈ 979, not the strided ≈ 379
    expect(s.densityPerSqM!).toBeGreaterThan(900);
    expect(s.densityPerSqM!).toBeLessThan(1050);
  });
});

describe('signalsForStaticCloud — CloudMetadata field names', () => {
  it('reads captureSensor and sourceSoftware from CloudMetadata', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 1,
      metadata: {
        captureSensor: 'RIEGL VZ-2000i',
        sourceSoftware: 'Leica Cyclone 2024',
      },
    });
    expect(s.sensorString).toBe('RIEGL VZ-2000i');
    expect(s.softwareString).toBe('Leica Cyclone 2024');
  });

  it('reaches a high-confidence classifier verdict via captureSensor', () => {
    const signals = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 1,
      metadata: { captureSensor: 'FARO Focus M70' },
    });
    const f = classify(signals);
    expect(f.captureType).toBe('terrestrial');
    expect(f.confidence).toBe('high');
  });

  it('reaches a high-confidence classifier verdict via sourceSoftware', () => {
    const signals = signalsForStaticCloud({
      sourceFormat: 'ply',
      pointCount: 1,
      metadata: { sourceSoftware: 'Polycam 4.1.0' },
    });
    const f = classify(signals);
    expect(f.captureType).toBe('iphone-lidar');
    expect(f.confidence).toBe('high');
  });
});

describe('signalsForStreamingCloud', () => {
  it('extracts extent + density from localBounds for a COPC stream', () => {
    const s = signalsForStreamingCloud({
      kind: 'copc',
      sourcePointCount: 4_000_000,
      localBounds: () => [0, 0, 0, 200, 200, 50],
    });
    expect(s.sourceFormat).toBe('copc');
    expect(s.extent).toEqual([200, 200, 50]);
    expect(s.densityPerSqM).toBe(100); // 4M / (200*200)
    expect(s.streamingSource).toBe(true);
  });

  it('tags an EPT stream with sourceFormat=ept', () => {
    const s = signalsForStreamingCloud({
      kind: 'ept',
      sourcePointCount: 0,
    });
    expect(s.sourceFormat).toBe('ept');
    expect(s.streamingSource).toBe(true);
  });

  it('survives a throwing localBounds() without losing the rest of the payload', () => {
    const s = signalsForStreamingCloud({
      kind: 'copc',
      sourcePointCount: 1_000,
      localBounds: () => {
        throw new Error('localBounds blew up');
      },
    });
    expect(s.extent).toBeUndefined();
    expect(s.densityPerSqM).toBeUndefined();
    expect(s.streamingSource).toBe(true);
    expect(s.pointCount).toBe(1_000);
  });

  it('reaches an aerial-ALS verdict for a streaming source by format default', () => {
    const signals = signalsForStreamingCloud({
      kind: 'copc',
      sourcePointCount: 0,
    });
    const f = classify(signals);
    // The classifier's format-driven fallback for streaming COPC/EPT.
    expect(f.captureType).toBe('aerial-als');
  });
});
