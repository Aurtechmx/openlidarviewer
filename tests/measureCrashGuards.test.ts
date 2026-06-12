/**
 * measureCrashGuards.test.ts — regression suite for the v0.4.5 measure-stack
 * crash audit (user report: many chained distance measurements on a local
 * no-CRS PLY, then the tab died).
 *
 * Every test here feeds a DEGENERATE input — non-finite unit factors,
 * zero-length segments, NaN/Infinity coordinates and chainages, denormal
 * spans, unknown kinds from forward-compat session files — into the pure
 * measure modules and asserts two things:
 *
 *   1. the call RETURNS (no throw, and — for the float-accumulator loops
 *      that used to be unbounded — no hang/OOM), and
 *   2. the output is the honest fallback ('—', a gap, factor 1, a bounded
 *      array), never NaN text or a fabricated number.
 *
 * The label-layout cases cover the only measure code that runs INSIDE the
 * per-frame render loop and scales with the number of placed measurements —
 * the chained-distance scenario — so they are the ones that pin "the render
 * loop is bounded by construction".
 */

import { describe, expect, test } from 'vitest';
import {
  formatLength,
  formatLengthRender,
  formatAreaRender,
  formatVolumeRender,
  formatGrade,
  formatBearing,
  formatProfileHeadline,
  formatBoxHeadline,
} from '../src/render/measure/format';
import {
  aggregate,
  formatChainResult,
  supportedDimensions,
  valueForDimension,
  type ChainDimension,
} from '../src/render/measure/measurementChains';
import {
  computeProfileSummary,
  profileStationRows,
  buildProfileCsv,
  profileSummaryRows,
  scaleProfileSamples,
  formatStation,
} from '../src/render/measure/profileSummary';
import { layoutLabels } from '../src/render/measure/labelLayout';
import { autoStationInterval, niceElevationTicks } from '../src/ui/MeasurePanel';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import type { Measurement, ProfileChartSample } from '../src/render/measure/types';

const m = (kind: Measurement['kind'], points: Array<[number, number, number]>): Measurement => ({
  id: `t-${kind}-${points.length}`,
  kind,
  name: kind,
  points,
});

describe('format.ts — render-unit formatters never emit NaN text or throw', () => {
  const BAD_FACTORS = [Number.NaN, 0, -3.2, Infinity, -Infinity, undefined as unknown as number];

  test('invalid unitToMetres factors fall back to 1 (the no-CRS contract)', () => {
    for (const f of BAD_FACTORS) {
      expect(formatLengthRender(10, f, 'metric')).toBe(formatLength(10, 'metric'));
      expect(formatAreaRender(10, f, 'metric')).toBe(formatAreaRender(10, 1, 'metric'));
      expect(formatVolumeRender(10, f, 'metric')).toBe(formatVolumeRender(10, 1, 'metric'));
    }
  });

  test('non-finite values render the honest em dash, both unit systems', () => {
    for (const sys of ['metric', 'imperial'] as const) {
      expect(formatLengthRender(Number.NaN, 1, sys)).toBe('—');
      expect(formatAreaRender(Number.NaN, 1, sys)).toBe('—');
      expect(formatVolumeRender(Number.NaN, 1, sys)).toBe('—');
      expect(formatLengthRender(Infinity, 1, sys)).toBe('—');
    }
  });

  test('zero-length / vertical degenerate headlines stay finite strings', () => {
    // A chained distance click on the SAME point twice: length 0, no bearing.
    expect(formatLengthRender(0, 1, 'metric')).toBe('0.0 cm');
    expect(formatBearing(Number.NaN)).toBe('—');
    // Vertical pair: grade is Infinity → the wording, never "Infinity%".
    expect(formatGrade(Infinity)).toBe('vertical');
    const headline = formatProfileHeadline(Number.NaN, Number.NaN, Infinity, 'metric');
    expect(headline).not.toMatch(/NaN|Infinity/);
    const box = formatBoxHeadline(Number.NaN, 0, 0, Number.NaN, 'imperial');
    expect(box).not.toMatch(/NaN|Infinity/);
  });
});

