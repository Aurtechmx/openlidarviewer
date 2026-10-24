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

  it('ticks at the smallest count drawn as a line, powers of ten with room either side, and the maximum', () => {
    expect(grid.upstreamTicks(3629)).toEqual([26, 100, 1000, 3629]);
    expect(grid.upstreamTicks(100000)).toEqual([100, 1000, 10000, 100000]);
    expect(grid.upstreamTicks(1)).toEqual([1]);
    const l = rec(grid.flowGridLegend(3629));
    for (const t of ['26', '100', '1,000', '3,629']) expect(l.findByText(t)).toHaveLength(1);
    expect(grid.rampPosition(26, 3629)).toBeCloseTo(0.0035, 2);
    expect(grid.rampPosition(3629, 3629)).toBe(1);
  });

  it('describes the drawing: wider and brighter lines, counts cells not water, relief lit from the north-west', () => {
    const text = rec(grid.flowGridLegend(3629)).textContent;
    expect(text).toContain('Lines start at 26 upstream cells');
    expect(text).toContain('wider and brighter lines mean more cells drain through that point');
    expect(text).toContain('It counts cells, not water.');
    expect(text).toContain('north-west');
  });

  it('gives each mark a glyph and a word', () => {
    const l = rec(grid.flowGridLegend(10));
    for (const [glyph, word] of [['━', 'Path'], ['○', 'Outlet (flow leaves the survey)'], ['▼', 'Sink (flow stops)'], ['?', 'No ground data']]) {
      expect(l.findByText(glyph).length).toBeGreaterThan(0);
      expect(l.findByText(word)).toHaveLength(1);
    }
  });
});

describe('hillshade', () => {
  it('is uniform on a flat surface and lighter on a slope facing the north-west light', () => {
    const flat = grid.hillshade(flowGrid(4, 4, () => 0));
    expect(new Set(Array.from(flat).map((v) => v.toFixed(6))).size).toBe(1);
    // Row 0 is the southern row. z rises to the east and south: the surface
    // faces north-west, towards the light.
    const facing = grid.hillshade(flowGrid(4, 4, (c, r) => c - r));
    const away = grid.hillshade(flowGrid(4, 4, (c, r) => -c + r));
    expect(facing[5]!).toBeGreaterThan(flat[5]!);
    expect(away[5]!).toBeLessThan(flat[5]!);
  });
});

describe('relief base', () => {
  it('is grey, darker away from the light and lighter towards it', () => {
    const dark = grid.reliefRgb(0), light = grid.reliefRgb(1), mid = grid.reliefRgb(0.5);
    expect(light[0]).toBeGreaterThan(mid[0]);
    expect(mid[0]).toBeGreaterThan(dark[0]);
    // Near-neutral: channels differ by a slight cool cast only.
    for (const c of [dark, mid, light]) expect(c[2] - c[0]).toBeLessThanOrEqual(8);
    expect(grid.reliefRgb(Number.NaN)).toEqual(dark);
  });
});

