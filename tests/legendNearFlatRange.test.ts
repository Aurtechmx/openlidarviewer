/**
 * A colour range only a few float64 steps wide (a "flat" surface whose
 * heights differ by rounding dust, e.g. 1500 and 1500.0000000000002) must
 * still produce a legend. The tick walk used to stop advancing once the
 * step fell below the precision of the values, and never returned.
 */
import { describe, it, expect } from 'vitest';
import { niceTicks } from '../src/render/colorbar';
import { buildLegendRampSvg } from '../src/ui/legendRampSvg';
import { loadXyz } from '../src/io/loadXyz';
import { rampRangeForMode, defaultMode } from '../src/render/colorModes';
import { buildActiveColorbarSpec } from '../src/render/activeColorbar';

describe('legend ticks on a near-flat range', () => {
  it('returns the two bounds when the range is too narrow to tick', () => {
    const ticks = niceTicks(1500, 1500.0000000000002, 5);
    expect(ticks).toEqual([1500, 1500.0000000000002]);
  }, 2000);

  it('stays bounded for a span of a few units in the last place at several magnitudes', () => {
    for (const base of [100, 1500, 8848, 250000]) {
      for (const k of [1, 2, 3, 4, 8]) {
        let hi = base;
        for (let i = 0; i < k; i++) hi += Number.EPSILON * Math.abs(hi) * 0.5000001;
        const ticks = niceTicks(base, hi, 5);
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.length).toBeLessThanOrEqual(64);
        // Within a few units in the last place of the bounds.
        const tol = 8 * Number.EPSILON * Math.abs(hi);
        for (const t of ticks) {
          expect(t).toBeGreaterThanOrEqual(base - tol);
          expect(t).toBeLessThanOrEqual(hi + tol);
        }
      }
    }
  }, 2000);

  it('keeps ordinary narrow ranges unchanged', () => {
    const ticks = niceTicks(1500, 1500.0000001, 5);
    expect(ticks).toHaveLength(6);
  });

  it('builds the on-screen legend for an XYZ file whose heights differ by rounding dust', async () => {
    const zs = ['1500', '1500', '1500', '1500.0000000000002'];
    const text = zs.map((z, i) => `${i} ${i % 2} ${z}`).join('\n') + '\n';
    const cloud = await loadXyz(new TextEncoder().encode(text).buffer as ArrayBuffer, 'flat.xyz');
    const mode = defaultMode(cloud);
    expect(mode).toBe('elevation');
    const r = rampRangeForMode(mode, cloud, { heightPercentileTrim: 5, upAxis: 2 })!;
    const range = { min: r.min + cloud.sourceOrigin[2], max: r.max + cloud.sourceOrigin[2] };
    const active = buildActiveColorbarSpec({ mode, range, trimPercent: 5, elevationUnit: 'm' });
    expect(active).not.toBeNull();
    const svg = buildLegendRampSvg(active!.spec, null, 'Elevation');
    expect(svg).toContain('<svg');
    expect((svg.match(/<text /g) ?? []).length).toBeLessThanOrEqual(64);
  }, 2000);

  it('builds the legend SVG for the exact near-flat bounds', () => {
    const svg = buildLegendRampSvg(
      { palette: 'viridis', min: 1500, max: 1500.0000000000002, label: 'Elevation', unit: 'm' },
      null,
      'Elevation',
    );
    expect(svg).toContain('<svg');
  }, 2000);
});
