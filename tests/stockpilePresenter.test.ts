import { describe, test, expect } from 'vitest';
import { presentStockpile, stockpileToastLine } from '../src/render/measure/stockpilePresenter';
import type { StockpileVolumeResult } from '../src/render/measure/stockpileVolume';

function result(over: Partial<StockpileVolumeResult> = {}): StockpileVolumeResult {
  return {
    volume: 1254,
    cut: 12,
    sigma: 41,
    low: 1213,
    high: 1295,
    relativeError: 0.0327,
    confidence: 'medium',
    densityUnitKnown: true,
    breakdown: {
      footprintArea: 318.4,
      pointsInPolygon: 4200,
      densityNative: 13.2,
      baseZ: 102.5,
      baseMode: 'lowest-percentile',
      baseUncertainty: 0.08,
      meanThickness: 3.94,
      thicknessStdDev: 1.1,
      samplingError: 18,
      basePlaneError: 25,
    },
    validity: 'ok',
    caveats: ['Point-sample estimate over a horizontal base plane.'],
    ...over,
  };
}

describe('presentStockpile', () => {
  test('headline carries the volume and its band, named as a model band', () => {
    // "± 41" alone reads as a hard bound; the presenter must say it is one
    // standard deviation.
    const v = presentStockpile(result());
    expect(v.headline).toBe('1,254 m³ ± 41 m³ (model band)');
    expect(v.relative).toBe('±3.3%');
    expect(v.confidence).toBe('medium');
    expect(v.confidenceLabel).toBe('Uneven sampling');
  });

  test('breakdown rows show the math (footprint, base, both error terms)', () => {
    const v = presentStockpile(result());
    const byLabel = Object.fromEntries(v.rows.map((r) => [r.label, r.value]));
    expect(byLabel['Footprint']).toBe('318.4 m²');
    expect(byLabel['Points in footprint']).toBe('4,200');
    expect(byLabel['Density']).toBe('13.2 pts/m²');
    expect(byLabel['Base plane']).toMatch(/lowest ground, ±0.08 m/);
    expect(byLabel['Sampling error']).toBe('± 18 m³');
    expect(byLabel['Base-plane error']).toBe('± 25 m³');
  });

  test('an unknown-unit result labels density honestly instead of claiming pts/m²', () => {
    const v = presentStockpile(result({ densityUnitKnown: false }));
    const density = v.rows.find((r) => r.label === 'Density')!.value;
    expect(density).toMatch(/unit unknown/);
    expect(density).not.toMatch(/pts\/m²/);
    // The native density is still surfaced, just not dressed as metres.
    expect(density).toMatch(/13\.2 pts\/unit²/);
  });

  test('an unknown-unit result flags the view and discloses on the toast', () => {
    // The headline still prints "m³" (like the space report keeps "m"), but the
    // toast — which renders no caveats — must carry the disclosure inline so a
    // bare "X m³" is never presented as a confirmed metric claim.
    const known = presentStockpile(result());
    expect(known.unitVerified).toBe(true);
    expect(stockpileToastLine(known)).not.toMatch(/units unverified/);

    const unknown = presentStockpile(result({ densityUnitKnown: false }));
    expect(unknown.unitVerified).toBe(false);
    expect(stockpileToastLine(unknown)).toBe(
      'Stockpile: 1,254 m³ ± 41 m³ (model band) (±3.3%) · Uneven sampling · units unverified (assumes metres)',
    );
  });

  test('a foot-CRS result converts to true metres (lin = 0.3048)', () => {
    // Same native figures, but in feet → volume in m³ is value × 0.3048³.
    const v = presentStockpile(result({ volume: 1000, sigma: 0 }), { lin: 0.3048 });
    // 1000 ft³ ≈ 28 m³.
    expect(v.headline).toBe('28 m³ ± 0 m³ (model band)');
  });

  test('explicit base reads "(set)", not "(lowest ground)"', () => {
    const v = presentStockpile(
      result({ breakdown: { ...result().breakdown, baseMode: 'explicit', baseUncertainty: 0 } }),
    );
    const base = v.rows.find((r) => r.label === 'Base plane')!.value;
    expect(base).toMatch(/\(set\)/);
    expect(base).not.toMatch(/lowest ground/);
  });

  test('toast line is a single readable summary', () => {
    expect(stockpileToastLine(presentStockpile(result()))).toBe(
      'Stockpile: 1,254 m³ ± 41 m³ (model band) (±3.3%) · Uneven sampling',
    );
  });

  test('caveats pass through verbatim', () => {
    const v = presentStockpile(result({ caveats: ['only 12 points — indicative'] }));
    expect(v.caveats).toEqual(['only 12 points — indicative']);
  });
});

