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

  it('describes the colour scale for assistive technology', () => {
    const find = (n: RecordingEl): RecordingEl | null =>
      n.getAttribute('role') === 'img' ? n : n.children.map(find).find(Boolean) ?? null;
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
