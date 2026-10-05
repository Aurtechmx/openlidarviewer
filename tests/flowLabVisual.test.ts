/**
 * Flow Pulse grid visuals: the log upstream-count legend with its unit and
 * ticks, the relief shading, marks that carry a glyph and a word, and the
 * reduced-motion path for a traced path.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';

beforeAll(() => {
  installRecordingDom();
});

const grid = await import('../src/ui/fieldSimulation/flowResultGrid');
const paint = await import('../src/ui/fieldSimulation/labGridPaint');
const rec = (n: unknown): RecordingEl => n as RecordingEl;

afterEach(() => vi.unstubAllGlobals());

function flowGrid(cols: number, rows: number, z: (c: number, r: number) => number) {
  const zz = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) zz[r * cols + c] = z(c, r);
  return { z: zz, valid: new Uint8Array(cols * rows).fill(1), cols, rows, cellMetresX: 1, cellMetresY: 1 };
}

describe('Flow Pulse legend', () => {
  it('names the quantity, says the scale is logarithmic, and counts cells', () => {
    const text = rec(grid.flowGridLegend(3629)).textContent;
    expect(text).toContain('Upstream cells draining through a cell (log scale)');
  });

  it('ticks at 1, powers of ten that leave room for the maximum label, and the maximum', () => {
    expect(grid.upstreamTicks(3629)).toEqual([1, 10, 100, 3629])
    expect(grid.upstreamTicks(100000)).toEqual([1, 10, 100, 1000, 100000]);
    expect(grid.upstreamTicks(1)).toEqual([1]);
    const l = rec(grid.flowGridLegend(3629));
    for (const t of ['1', '10', '100', '3,629']) expect(l.findByText(t)).toHaveLength(1);
  });

  it('gives each mark a glyph and a word', () => {
    const l = rec(grid.flowGridLegend(10));
    for (const [glyph, word] of [['━', 'Path'], ['○', 'Outlet (flow leaves the grid)'], ['▼', 'Sink (flow stops)'], ['?', 'No ground data']]) {
      expect(l.findByText(glyph).length).toBeGreaterThan(0);
      expect(l.findByText(word)).toHaveLength(1);
    }
  });
});

describe('hillshade', () => {
  it('is uniform on a flat surface and lighter on a slope facing the north-west light', () => {
    const flat = grid.hillshade(flowGrid(4, 4, () => 0));
    expect(new Set(Array.from(flat).map((v) => v.toFixed(6))).size).toBe(1);
    // z rises to the east and south: the surface faces north-west, towards the light.
    const facing = grid.hillshade(flowGrid(4, 4, (c, r) => c + r));
    const away = grid.hillshade(flowGrid(4, 4, (c, r) => -c - r));
    expect(facing[5]!).toBeGreaterThan(flat[5]!);
    expect(away[5]!).toBeLessThan(flat[5]!);
  });
});

describe('reduced motion', () => {
  it('draws a traced path at once under reduced motion', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const frames: number[] = [];
    paint.drawIn(600, true, (f) => frames.push(f));
    expect(frames).toEqual([1]);
    expect(raf).not.toHaveBeenCalled();
  });

  it('the grid asks the media query before animating a path', () => {
    const mm = vi.fn(() => ({ matches: true }));
    vi.stubGlobal('matchMedia', mm);
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const g = new grid.FlowResultGrid({ ariaLabel: 'g', onActivate: () => {}, onMove: () => {} });
    g.setPathMask(new Uint8Array([1, 1]), [0, 1]);
    expect(mm).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(raf).not.toHaveBeenCalled();
  });
});
