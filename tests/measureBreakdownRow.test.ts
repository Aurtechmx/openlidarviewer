/**
 * measureBreakdownRow.test.ts — how a Distance or Area breakdown is worded.
 *
 * Two of these assertions guard claims rather than layout. A ring's plane area
 * must never be called a surface area, because nothing drapes over the ground
 * between the vertices. And under a compound CRS the run and the rise stay
 * exact while the slant, the plane area, the perimeter and the grade combine
 * two linear units, so the line has to say which is which instead of dropping
 * the honest figures or presenting the mixed ones unqualified.
 *
 * The formatters are injected, so these read the composition rather than the
 * number formatting, which `format.ts` already owns and tests.
 */

import { describe, it, expect } from 'vitest';
import { breakdownParts, type BreakdownFormatters } from '../src/ui/measureBreakdownRow';
import { lineBreakdown, areaBreakdown } from '../src/render/measure/measureBreakdown';
import type { Vec3 } from '../src/render/navMath';

const Z_UP: Vec3 = [0, 0, 1];

/** Formatters that label their input, so a test can see which value went where. */
const FMT: BreakdownFormatters = {
  formatLength: (m) => `${m.toFixed(2)}m`,
  formatArea: (m2) => `${m2.toFixed(2)}m2`,
  formatGrade: (p) => `${p.toFixed(1)}%`,
  formatAngle: (d) => `${d.toFixed(1)}deg`,
};

/** A 3-across, 4-up line. */
const line = (verticalToMetres = 1) =>
  lineBreakdown([0, 0, 0], [3, 0, 4], Z_UP, 1, verticalToMetres);

/** A flat 10 × 10 ring. */
const ring = (verticalToMetres = 1) =>
  areaBreakdown(
    [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ],
    Z_UP,
    1,
    verticalToMetres,
  );

describe('breakdownParts — a distance', () => {
  it('names the run, the rise, the slant and the grade', () => {
    const r = breakdownParts({ kind: 'distance', lineMetrics: line() }, 'metric', FMT);
    expect(r).not.toBeNull();
    expect(r!.text).toBe('Run 3.00m · Rise 4.00m · Slant 5.00m · Grade 133.3% (53.1deg)');
  });

  it('omits the grade for a vertical pair rather than printing infinity', () => {
    const vertical = lineBreakdown([0, 0, 0], [0, 0, 7], Z_UP, 1);
    const r = breakdownParts({ kind: 'distance', lineMetrics: vertical }, 'metric', FMT);
    expect(r!.text).toContain('Rise 7.00m');
    expect(r!.text).not.toContain('Grade');
    expect(r!.text).not.toMatch(/Infinity|NaN/);
  });

  it('explains a compound CRS instead of hiding the figures it does not break', () => {
    const r = breakdownParts({ kind: 'distance', lineMetrics: line(0.3048) }, 'metric', FMT);
    // The run and the rise are still shown: they are exact under a compound CRS.
    expect(r!.text).toContain('Run 3.00m');
    expect(r!.text).toContain('Rise 1.22m');
    // The slant and the grade come from the converted run and rise, so the
    // note no longer calls them unreliable.
    expect(r!.title).toMatch(/converted to metres before the slant and the grade/i);
    expect(r!.title).not.toMatch(/not reliable/i);
    // The headline distance is refused under a compound CRS, so the note sends
    // the reader to these figures.
    expect(r!.title).toMatch(/rather than the headline distance/);
  });

  it('does not warn about mixed units when there are none', () => {
    const r = breakdownParts({ kind: 'distance', lineMetrics: line() }, 'metric', FMT);
    expect(r!.title).not.toMatch(/not reliable/i);
  });
});

describe('breakdownParts — an area', () => {
  it('names the horizontal area, the plane area, the perimeter and the vertices', () => {
    const r = breakdownParts({ kind: 'area', areaMetrics: ring() }, 'metric', FMT);
    expect(r!.text).toBe('Horizontal 100.00m2 · Plane 100.00m2 · Perimeter 40.00m · 4 vertices');
  });

  it('never calls the ring plane a surface area', () => {
    const r = breakdownParts({ kind: 'area', areaMetrics: ring() }, 'metric', FMT);
    // The claim guard: nothing drapes over terrain between the vertices, so
    // "surface" would describe a quantity that was not computed.
    expect(r!.text).toContain('Plane');
    expect(r!.text.toLowerCase()).not.toContain('surface');
    expect(r!.title).toMatch(/not a terrain surface/i);
  });

  it('carries both notes when a compound CRS also applies', () => {
    const r = breakdownParts({ kind: 'area', areaMetrics: ring(0.3048) }, 'metric', FMT);
    expect(r!.title).toMatch(/not a terrain surface/i);
    expect(r!.title).toMatch(/different unit for height/i);
  });
});

describe('breakdownParts — measurements with no breakdown', () => {
  it('returns null when neither metric is present', () => {
    for (const kind of ['profile', 'volume', 'angle', 'box', 'height']) {
      expect(breakdownParts({ kind }, 'metric', FMT)).toBeNull();
    }
  });

  it('prefers the line metrics when a summary somehow carries both', () => {
    // Defensive: the controller populates exactly one, keyed on kind. If that
    // ever changed, a silently merged line would be worse than a stable choice.
    const r = breakdownParts(
      { kind: 'distance', lineMetrics: line(), areaMetrics: ring() },
      'metric',
      FMT,
    );
    expect(r!.text).toContain('Run');
    expect(r!.text).not.toContain('Perimeter');
  });
});

describe('one unit per breakdown line', () => {
  it('a 15.7 cm rise beside a 10.63 m run reads in metres, not centimetres', async () => {
    const f = await import('../src/render/measure/format');
    const line = lineBreakdown([0, 0, 0], [10.63, 0, 0.157], Z_UP, 1);
    const out = breakdownParts({ kind: 'distance', lineMetrics: line }, 'metric', {
      formatLength: f.formatLength,
      formatLengthInBandOf: f.formatLengthInBandOf,
      formatArea: f.formatArea,
      formatGrade: f.formatGrade,
      formatAngle: f.formatAngle,
    });
    expect(out!.text).toMatch(/Rise 0\.1570? m/);
    expect(out!.text).not.toMatch(/ cm\b/);
  });

  it('a short line stays in centimetres throughout', async () => {
    const f = await import('../src/render/measure/format');
    const line = lineBreakdown([0, 0, 0], [0.3, 0, 0.4], Z_UP, 1);
    const out = breakdownParts({ kind: 'distance', lineMetrics: line }, 'metric', {
      formatLength: f.formatLength,
      formatLengthInBandOf: f.formatLengthInBandOf,
      formatArea: f.formatArea,
      formatGrade: f.formatGrade,
      formatAngle: f.formatAngle,
    });
    expect(out!.text).toMatch(/Run 30\.0+ cm · Rise 40\.0+ cm · Slant 50\.0+ cm/);
  });
});