/**
 * A compound CRS — metre eastings over US-survey-foot heights — needs two
 * factors. The presenter had only `lin` and scaled volume by lin³, so a
 * stockpile on a NAD83(2011) / NAVD88-foot site was overstated by 3.28×, and
 * base plane and mean thickness (both VERTICAL) were scaled by the horizontal
 * unit. `measurementExport` has used linear²·vertical for volume since the
 * vertical-unit pass; this path never got it.
 */
describe('presentStockpile — compound CRS vertical factor', () => {
  const US_FOOT = 1200 / 3937;

  test('volume uses linear squared times vertical, not linear cubed', () => {
    // 1254 native (m²·ft) → 1254 × 1 × 1 × 0.3048006 = 382.2 m³.
    const v = presentStockpile(result(), { lin: 1, vert: US_FOOT });
    expect(v.headline).toContain('382');
  });

  test('a single-unit CRS is unchanged when no vertical factor is given', () => {
    expect(presentStockpile(result(), { lin: 1 }).headline).toContain('1,254');
  });

  test('base plane and mean thickness use the VERTICAL factor', () => {
    const v = presentStockpile(result(), { lin: 1, vert: US_FOOT });
    const row = (label: string) => v.rows.find((r) => r.label === label)?.value ?? '';
    // 102.5 ft → 31.24 m; 3.94 ft → 1.20 m.
    expect(row('Base plane')).toContain('31.2');
    expect(row('Mean thickness')).toContain('1.20');
  });

  test('footprint area and density stay on the HORIZONTAL factor', () => {
    // Mixing the vertical factor into an area would be the mirror-image bug.
    const v = presentStockpile(result(), { lin: 1, vert: US_FOOT });
    const row = (label: string) => v.rows.find((r) => r.label === label)?.value ?? '';
    expect(row('Footprint')).toContain('318.4');
    expect(row('Density')).toContain('13.2');
  });

  test('the error bands scale with the same cubic factor as the volume', () => {
    const v = presentStockpile(result(), { lin: 1, vert: US_FOOT });
    const row = (label: string) => v.rows.find((r) => r.label === label)?.value ?? '';
    expect(row('Sampling error')).toContain('5'); // 18 × 0.3048 = 5.49
    expect(row('Base-plane error')).toContain('8'); // 25 × 0.3048 = 7.62
  });
});

/**
 * The words on screen stay inside what the register approves.
 *
 * The line read "± 41 m³ (1σ) · High confidence", which is the vocabulary of a
 * calibrated interval. VOL-STOCKPILE approves "Exploratory volume preview;
 * spatial correlation and base uncertainty unquantified" and prohibits a
 * "validated uncertainty interval": the sample term assumes independent
 * thickness observations where LiDAR returns are spatially correlated, and the
 * base term is a heuristic spread that is zero for an explicit base.
 */
describe('the stockpile line does not promise a coverage interval', () => {
  test('names the band as a model band and the grade as a sampling verdict', () => {
    const view = presentStockpile(result());
    expect(view.headline).not.toMatch(/1σ/);
    expect(view.headline).toContain('model band');
    expect(stockpileToastLine(view)).not.toMatch(/confidence/i);
    expect(stockpileToastLine(view)).toMatch(/sampling/i);
  });
});

// Area-weighted grid path (the live toast since v0.6.9).

import {
  presentStockpileAreaGrid,
  stockpileAreaGridToastLine,
  stockpileAuthority,
  stockpileToastSuffix,
} from '../src/render/measure/stockpilePresenter';
import { stockpileAreaGrid } from '../src/render/measure/stockpileAreaGrid';
import type { Vec3 } from '../src/render/navMath';

/** A 20 m × 10 m prism, `h` high over z = 0, sampled on a grid with the given step. */
function prism(h: number, stepX: number, stepY: number, xFrom = 0, xTo = 20): number[] {
  const out: number[] = [];
  for (let x = xFrom + stepX / 2; x < xTo; x += stepX) {
    for (let y = stepY / 2; y < 10; y += stepY) out.push(x, y, h);
  }
  return out;
}
const RECT: Vec3[] = [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]];
const complete = { sourceComplete: true, sampled: false, streaming: false };