describe('measurementChains — degenerate selections aggregate to honest fallbacks', () => {
  test('zero-length and single-point measurements never poison an aggregate', () => {
    const sel: Measurement[] = [
      m('distance', [[0, 0, 0], [0, 0, 0]]), // zero length — legit 0
      m('distance', [[1, 1, 1]]), // half-placed — contributes nothing
      m('slope', [[0, 0, 0], [0, 0, 5]]), // vertical — Infinity grade, filtered
      m('distance', [[0, 0, 0], [3, 4, 0]]), // 5 m
    ];
    // Contributors: zero-length distance (0), the vertical slope's 3D
    // length (5), and the 3-4-5 distance (5). The half-placed row is skipped.
    const sum = aggregate(sel, 'sum', 'length');
    expect(sum.value).toBeCloseTo(10);
    expect(sum.contributingCount).toBe(3);
    const grade = aggregate(sel, 'max', 'grade');
    expect(Number.isFinite(grade.value) || Number.isNaN(grade.value)).toBe(true);
    expect(formatChainResult(grade)).not.toMatch(/Infinity|NaN/);
  });

  test('empty min/max renders the em dash, not "NaN m"', () => {
    const empty = aggregate([], 'min', 'length');
    expect(Number.isNaN(empty.value)).toBe(true);
    expect(formatChainResult(empty)).toBe('—');
  });

  test('garbage unit factor falls back to 1', () => {
    const sel = [m('distance', [[0, 0, 0], [3, 4, 0]])];
    for (const f of [Number.NaN, 0, -1, Infinity]) {
      expect(aggregate(sel, 'sum', 'length', [0, 0, 1], f).value).toBeCloseTo(5);
    }
  });

  test('unknown measurement kind (forward-compat session) cannot throw', () => {
    const alien = { ...m('distance', [[0, 0, 0], [1, 0, 0]]), kind: 'wormhole' } as unknown as Measurement;
    expect(() => supportedDimensions([alien])).not.toThrow();
    expect(supportedDimensions([alien])).toEqual([]);
    for (const dim of [
      'length', 'area', 'volume-fill', 'volume-cut', 'volume-net', 'height', 'angle', 'grade',
    ] as ChainDimension[]) {
      expect(valueForDimension(alien, dim)).toBeNull();
    }
    const res = aggregate([alien], 'sum', 'length');
    expect(res.contributingCount).toBe(0);
    expect(formatChainResult(res)).not.toMatch(/NaN/);
  });

  test('unknown dimension string from an embed caller stays finite', () => {
    const sel = [m('distance', [[0, 0, 0], [3, 4, 0]])];
    const res = aggregate(sel, 'sum', 'parsecs' as unknown as ChainDimension, [0, 0, 1], 3.28);
    expect(() => formatChainResult(res)).not.toThrow();
    expect(Number.isNaN(res.value) || Number.isFinite(res.value)).toBe(true);
  });
});

describe('profileSummary — zero-length segments, gaps, and missing counts', () => {
  test('duplicate stations (zero run) contribute no grade and no Infinity', () => {
    const samples: ProfileChartSample[] = [
      { distance: 0, height: 10 },
      { distance: 0, height: 12 }, // duplicate chainage — division by zero risk
      { distance: 5, height: Number.NaN }, // honest gap
      { distance: 10, height: 11 },
    ];
    const s = computeProfileSummary(samples);
    expect(Number.isFinite(s.lengthM)).toBe(true);
    for (const row of profileSummaryRows(s, 'metric')) {
      expect(row.value).not.toMatch(/NaN|Infinity/);
    }
    const rows = profileStationRows(samples, 'metric');
    expect(rows).toHaveLength(4);
    expect(rows[0].grade).toBe(''); // zero-run pair: blank, not Infinity
    expect(rows[1].grade).toBe(''); // gap neighbour: blank
    expect(rows[2].elevation).toBe(''); // gap: blank elevation
    expect(rows[0].points).toBe(''); // pre-v0.4.5 series: no fabricated 0
    const csv = buildProfileCsv(samples, 'imperial');
    expect(csv).not.toMatch(/NaN|Infinity/);
    expect(csv.trim().split('\n')).toHaveLength(5); // header + 4 stations
  });

  test('all-NaN and empty series produce nulls, never zeros', () => {
    const s = computeProfileSummary([
      { distance: 0, height: Number.NaN },
      { distance: 1, height: Number.NaN },
    ]);
    expect(s.gainM).toBeNull();
    expect(s.lossM).toBeNull();
    expect(s.averageGrade).toBeNull();
    expect(s.highest).toBeNull();
    const empty = computeProfileSummary([]);
    expect(empty.lengthM).toBe(0);
    expect(empty.coverage).toBe(0);
  });

  test('scaleProfileSamples ignores garbage factors and keeps gaps/counts', () => {
    const samples: ProfileChartSample[] = [
      { distance: 0, height: 1, count: 7 },
      { distance: 2, height: Number.NaN },
    ];
    for (const f of [Number.NaN, 0, -2, Infinity]) {
      const out = scaleProfileSamples(samples, f);
      expect(out[0].distance).toBe(0);
      expect(out[0].height).toBe(1);
      expect(out[0].count).toBe(7);
      expect(Number.isNaN(out[1].height)).toBe(true);
      expect(out[1].count).toBeUndefined();
    }
  });

  test('formatStation guards non-finite chainage in both conventions', () => {
    expect(formatStation(Number.NaN, 'metric')).toBe('—');
    expect(formatStation(Infinity, 'imperial')).toBe('—');
  });
});

