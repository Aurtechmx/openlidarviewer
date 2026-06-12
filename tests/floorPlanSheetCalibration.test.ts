/**
 * floorPlanSheetCalibration.test.ts — "make the readings more like an actual
 * floor plan" (sheet calibration, v0.4.5b).
 *
 * Three conventions pinned against synthetic rooms with hand-computed truth:
 *
 *   1. FLOOR AREA ON THE SHEET comes from the scanned-floor presence mask
 *      (the floor-fill polygon's own region) — never the bbox product. An
 *      L-shaped room (10 × 8 bbox, 68 m² actual) must print ~68, not 80.
 *   2. WALL POCHÉ reads at a realistic thickness: the RENDERED wall rounds up
 *      to the 0.10 m architectural minimum (a stud wall is ≥ ~0.09 m; the
 *      trace's 5 cm cell-floor strip reads toy-like), while the MEASURED
 *      value stays in the footer.
 *   3. DIMENSION LINES (architectural convention): overall width above the
 *      plan and depth on its left, with extension lines and 45° ticks.
 */

import { describe, it, expect } from 'vitest';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg, MIN_WALL_RENDER_M } from '../src/terrain/space/floorplan/floorPlanSvg';

const STEP = 0.05;

/** A z-up 10 × 8 × 2.5 m room sampled at 5 cm. */
function rectRoom(): Float32Array {
  const W = 10, D = 8, H = 2.5;
  const t: number[] = [];
  for (let x = 0; x <= W + 1e-9; x += STEP)
    for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, 0);
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (let x = 0; x <= W + 1e-9; x += STEP) { t.push(x, 0, z); t.push(x, D, z); }
    for (let y = STEP; y < D - 1e-9; y += STEP) { t.push(0, y, z); t.push(W, y, z); }
  }
  return Float32Array.from(t);
}

/** An L-shaped room: 10 × 8 outline minus the [6,10] × [5,8] notch (68 m²). */
function lRoom(): Float32Array {
  const H = 2.5;
  const t: number[] = [];
  const inL = (x: number, y: number): boolean => y <= 5 + 1e-9 || x <= 6 + 1e-9;
  for (let x = 0; x <= 10 + 1e-9; x += STEP)
    for (let y = 0; y <= 8 + 1e-9; y += STEP) if (inL(x, y)) t.push(x, y, 0);
  const runs: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 0, 10, 0], [10, 0, 10, 5], [6, 5, 10, 5], [6, 5, 6, 8], [0, 8, 6, 8], [0, 0, 0, 8],
  ];
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (const [x1, y1, x2, y2] of runs) {
      const n = Math.round(Math.hypot(x2 - x1, y2 - y1) / STEP);
      for (let k = 0; k <= n; k++) t.push(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n, z);
    }
  }
  return Float32Array.from(t);
}

describe('sheet floor area — floor-fill region, never the bbox', () => {
  const model = extractFloorPlan(lRoom(), { upAxis: 'z' });
  const svg = floorPlanSvg(model, { title: 'L', unitSystem: 'metric' });

  it('prints the floor area on the dims line, from the floor mask', () => {
    expect(model.floorAreaM2).not.toBeNull();
    const printed = svg.match(/Floor area (\d+\.\d) m²/);
    expect(printed).not.toBeNull();
    expect(Number((printed as RegExpMatchArray)[1])).toBeCloseTo(model.floorAreaM2 as number, 1);
  });

  it('the printed area is the L (≈68 m²), NOT the 10 × 8 bbox (80 m²)', () => {
    const printed = Number((svg.match(/Floor area (\d+\.\d) m²/) as RegExpMatchArray)[1]);
    expect(printed).toBeGreaterThan(68 * 0.97);
    expect(printed).toBeLessThan(68 * 1.03);
    expect(svg).not.toMatch(/Floor area 80\.\d m²/);
  });

  it('flips to sq-ft-first under the imperial unit system', () => {
    const imp = floorPlanSvg(model, { unitSystem: 'imperial' });
    expect(imp).toMatch(/Floor area \d+ sq ft \(\d+\.\d m²\)/);
  });
});

describe('wall poché — rendered thickness rounds up to the 0.10 m minimum', () => {
  const model = extractFloorPlan(rectRoom(), { upAxis: 'z' });
  const svg = floorPlanSvg(model, { title: 'rect', unitSystem: 'metric' });

  it('the traced wall strip is the toy-like cell floor (~5 cm) on this scan', () => {
    expect(model.wallThicknessM).not.toBeNull();
    expect(model.wallThicknessM as number).toBeLessThan(MIN_WALL_RENDER_M);
  });

  it('the rendered poché (strip + symmetric stroke) reads ≥ 0.10 m on the sheet', () => {
    // Recover the sheet scale from the scale bar (px width / labelled metres),
    // then check measured strip + stroke ≥ the architectural minimum.
    const bar = svg.match(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="6"/);
    const barLabel = svg.match(/>(\d+) m<\/text>/);
    expect(bar && barLabel).toBeTruthy();
    const scale =
      Number((bar as RegExpMatchArray)[1]) / Number((barLabel as RegExpMatchArray)[1]);
    const stroke = svg.match(/fill="#111111" stroke="#111111" stroke-width="([\d.]+)"/);
    expect(stroke).not.toBeNull();
    const renderedM =
      (model.wallThicknessM as number) + Number((stroke as RegExpMatchArray)[1]) / scale;
    expect(renderedM).toBeGreaterThanOrEqual(MIN_WALL_RENDER_M * 0.98);
  });

  it('keeps the MEASURED thickness in the footer via the honest rounding note', () => {
    expect(svg).toMatch(/Wall poché drawn at the 0\.10 m architectural minimum/);
    expect(svg).toMatch(/measured thickness ~0\.0\d m/);
    // The note carries the model's own measured value, not a fabricated one.
    expect(svg).toContain(`~${(model.wallThicknessM as number).toFixed(2)} m`);
  });
});

describe('dimension lines — architectural overall W × D with extension ticks', () => {
  const model = extractFloorPlan(rectRoom(), { upAxis: 'z' });
  const svg = floorPlanSvg(model, { title: 'rect', unitSystem: 'metric' });

  it('draws the dimension group with extension lines and 45° ticks', () => {
    expect(svg).toContain('class="plan-dims"');
    const dims = svg.match(/<g class="plan-dims"><path d="([^"]+)"/);
    expect(dims).not.toBeNull();
    // 2 dim lines + 4 extension lines + 4 ticks = 10 subpath moves.
    const moves = ((dims as RegExpMatchArray)[1].match(/M/g) ?? []).length;
    expect(moves).toBe(10);
  });

  it('labels the width on the line and the depth rotated along its line', () => {
    expect(svg).toMatch(/text-anchor="middle"[^>]*>10\.0 m \(32\.8 ft\)</);
    expect(svg).toMatch(/transform="rotate\(-90 [\d. ]+\)">8\.0 m \(26\.2 ft\)</);
  });

  it('draws no dimension lines on the honest empty sheet', () => {
    const empty = extractFloorPlan(Float32Array.from([0, 0, 0, 1, 1, 1]), { upAxis: 'z' });
    const svg2 = floorPlanSvg(empty, { title: 'Empty' });
    expect(svg2).not.toContain('class="plan-dims"');
    expect(svg2).not.toContain('Floor area');
  });
});