describe('stockpileAuthority', () => {
  test('measured coverage on a complete, unsampled source is measured', () => {
    expect(stockpileAuthority('measured', complete)).toEqual({ authority: 'measured', reason: '' });
  });
  test('a streaming source short of full residency caps a measured coverage at preview', () => {
    expect(stockpileAuthority('measured', { sourceComplete: false, sampled: false, streaming: true }))
      .toEqual({ authority: 'preview', reason: 'source is streaming and not fully resident' });
  });
  test('an incomplete source with no streaming contribution says so plainly', () => {
    expect(stockpileAuthority('measured', { sourceComplete: false, sampled: false }))
      .toEqual({ authority: 'preview', reason: 'source not proven complete' });
  });
  test('a sampled source caps a measured coverage at preview', () => {
    expect(stockpileAuthority('measured', { sourceComplete: true, sampled: true }))
      .toEqual({ authority: 'preview', reason: 'display sample' });
  });
  test('refused coverage is withheld whatever the scope', () => {
    expect(stockpileAuthority('refused', complete).authority).toBe('withheld');
    expect(stockpileAuthority('refused', { sourceComplete: false, sampled: true }).authority).toBe('withheld');
  });
});

describe('presentStockpileAreaGrid', () => {
  test('a full prism is measured with the analytic volume', () => {
    const pts = Float32Array.from(prism(3, 0.5, 0.5));
    const v = presentStockpileAreaGrid(RECT, pts, { z: 0, uncertainty: 0.02 }, complete);
    expect(v.authority).toBe('measured');
    expect(v.coverage).toBe('measured');
    expect(v.volumeM3).toBeCloseTo(20 * 10 * 3, 6);
    expect(v.method).toBe('olv.volume.stockpile-area-grid@2');
    expect(v.supportFraction).toBeCloseTo(1, 6);
  });

  test('the figure equals the area-grid result times the CRS volume factor', () => {
    // Parity: the presenter adds nothing to the number; feet horizontally and
    // metres vertically give lin²·vert, never lin³.
    const pts = Float32Array.from(prism(3, 0.5, 0.5));
    const lin = 0.3048;
    const v = presentStockpileAreaGrid(RECT, pts, { z: 0, uncertainty: 0 }, complete, { lin, vert: 1 });
    const points = [];
    for (let i = 0; i < pts.length; i += 3) points.push({ x: pts[i], y: pts[i + 1], z: pts[i + 2] });
    const grid = stockpileAreaGrid({ points, polygon: RECT.map((p) => ({ x: p[0], y: p[1] })), base: { kind: 'constant', zM: 0 } });
    expect(v.volumeM3).toBeCloseTo(grid.fillM3 * lin * lin * 1, 9);
    expect(v.surfaceTermM3).toBeCloseTo(grid.surfaceTermM3 * lin * lin, 9);
  });

  test('a density gradient across the footprint does not move the figure', () => {
    // Ten times more points on the left half. The point-weighted estimator
    // would follow the density; the area-weighted one follows the geometry.
    const uniform = Float32Array.from(prism(3, 0.5, 0.5));
    const leftHeavy = Float32Array.from([...prism(3, 0.1, 0.25, 0, 10), ...prism(3, 0.5, 0.5, 10, 20)]);
    const a = presentStockpileAreaGrid(RECT, uniform, { z: 0, uncertainty: 0 }, complete);
    const b = presentStockpileAreaGrid(RECT, leftHeavy, { z: 0, uncertainty: 0 }, complete);
    expect(b.volumeM3).toBeCloseTo(a.volumeM3, 6);
    expect(b.authority).toBe('measured');
  });

  test('a missing half of the footprint withholds the figure', () => {
    const half = Float32Array.from(prism(3, 0.5, 0.5, 0, 9));
    const v = presentStockpileAreaGrid(RECT, half, { z: 0, uncertainty: 0 }, complete);
    expect(v.coverage).toBe('refused');
    expect(v.authority).toBe('withheld');
    expect(v.supportFraction).toBeLessThan(0.6);
  });

  test('a gap large enough for preview reads PREVIEW with its reason', () => {
    const most = Float32Array.from(prism(3, 0.5, 0.5, 0, 15));
    const v = presentStockpileAreaGrid(RECT, most, { z: 0, uncertainty: 0 }, complete);
    expect(v.coverage).toBe('preview');
    expect(v.authority).toBe('preview');
    expect(v.reason).toBe('footprint gaps');
  });
});