describe('labelLayout — the per-frame collision loop is bounded by construction', () => {
  test('hundreds of identically-anchored labels (chained distances viewed end-on) resolve fast', () => {
    // The chained-measurement worst case: every label projects to the same
    // pixel. Before the v0.4.5 strict-progress + pass-cap hardening this was
    // the unbounded path inside the render loop.
    const boxes = Array.from({ length: 400 }, () => ({ x: 100, y: 50, width: 80, height: 16 }));
    const t0 = Date.now();
    const placed = layoutLabels(boxes);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(placed).toHaveLength(400);
    for (const p of placed) expect(Number.isFinite(p.y)).toBe(true);
  });

  test('non-finite anchors (vertex projected at the camera plane) cannot stall or poison the layout', () => {
    const boxes = [
      { x: Number.NaN, y: Number.NaN, width: 60, height: 16 },
      { x: Infinity, y: -Infinity, width: 60, height: 16 },
      { x: 10, y: 10, width: 60, height: 16 },
      { x: 10, y: 10, width: 60, height: 16 },
    ];
    const placed = layoutLabels(boxes);
    expect(placed).toHaveLength(4);
    // The two finite labels still de-overlap…
    expect(placed[3].y).toBeGreaterThan(placed[2].y);
    // …and every slot is populated (no holes from the degenerate boxes).
    for (const p of placed) expect(p).toBeDefined();
  });

  test('sub-pixel stacked anchors make strict progress (float-boundary stall guard)', () => {
    const boxes = Array.from({ length: 64 }, (_, i) => ({
      x: 50,
      y: 100 + i * 1e-7,
      width: 40,
      height: 15,
    }));
    const placed = layoutLabels(boxes);
    const ys = placed.map((p) => p.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
  });
});

describe('MeasurePanel pure helpers — tick/station walks terminate on degenerate spans', () => {
  test('niceElevationTicks: denormal span no longer loops forever (step underflow → 0)', () => {
    // 5e-324 is the smallest denormal; span/4 underflows the magnitude to 0,
    // which made `step` 0 and the push loop infinite before the guard.
    const ticks = niceElevationTicks(0, 5e-324);
    expect(ticks.length).toBeLessThanOrEqual(64);
    expect(ticks.length).toBeGreaterThan(0);
  });

  test('niceElevationTicks: huge spans stay bounded and finite', () => {
    const ticks = niceElevationTicks(-Number.MAX_VALUE / 2, Number.MAX_VALUE / 2);
    expect(ticks.length).toBeLessThanOrEqual(64);
  });

  test('autoStationInterval: non-finite / non-positive chainage falls back to 1', () => {
    expect(autoStationInterval(Number.NaN)).toBe(1);
    expect(autoStationInterval(Infinity)).toBe(1);
    expect(autoStationInterval(0)).toBe(1);
    expect(autoStationInterval(-5)).toBe(1);
  });
});

describe('profilePdf — corrupt samples cannot hang the export', () => {
  test('an Infinity chainage takes the "nothing to plot" branch and still returns bytes', async () => {
    const samples: ProfileChartSample[] = [
      { distance: 0, height: 10 },
      { distance: Infinity, height: 11 }, // corrupt — len becomes Infinity
    ];
    const bytes = await buildProfilePdf({ name: 'corrupt', samples });
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 15000);

  test('a NaN-only series exports the honest empty sheet', async () => {
    const samples: ProfileChartSample[] = [
      { distance: 0, height: Number.NaN },
      { distance: 4, height: Number.NaN },
    ];
    const bytes = await buildProfilePdf({ name: 'gaps', samples, unitSystem: 'imperial' });
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 15000);
});
