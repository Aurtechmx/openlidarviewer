/**
 * watershedGif.test.ts — the watershed animation, decoded and read back.
 *
 * A synthetic valley is routed with D8, rendered with a stub text rasteriser,
 * encoded, and decoded by the test's own GIF reader. Pinned: the frame count
 * and delays; that frame k colours a cell exactly when its D8 flow length is at
 * most L_k, with the colour index set by that length; north up; NoData dotted;
 * cells outside the catchment darker; the final frame holds the whole
 * catchment; the page stays within 1000 px, merging cells when it must; and
 * the captions say flow length, not time, and carry the lower bound, the peak
 * flow and the north statement.
 */
import { describe, expect, it } from 'vitest';
import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { flowLengthToOutlet } from '../src/simulation/flowPulse/flowLength';
import { peakFlowEstimate } from '../src/simulation/flowPulse/rationalDischarge';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import {
  GIF_MAX_SIDE, GREY_BASE, GREY_LEVELS, HOLD_DELAY_CS, IX, REVEAL_DELAY_CS, VIRIDIS_BASE, VIRIDIS_LEVELS,
  diffRect, formatLength, niceLength, niceTicks, northLabel, planWatershedGif, renderWatershedGif,
  revealThresholds, viridisIndex, watershedCaption, watershedPalette,
  type TextRasterizer, type WatershedFacts, type WatershedGifInput,
} from '../src/export/watershedGif';
import { rgbToLab } from '../src/ui/fieldSimulation/labColormaps';
import { decodeGif } from './helpers/gifDecoder';

/** Text as solid boxes, 0.6 em per character, and a record of every string drawn. */
function stubRaster(): TextRasterizer & { drawn: string[] } {
  const drawn: string[] = [];
  return {
    drawn,
    measure: (t, px) => Math.ceil(t.length * px * 0.6),
    mask: (t, px) => {
      drawn.push(t);
      const width = Math.max(1, Math.ceil(t.length * px * 0.6)), height = Math.ceil(px * 1.35);
      return { width, height, alpha: new Uint8Array(width * height).fill(255) };
    },
  };
}

/** A valley falling south along column `mid`, walls falling towards it; NoData in one corner. */
function valley(cols: number, rows: number, cell = 2): FlowGrid {
  const z = new Float32Array(cols * rows), valid = new Uint8Array(cols * rows).fill(1);
  const mid = Math.floor(cols / 2);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = r * 1 + Math.abs(c - mid) * 0.5;
  for (const [c, r] of [[0, rows - 1], [1, rows - 1], [0, rows - 2]]) valid[r! * cols + c!] = 0;
  return { z, valid, cols, rows, cellMetresX: cell, cellMetresY: cell };
}

const facts = (over: Partial<WatershedFacts> = {}): WatershedFacts => ({
  outletCol: 4, outletRow: 0, sourceName: 'site', conditioning: 'priority-flood',
  cellMetres: { x: 2, y: 2 }, cells: 0, areaM2: 400, edgeContaminated: false,
  peakFlow: null, channelRule: 'estimated peak flow at least 1 L/s', crsName: 'EPSG:6346',
  isGeographic: false, version: '0.7.0 (testtest)', dateIso: '2026-10-24T00:00:00.000Z', ...over,
});

function setup(cols = 9, rows = 12, frames = 6) {
  const grid = valley(cols, rows);
  const routed = d8Flow(grid);
  const outlet = Math.floor(cols / 2); // row 0, the valley mouth
  const input: WatershedGifInput = {
    grid, routed, outlet, shade: new Float32Array(cols * rows).fill(0.8), channel: null,
    unit: 'm', facts: facts({ outletCol: outlet, outletRow: 0 }), revealFrames: frames,
  };
  return { grid, routed, outlet, input };
}