describe('drainage network on the grid', () => {
  it('strokes only channel cells, from each centre to its receiver, after the relief', () => {
    const g = new grid.FlowResultGrid({ ariaLabel: 'g', onActivate: () => {}, onMove: () => {} });
    const canvas = rec(g.element).children[0]!.children[0]! as unknown as Record<string, unknown>;
    const log: string[] = [];
    const lines: Array<[number, number]> = [];
    canvas.getContext = () => new Proxy({}, {
      get: (_o, k) => {
        if (k === 'lineTo') return (x: number, y: number) => { lines.push([x, y]); log.push('lineTo'); };
        if (k === 'stroke') return () => log.push('stroke');
        if (k === 'fillRect') return () => log.push('fillRect');
        return () => {};
      },
      set: () => true,
    });
    Object.defineProperty(canvas, 'clientWidth', { value: 40 });
    // 4 x 1 strip draining east; upstream 1, 2, 3, 4; cell 3 is the outlet.
    const fg = flowGrid(4, 1, (c) => 4 - c);
    const routed = {
      receiver: Int32Array.from([1, 2, 3, -1]), direction: new Int8Array(4).fill(-1), status: Uint8Array.from([0, 0, 0, 0]),
      sinkCount: 0, flatCount: 0, outletCount: 0,
    };
    g.load(fg as never, routed as never, { upstreamCells: Uint32Array.from([1, 2, 3, 4]), drainedCells: 4, unresolvedCells: 0 }, null);
    // logScale(1, 4) = 0.43 is a channel here, so every cell has a stroke end.
    const s = 10;
    const ends = new Set(lines.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`));
    for (const c of [1, 2, 3]) expect(ends.has(`${c * s + s / 2},${s / 2}`)).toBe(true);
    // Strokes come after the relief fills.
    expect(log.lastIndexOf('fillRect')).toBeLessThan(log.indexOf('stroke'));
  });
});

describe('hillshade, north-up', () => {
  it('lights a north-facing slope and shades a south-facing one under a north-west sun', () => {
    const flat = grid.hillshade(flowGrid(4, 4, () => 0));
    // z rises with the row number, so northwards: the slope faces south.
    const facesSouth = grid.hillshade(flowGrid(4, 4, (_c, r) => r));
    const facesNorth = grid.hillshade(flowGrid(4, 4, (_c, r) => -r));
    expect(facesSouth[5]!).toBeLessThan(flat[5]!);
    expect(facesNorth[5]!).toBeGreaterThan(flat[5]!);
  });
});

describe('north-up grid', () => {
  it('draws the northernmost row at the top and ArrowUp moves north', () => {
    const g = new grid.FlowResultGrid({ ariaLabel: 'g', onActivate: () => {}, onMove: () => {} });
    const canvas = rec(g.element).children[0]!.children[0]! as unknown as Record<string, unknown>;
    const calls: Array<{ t: number[]; rect: number[] }> = [];
    let t = [1, 0, 0, 1, 0, 0];
    canvas.getContext = () => new Proxy({}, {
      get: (_o, k) => {
        if (k === 'setTransform') return (...a: number[]) => { t = a; };
        if (k === 'fillRect') return (...r: number[]) => calls.push({ t: [...t], rect: r });
        return () => {};
      },
      set: () => true,
    });
    Object.defineProperty(canvas, 'clientWidth', { value: 30 });
    const fg = flowGrid(3, 4, (_c, r) => -r);
    const n = 12;
    const routed = {
      receiver: new Int32Array(n).fill(-1), direction: new Int8Array(n).fill(-1), status: new Uint8Array(n).fill(0),
      sinkCount: 0, flatCount: 0, outletCount: 0,
    };
    g.load(fg as never, routed as never, { upstreamCells: new Uint32Array(n).fill(1), drainedCells: n, unresolvedCells: 0 }, null);
    const cells = calls.filter((c) => c.rect[2]! >= 9);
    const top = (c: { t: number[]; rect: number[] }) => Math.min(c.t[3]! * c.rect[1]! + c.t[5]!, c.t[3]! * (c.rect[1]! + c.rect[3]!) + c.t[5]!);
    expect(top(cells[n - 1]!)).toBe(0);
    expect(top(cells[0]!)).toBeGreaterThan(0);
    const before = g.cursor.row;
    (g as unknown as { _handleKey(e: unknown): void })._handleKey({ key: 'ArrowUp', preventDefault() {} });
    expect(g.cursor.row).toBe(before + 1);
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

const P = await import('../src/ui/fieldSimulation/flowParticles');
const { logScale } = await import('../src/render/flowOverlayGeometry');

describe('flow particles', () => {
  // A 4 x 1 strip draining east; upstream counts 1, 2, 3, 4; the last cell is an outlet.
  const field = {
    cols: 4, rows: 1,
    receiver: Int32Array.from([1, 2, 3, -1]),
    upstreamCells: Uint32Array.from([1, 2, 3, 4]),
    maxUpstream: 4,
  };

  it('moves at a speed proportional to the log-scaled upstream count', () => {
    for (const i of [0, 1, 2]) {
      expect(P.particleSpeed(field, i)).toBeCloseTo(P.MAX_SPEED_CELLS_PER_S * logScale(field.upstreamCells[i]!, 4), 9);
    }
    expect(P.particleSpeed(field, 2)).toBeGreaterThan(P.particleSpeed(field, 1));
  });

  it('spawns only on routed cells at or above the drainage threshold', () => {
    const cells = Array.from(P.spawnCells(field));
    expect(cells).not.toContain(3);
    for (const c of cells) expect(field.receiver[c]).toBeGreaterThanOrEqual(0);
  });

  it('follows the D8 receiver and respawns where flow leaves', () => {
    const cells = P.spawnCells(field);
    const parts = [{ cell: 1, progress: 0.9, age: 0 }];
    P.stepParticles(field, parts, cells, 0.1, P.seededRandom(3));
    expect(parts[0]!.cell).toBe(2);
    parts[0] = { cell: 2, progress: 0.99, age: 0 };
    P.stepParticles(field, parts, cells, 0.1, P.seededRandom(3));
    expect(Array.from(cells)).toContain(parts[0]!.cell);
  });

  it('is deterministic for a seed and caps its count', () => {
    const a = P.seededRandom(9), b = P.seededRandom(9);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(P.MAX_PARTICLES).toBe(900);
    expect(P.particleCount(10_000)).toBe(P.MAX_PARTICLES);
  });

  it('scales the count with the number of channel cells', () => {
    expect(P.particleCount(0)).toBe(0);
    expect(P.particleCount(10)).toBe(5);
    expect(P.particleCount(1000)).toBe(500);
    expect(P.particleCount(1801)).toBe(900);
  });

  it('moves smoothly: continuous across a cell boundary and through a turn', () => {
    // 2 x 2: cell 0 → 1 (east), 1 → 3 (north), 3 → 2 (west); cell 2 is the outlet.
    const turn = {
      cols: 2, rows: 2,
      receiver: Int32Array.from([1, 3, -1, 2]),
      upstreamCells: Uint32Array.from([1, 2, 4, 3]),
      maxUpstream: 4,
    };
    const before = P.particlePosition(turn, { cell: 0, progress: 0.9999, age: 0, prev: -1 })!;
    const after = P.particlePosition(turn, { cell: 1, progress: 0.0001, age: 0, prev: 0 })!;
    expect(Math.hypot(before[0] - after[0], before[1] - after[1])).toBeLessThan(1e-3);
    // Through the corner at cell 1's centre (1.5, 0.5) the track cuts inside the corner, not through it.
    const corner = P.particlePosition(turn, { cell: 0, progress: 0.999999, age: 0, prev: -1 })!;
    expect(corner[0]).toBeLessThan(1.5);
    expect(corner[1]).toBeGreaterThan(0.5);
    // Straight from a fresh spawn: halfway is the link midpoint.
    expect(P.particlePosition(turn, { cell: 0, progress: 0.25, age: 0 })).toEqual([0.75, 0.5]);
    expect(P.particlePosition(turn, { cell: 2, progress: 0.5, age: 0 })).toBeNull();
  });

  it('records where a particle came from when it crosses into the next cell', () => {
    const cells = P.spawnCells(field);
    const parts: Parameters<typeof P.stepParticles>[1] = [{ cell: 0, progress: 0.95, age: 0, prev: -1 }];
    P.stepParticles(field, parts, cells, 0.1, P.seededRandom(3));
    expect(parts[0]!.cell).toBe(1);
    expect(parts[0]!.prev).toBe(0);
  });
});

describe('flow motion control', () => {
  it('keeps one label; aria-pressed means paused, and reduced motion shows it pressed and disabled', async () => {
    const lab = await import('../src/ui/fieldSimulation/flowPulseLab');
    expect(lab.flowMotionControlState(false, false)).toEqual({ text: 'Pause flow motion', pressed: false, disabled: false });
    expect(lab.flowMotionControlState(false, true)).toEqual({ text: 'Pause flow motion', pressed: true, disabled: false });
    expect(lab.flowMotionControlState(true, false)).toEqual({ text: 'Pause flow motion', pressed: true, disabled: true });
  });

  it('never starts the particle loop under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {} }));
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const p = new P.FlowParticles();
    p.load({ cols: 2, rows: 1, receiver: Int32Array.from([1, -1]), upstreamCells: Uint32Array.from([3, 4]), maxUpstream: 4 });
    expect(raf).not.toHaveBeenCalled();
    expect(p.running).toBe(false);
  });
});
