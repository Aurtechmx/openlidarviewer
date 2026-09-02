/**
 * provenanceStatedBases.test.ts
 *
 * Pins the wording of the airborne-ALS literature bounds and the precision of
 * the density Signals lines:
 *   - the RMSEz bound states the USGS requirement (RMSEz ≤ 10 cm, NVA ≤ 19.6 cm)
 *     and cites the USGS Lidar Base Specification alongside Lohani & Ghosh;
 *   - the viewer's own hold-out statement lives in the disclaimer, not in a
 *     row attributed to a paper;
 *   - every density Signals line prints 1 dp density and 1 dp hectares, matching
 *     the report summary.
 */
import { describe, it, expect } from 'vitest';
import { classify } from '../src/diagnostics/provenance';

const bound = (fp: { bounds: readonly { label: string; value: string; source: string }[] }, label: string) =>
  fp.bounds.find((b) => b.label === label);

describe('aerial-ALS bounds state the USGS requirement and its source', () => {
  const fp = classify({
    sourceFormat: 'copc',
    pointCount: 20_000_000,
    extent: [1000, 1000, 200],
    densityPerSqM: 20,
  });

  it('classifies the fixture as airborne', () => {
    expect(fp.captureType).toBe('aerial-als');
  });

  it('states RMSEz as the required bound with the NVA equivalent', () => {
    const b = bound(fp, 'Vertical accuracy (RMSEz)');
    expect(b?.value).toBe('RMSEz ≤ 10 cm required (NVA ≤ 19.6 cm) for QL1 and QL2 deliveries');
    expect(b?.source).toContain('USGS Lidar Base Specification');
    expect(b?.source).toContain('Lohani & Ghosh 2017 §6');
  });

  it('keeps the NVA formula row cited to the specification, without the viewer statement', () => {
    const b = bound(fp, 'NVA formula');
    expect(b?.value).toBe('NVA = 1.96 × RMSEz (non-vegetated, normal distribution)');
    expect(b?.source).toBe('USGS Lidar Base Specification');
    expect(b?.value).not.toMatch(/viewer|hold-out/i);
  });

  it('puts the hold-out statement in the disclaimer', () => {
    expect(fp.disclaimer).toContain('not guarantees');
    expect(fp.disclaimer).toContain('hold-out');
    expect(fp.disclaimer).toContain('not independent checkpoints');
    expect(fp.bounds.every((b) => !/NVA-STYLE/i.test(b.value))).toBe(true);
  });
});

describe('density Signals lines use 1 dp density and 1 dp hectares', () => {
  it('drone', () => {
    const fp = classify({
      sourceFormat: 'laz', pointCount: 9_597_830, extent: [78.8, 124.4, 18.9], densityPerSqM: 978.94,
    });
    expect(fp.captureType).toBe('drone-lidar');
    expect(fp.signals[0]).toBe('Density: 978.9 pts/m² over a 1.0 ha bounding-box mapping footprint');
  });

  it('phone', () => {
    const fp = classify({
      sourceFormat: 'ply', pointCount: 500_000, extent: [10, 10, 3], densityPerSqM: 5000.04,
    });
    expect(fp.captureType).toBe('iphone-lidar');
    expect(fp.signals[0]).toBe('Density: 5000.0 pts/m² over a 100 m² bounding-box footprint');
  });

  it('terrestrial (station in a small room)', () => {
    const fp = classify({
      sourceFormat: 'e57', pointCount: 500_000, extent: [5, 4.54, 3], densityPerSqM: 20473.25,
    });
    expect(fp.captureType).toBe('terrestrial');
    expect(fp.signals[0]).toBe('Density: 20473.3 pts/m² over a 23 m² bounding-box footprint');
  });

  it('terrestrial (station scale, millions of points)', () => {
    const fp = classify({
      sourceFormat: 'e57', pointCount: 3_000_000, extent: [30, 40, 15], densityPerSqM: 400.04,
    });
    expect(fp.captureType).toBe('terrestrial');
    expect(fp.signals[0]).toBe('Density: 400.0 pts/m² with 3,000,000 points');
  });
});