describe('stockpileAreaGridToastLine', () => {
  const base = { z: 0, uncertainty: 0.05 };
  test('a measured line names the state, the support and the method', () => {
    const pts = Float32Array.from(prism(3, 0.5, 0.5));
    const line = stockpileAreaGridToastLine(presentStockpileAreaGrid(RECT, pts, base, complete));
    expect(line).toMatch(/^Stockpile: 600 m³ · MEASURED · 100% footprint support · area-weighted grid/);
    expect(line).toMatch(/incomplete model/);
    expect(line).toMatch(/base 0\.00 m \(lowest ground, ±0\.05 m, not in the term\)/);
    expect(line).not.toMatch(/1σ|model band/);
  });
  test('a preview figure never appears without PREVIEW and its reason', () => {
    const pts = Float32Array.from(prism(3, 0.5, 0.5));
    const line = stockpileAreaGridToastLine(
      presentStockpileAreaGrid(RECT, pts, base, {
        sourceComplete: false,
        sampled: false,
        streaming: true,
      }),
    );
    expect(line).toMatch(/600 m³ · PREVIEW \(source is streaming and not fully resident\)/);
  });
  test('a withheld result shows no number', () => {
    const half = Float32Array.from(prism(3, 0.5, 0.5, 0, 9));
    const line = stockpileAreaGridToastLine(presentStockpileAreaGrid(RECT, half, base, complete));
    expect(line).toMatch(/^Stockpile: volume withheld · \d+% footprint support · insufficient observations$/);
    expect(line).not.toMatch(/m³/);
  });
  test('an unverified unit is disclosed on the line', () => {
    const pts = Float32Array.from(prism(3, 0.5, 0.5));
    const line = stockpileAreaGridToastLine(
      presentStockpileAreaGrid(RECT, pts, base, complete, { unitVerified: false }),
    );
    expect(line).toMatch(/units unverified \(assumes metres\)$/);
  });
});

describe('stockpileToastSuffix (area-grid)', () => {
  test('a complete prism yields a measured suffix over the lowest-ground base', () => {
    const pts = Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]);
    const suffix = stockpileToastSuffix(RECT, pts);
    expect(suffix).toMatch(/^ · Stockpile: \d[\d,]* m³ · MEASURED/);
  });
  test('a reduced source or a strided walk reads PREVIEW (display sample)', () => {
    const pts = Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]);
    expect(stockpileToastSuffix(RECT, pts, 1, { sourceReduced: true })).toMatch(/PREVIEW \(display sample\)/);
    expect(stockpileToastSuffix(RECT, pts, 1, { densityUnitKnown: true, vert: 1, walkSampled: true }))
      .toMatch(/PREVIEW \(display sample\)/);
  });
  test('a settled view over a partially resident streaming source is never MEASURED', () => {
    const pts = Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]);
    const suffix = stockpileToastSuffix(RECT, pts, 1, {
      streamingContributed: true,
      streamingCoverage: { knownNodeCount: 100, residentNodeCount: 5 },
    });
    expect(suffix).toMatch(/PREVIEW \(source is streaming and not fully resident\)/);
    expect(suffix).not.toMatch(/MEASURED/);
  });
  test('unknown streaming coverage is not evidence of completeness', () => {
    const pts = Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]);
    for (const streamingCoverage of [
      { knownNodeCount: null, residentNodeCount: 5 },
      null,
    ]) {
      expect(stockpileToastSuffix(RECT, pts, 1, { streamingContributed: true, streamingCoverage }))
        .toMatch(/PREVIEW \(source is streaming and not fully resident\)/);
    }
  });
  test('a fully resident streaming source reads MEASURED', () => {
    const pts = Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]);
    expect(stockpileToastSuffix(RECT, pts, 1, {
      streamingContributed: true,
      streamingCoverage: { knownNodeCount: 12, residentNodeCount: 12 },
    })).toMatch(/· MEASURED ·/);
  });
  test('a degenerate footprint or too few points yields nothing', () => {
    expect(stockpileToastSuffix(RECT.slice(0, 2), Float32Array.from(prism(3, 1, 1)))).toBe('');
    expect(stockpileToastSuffix(RECT, new Float32Array(6))).toBe('');
  });
});