describe('watershed GIF frames', () => {
  it('reveals a cell exactly when its flow length reaches the frame threshold', async () => {
    const { grid, routed, outlet, input } = setup();
    const raster = stubRaster();
    const plan = planWatershedGif(input, raster);
    const progress: number[] = [];
    let yields = 0;
    const bytes = await renderWatershedGif(input, {
      raster, onProgress: (d) => progress.push(d), yieldFn: async () => { yields++; },
    });
    const g = decodeGif(bytes);
    const L = plan.layout;
    expect(g.frames).toHaveLength(7);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(yields).toBe(6);
    expect(g.frames.map((f) => f.delayCs)).toEqual([...Array(6).fill(REVEAL_DELAY_CS), HOLD_DELAY_CS]);
    expect([g.width, g.height]).toEqual([L.width, L.height]);
    expect(Math.max(g.width, g.height)).toBeLessThanOrEqual(GIF_MAX_SIDE);
    const fl = flowLengthToOutlet(grid, routed, outlet);
    expect(plan.maxLength).toBe(fl.maxLength);
    const ringR = Math.max(5, Math.round(1.6 * L.s)) + 3;
    const ox = L.mapX + (outlet % grid.cols - L.c0 + 0.5) * L.s, oy = L.mapY + (L.r1 - 0 + 0.5) * L.s;
    let checked = 0;
    for (let k = 0; k < g.screens.length; k++) {
      const screen = g.screens[k]!;
      const lk = plan.thresholds[k]!;
      for (let i = 0; i < grid.cols * grid.rows; i++) {
        const c = i % grid.cols, r = Math.floor(i / grid.cols);
        if (c < L.c0 || c > L.c1 || r < L.r0 || r > L.r1 || grid.valid[i] !== 1) continue;
        // North up: row r1 is the top row of blocks.
        const x = L.mapX + (c - L.c0) * L.s + Math.floor(L.s / 2), y = L.mapY + (L.r1 - r) * L.s + Math.floor(L.s / 2);
        if (Math.hypot(x - ox, y - oy) <= ringR) continue;
        const px = screen[y * g.width + x]!;
        const len = fl.length[i]!;
        if (len <= lk) {
          expect(px, `cell ${c},${r} frame ${k}`).toBe(viridisIndex(len / fl.maxLength));
        } else {
          expect(px >= GREY_BASE && px < GREY_BASE + GREY_LEVELS, `cell ${c},${r} frame ${k} is relief`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
    // The final frame: every catchment cell coloured, flow length labelled in metres.
    expect(plan.thresholds.at(-1)).toBe(plan.maxLength);
    expect(raster.drawn).toContain(`flow length ≤ ${formatLength(plan.maxLength, 'm')}`);
    expect(raster.drawn).toContain('flow length ≤ 0 m');
  });

  it('dots NoData, darkens the ground outside the catchment, and rings the outlet', async () => {
    // A ridge on the east keeps a strip outside the outlet's catchment.
    const { grid, routed, outlet, input } = setup(9, 12, 3);
    const raster = stubRaster();
    const plan = planWatershedGif(input, raster);
    const g = decodeGif(await renderWatershedGif(input, { raster, yieldFn: async () => {} }));
    const L = plan.layout;
    const last = g.screens.at(-1)!;
    const blockPixels = (c: number, r: number): number[] => {
      const out: number[] = [];
      for (let y = 0; y < L.s; y++) for (let x = 0; x < L.s; x++) {
        out.push(last[(L.mapY + (L.r1 - r) * L.s + y) * g.width + L.mapX + (c - L.c0) * L.s + x]!);
      }
      return out;
    };
    // NoData at the north-west corner: background with a dot pattern only.
    const nd = blockPixels(0, grid.rows - 1);
    expect(nd.every((p) => p === IX.BG || p === IX.NODATA)).toBe(true);
    // The outlet ring is drawn in the outlet colour.
    expect(last.includes(IX.OUTLET)).toBe(true);
    // Cells outside the catchment (if any in the crop) are a darker grey than the 0.8 relief.
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      if (plan.mask[i] === 1 || grid.valid[i] !== 1) continue;
      const c = i % grid.cols, r = Math.floor(i / grid.cols);
      if (c < L.c0 || c > L.c1 || r < L.r0 || r > L.r1) continue;
      for (const p of blockPixels(c, r)) expect(p).toBeLessThan(GREY_BASE + Math.round(0.8 * (GREY_LEVELS - 1)));
    }
    expect(routed.status[outlet]).toBeDefined();
  });

  it('merges cells into blocks on a catchment wider than the page, and stays within 1000 px', () => {
    // A plane falling west: each row drains alone, so one row is 1,500 cells wide.
    const cols = 1500, rows = 3;
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = c;
    const grid: FlowGrid = { z, valid: new Uint8Array(cols * rows).fill(1), cols, rows, cellMetresX: 1, cellMetresY: 1 };
    const routed = d8Flow(grid);
    const plan = planWatershedGif({
      grid, routed, outlet: cols, shade: null, channel: null, unit: 'm', facts: facts(),
    }, stubRaster());
    expect(plan.layout.d).toBe(2);
    expect(plan.layout.width).toBeLessThanOrEqual(GIF_MAX_SIDE);
    expect(plan.layout.height).toBeLessThanOrEqual(GIF_MAX_SIDE);
    expect(plan.caption.footer.join(' ')).toContain('1 pixel block per 2 x 2 cells');
  });

  it('keeps cells square: one scale on both axes', () => {
    const { input } = setup(5, 40, 2);
    const L = planWatershedGif(input, stubRaster()).layout;
    expect(L.mapW / (L.c1 - L.c0 + 1)).toBe(L.s);
    expect(L.mapH / (L.r1 - L.r0 + 1)).toBe(L.s);
  });
});

describe('captions', () => {
  it('say flow length, not time, and name the method, surface, CRS, version and date', () => {
    const c = watershedCaption(facts({ cells: 12_253 }), 'm');
    const text = [c.title, c.subtitle, ...c.footer].join(' ');
    expect(c.title).toBe('Catchment of outlet col 4, row 0');
    expect(text).toContain('site');
    expect(text).toContain('D8 flow length to the outlet');
    expect(text).toContain('not a travel time: no velocity is modelled');
    expect(text).toContain('Priority-Flood-conditioned DTM');
    expect(text).toContain('Cell 2 m');
    expect(text).toContain('12,253 cells');
    expect(text).toContain('CRS EPSG:6346');
    expect(text).toContain('Grid north (EPSG:6346)');
    expect(text).toContain('OpenLiDARViewer 0.7.0 (testtest)');
    expect(text).toContain('2026-10-24');
    expect(c.comment).toContain('SIMULATED');
    expect(c.comment).not.toMatch(/[^\x00-\x7f]/);
  });

  it('marks an edge-contaminated area and its peak flow as lower bounds', () => {
    const peak = peakFlowEstimate(80_687, { intensityMmH: 25, runoffC: 0.2 }, true);
    const text = watershedCaption(facts({ areaM2: 80_687, edgeContaminated: true, peakFlow: peak }), 'm').footer.join(' ');
    expect(text).toContain('contributing area at least 80,687 m²');
    expect(text).toContain('ground outside the survey may also drain here');
    expect(text).toContain('Peak flow at least 112 L/s at 25 mm/h, C 0.2');
    expect(text).toContain('a lower bound');
  });

  it('withholds area and peak flow without metres, and states the north of each frame kind', () => {
    const text = watershedCaption(facts({ areaM2: null, cellMetres: null, peakFlow: peakFlowEstimate(null, { intensityMmH: 25, runoffC: 0.2 }) }), 'cells').footer.join(' ');
    expect(text).toContain('contributing area withheld');
    expect(text).toContain('Peak flow not estimated: the horizontal scale is not resolved');
    expect(northLabel('EPSG:6346', false)).toBe('Grid north (EPSG:6346)');
    expect(northLabel('EPSG:4326', true)).toBe('North: geographic grid');
    expect(northLabel(null, false)).toBe('Grid +Y (no CRS)');
    expect(formatLength(3, 'cells')).toBe('3 cells');
    expect(formatLength(1, 'cells')).toBe('1 cell');
  });
});

describe('helpers', () => {
  it('reveal thresholds run linearly from 0 to the maximum', () => {
    expect(revealThresholds(90, 3)).toEqual([0, 30, 60, 90]);
  });

  it('round ticks and scale-bar lengths', () => {
    expect(niceTicks(437)).toEqual([0, 100, 200, 300, 400]);
    expect(niceTicks(12)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(0)).toEqual([0]);
    expect(niceLength(73)).toBe(50);
    expect(niceLength(180)).toBe(100);
    expect(niceLength(3.2)).toBe(2);
  });

  it('a frame carries only the rectangle that changed', () => {
    const a = new Uint8Array(20), b = a.slice();
    b[7] = 3; b[13] = 4; // (2,1) and (3,2) on a 5 x 4 screen
    const d = diffRect(a, b, 5, 4);
    expect([d.left, d.top, d.width, d.height]).toEqual([2, 1, 2, 2]);
    expect(Array.from(d.indices)).toEqual([3, 0, 0, 4]);
    expect(diffRect(b, b, 5, 4).width).toBe(1);
  });

  it('the palette: 256 colours, monotonic-lightness viridis, monotonic greys', () => {
    const p = watershedPalette();
    expect(p.length).toBe(768);
    const L = (i: number) => rgbToLab([p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!])[0];
    for (let i = 1; i < VIRIDIS_LEVELS; i++) expect(L(VIRIDIS_BASE + i)).toBeGreaterThanOrEqual(L(VIRIDIS_BASE + i - 1) - 1e-9);
    for (let i = 1; i < GREY_LEVELS; i++) expect(L(GREY_BASE + i)).toBeGreaterThan(L(GREY_BASE + i - 1));
  });
});
