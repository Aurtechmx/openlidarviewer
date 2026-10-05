/**
 * The Lab grids' visual layer: legend units and scale, colour never alone,
 * and the reduced-motion path for drawn-in routes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';

beforeAll(() => {
  installRecordingDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement = class HTMLInputElement {};
});

const resultGrid = await import('../src/ui/fieldSimulation/terrainAccessResultGrid');
const paint = await import('../src/ui/fieldSimulation/labGridPaint');
const maps = await import('../src/ui/fieldSimulation/labColormaps');
const explain = await import('../src/simulation/terrainAccess/terrainAccessExplain');
const rec = (n: unknown): RecordingEl => n as RecordingEl;

afterEach(() => vi.unstubAllGlobals());

describe('Terrain Access legend', () => {
  const legend = (): RecordingEl => rec(resultGrid.terrainAccessGridLegend());

  it('names the ramp quantity and its unit', () => {
    expect(legend().textContent).toContain('Extra cost over a flat, supported move (%)');
  });

  it('labels the bucket edges on the ramp, matching the cost buckets', () => {
    const text = legend().textContent;
    for (const tick of ['0', '15', '50', '≥100']) expect(legend().findByText(tick)).toHaveLength(1);
    expect(text).toContain('≤ 15 %');
    expect(text).toContain('≤ 50 %');
    expect(text).toContain('> 50 %');
  });

  it('gives every state a word and a glyph, not a colour alone', () => {
    const l = legend();
    for (const label of Object.values(explain.TERRAIN_ACCESS_STATE_LABEL)) expect(l.findByText(label)).toHaveLength(1);
    for (const glyph of ['✕', '?', '━', 'S', 'G']) expect(l.findByText(glyph).length).toBeGreaterThan(0);
  });

  it('sizes each bucket segment to its cost range, so the 15 and 50 ticks fall on segment edges', () => {
    const find = (n: RecordingEl): RecordingEl | null =>
      n.getAttribute('aria-label') === 'Cost buckets' ? n : n.children.map(find).find(Boolean) ?? null;
    const band = find(legend());
    expect(band?.children.map((c) => c.style.flexGrow)).toEqual(['15', '35', '50']);
  });

  it('describes the colour scale for assistive technology', () => {
    const find = (n: RecordingEl): RecordingEl | null =>
      n.getAttribute('role') === 'group' ? n : n.children.map(find).find(Boolean) ?? null;
    const ramp = find(legend());
    expect(ramp?.getAttribute('aria-label')).toMatch(/cividis.*0 %.*100 %/);
  });
});

describe('reduced motion', () => {
  it('draws a route at once when the user asked for reduced motion', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const frames: number[] = [];
    paint.drawIn(600, true, (f) => frames.push(f));
    expect(frames).toEqual([1]);
    expect(raf).not.toHaveBeenCalled();
  });

  it('animates from the start towards 1 otherwise', () => {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const frames: number[] = [];
    const t0 = performance.now();
    paint.drawIn(600, false, (f) => frames.push(f));
    queue.shift()!(t0 + 300);
    queue.shift()!(t0 + 600);
    expect(frames[0]).toBeGreaterThan(0);
    expect(frames[0]).toBeLessThan(1);
    expect(frames.at(-1)).toBe(1);
  });

  it('reads the media query, and treats a missing matchMedia as full motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    expect(maps.prefersReducedMotion()).toBe(true);
    vi.stubGlobal('matchMedia', undefined);
    expect(maps.prefersReducedMotion()).toBe(false);
  });
});

describe('north-up orientation', () => {
  // Row 0 of a DTM grid is its southern row (rasterizeDtm counts rows up from
  // the minimum northing); the grid must draw it at the bottom.
  const prepare = async () => {
    const { prepareTerrainAccessPreview } = await import('../src/simulation/terrainAccess/terrainAccessPreview');
    const { TERRAIN_ACCESS_DEFAULTS } = await import('../src/simulation/terrainAccess/terrainAccessRunner');
    const cols = 4, rows = 5, n = cols * rows;
    const dtm = {
      z: new Float32Array(n), coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(90),
      counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
      cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
      crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
      verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n,
      analyzedPointCount: n, withheldExcluded: true, meanConfidence: 90, warnings: [],
    } as never;
    const profile = {
      name: 'p', maxLongitudinalGrade: 1, maxCrossSlope: 1, maxStepHeight: 1, maxRuggedness: null,
      vehicleWidth: 0, vehicleLength: null, minimumTerrainConfidence: 0, unknownPolicy: 'block',
      obstacleHeightThreshold: null,
    } as never;
    const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true } as never;
    const prev = prepareTerrainAccessPreview(dtm, scale, profile, TERRAIN_ACCESS_DEFAULTS);
    return prev;
  };

  it('maps a click at the top of the canvas to the northern row', () => {
    expect(paint.northUpCell(4, 5, 100, 125, 10, 1)).toEqual({ col: 0, row: 4 });
    expect(paint.northUpCell(4, 5, 100, 125, 10, 124)).toEqual({ col: 0, row: 0 });
    expect(paint.northUpCell(4, 5, 100, 125, 10, 130)).toBeNull();
  });

  it('ArrowUp moves north (row + 1) and ArrowDown south', () => {
    expect(paint.northUpRowStep('ArrowUp')).toBe(1);
    expect(paint.northUpRowStep('ArrowDown')).toBe(-1);
    expect(paint.northUpRowStep('ArrowLeft')).toBe(0);
  });

  it('draws the northernmost row in the top row of the canvas, and ArrowUp increases the row', async () => {
    const prev = await prepare();
    if (!prev.ok) throw new Error(prev.reason);
    const g = new resultGrid.TerrainAccessResultGrid({ ariaLabel: 'g', onActivate: () => {}, onMove: () => {} });
    const canvas = rec(g.element).children[0]!.children[0]! as unknown as Record<string, unknown>;
    const calls: Array<{ t: number[]; rect: number[] }> = [];
    let t = [1, 0, 0, 1, 0, 0];
    const ctx = new Proxy({}, {
      get: (_o, k) => {
        if (k === 'setTransform') return (...a: number[]) => { t = a; };
        if (k === 'fillRect') return (...r: number[]) => calls.push({ t: [...t], rect: r });
        if (k === 'getContext') return undefined;
        return () => {};
      },
      set: () => true,
    });
    canvas.getContext = () => ctx;
    Object.defineProperty(canvas, 'clientWidth', { value: 40 });
    g.load(prev.grid, prev.map);
    const cells = calls.filter((c) => c.rect[2]! >= 9 && c.rect[3]! >= 9);
    expect(cells.length).toBeGreaterThanOrEqual(prev.grid.cols * prev.grid.rows);
    // Device y of a cell drawn at model y: d * y + f. The last row painted (row
    // rows - 1, the northernmost) must sit at the top.
    const top = (c: { t: number[]; rect: number[] }) => Math.min(c.t[3]! * c.rect[1]! + c.t[5]!, c.t[3]! * (c.rect[1]! + c.rect[3]!) + c.t[5]!);
    const first = cells[0]!, last = cells[prev.grid.cols * prev.grid.rows - 1]!;
    expect(top(last)).toBe(0);
    expect(top(first)).toBeGreaterThan(top(last));

    const before = g.cursor.row;
    (g as unknown as { _handleKey(e: unknown): void })._handleKey({ key: 'ArrowUp', preventDefault() {} });
    expect(g.cursor.row).toBe(before + 1);
  });
});
