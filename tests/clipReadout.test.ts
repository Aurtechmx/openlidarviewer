/**
 * clipReadout.test.ts: what the Clip page and its neighbours say about a clip.
 *
 *   - the readout names what was counted (a display sample, several visible
 *     scans), what a full-resolution export keeps, and why a figure is all or
 *     nothing (the box covers the whole scan; Keep outside with that box);
 *   - a streaming scan with no count gets a sentence, not a blank;
 *   - the state strip never says "Clipped: n of n";
 *   - per-layer counts sum over the drawn layers with the active one broken out;
 *   - Fit to scan over the visible union keeps every placed point;
 *   - the export summary estimates a clipped full-resolution export as an
 *     "about" figure, sizes it from that, and stops at a clip that keeps none;
 *   - the clip's GPU fold stays after its first use until a scan opens with
 *     the clip off;
 *   - the outline has twelve edges on the box.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installFakeDom } from './support/measurePanelDom';
import { clipStatusText } from '../src/render/clip/clipScope';
import { sumClipCounts } from '../src/render/clip/clipBox';
import { fitMergedBounds } from '../src/render/clip/fitBoundsInProject';
import { buildExportSummary } from '../src/export/exportSummary';

beforeAll(() => {
  installFakeDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement ??= class {};
});

describe('clipReadoutText', () => {
  it('a plain count reads "k of n points kept."', async () => {
    const { clipReadoutText } = await import('../src/ui/ClipPanel');
    expect(clipReadoutText({ kept: 1234, total: 3600 }, 'keep-inside')).toBe('1,234 of 3,600 points kept.');
  });

  it('a box over the whole scan says so and how to make it smaller', async () => {
    const { clipReadoutText } = await import('../src/ui/ClipPanel');
    const t = clipReadoutText({ kept: 16, total: 16 }, 'keep-inside');
    expect(t).toMatch(/^16 of 16 points kept\./);
    expect(t).toContain('The box covers the whole scan');
    expect(t).toContain('Draw a clipping box, or edit the bounds under Advanced');
  });

  it('Keep outside with the fitted box explains the zero', async () => {
    const { clipReadoutText } = await import('../src/ui/ClipPanel');
    const t = clipReadoutText({ kept: 0, total: 2_416_493 }, 'keep-outside');
    expect(t).toMatch(/^0 of 2,416,493 points kept\./);
    expect(t).toContain('Keep outside hides what is inside it');
    expect(t).toContain('switch to Keep inside');
    // Nothing kept: no "about 0 of the file" estimate.
    expect(clipReadoutText({ kept: 0, total: 10, sourceTotal: 1000 }, 'keep-outside')).not.toContain('full-resolution');
  });

  it('an empty Keep inside box says where to look', async () => {
    const { clipReadoutText } = await import('../src/ui/ClipPanel');
    expect(clipReadoutText({ kept: 0, total: 10 }, 'keep-inside')).toContain('No points are inside the box');
  });

  it('a display sample says it counted the shown points and estimates the file', async () => {
    const { clipReadoutText } = await import('../src/ui/ClipPanel');
    const t = clipReadoutText({ kept: 1_208_246, total: 2_416_493, sourceTotal: 151_050_743 }, 'keep-inside');
    expect(t).toMatch(/^1,208,246 of 2,416,493 shown points kept\./);
    expect(t).toContain('A full-resolution export keeps about 75.5 M of the file\'s 151.1 M points.');
  });

  it('several visible scans: the figure over all of them, then the active scan the export writes', async () => {
    const { clipReadoutText } = await import('../src/ui/ClipPanel');
    const t = clipReadoutText({ kept: 8, total: 16, visible: { kept: 8, total: 32, scans: 2 }, name: 'b.las' }, 'keep-inside');
    expect(t).toMatch(/^8 of 32 points kept across 2 visible scans\./);
    expect(t).toContain('In the active scan (b.las): 8 of 16; a point-cloud export writes these.');
  });

  it('no count (a streaming scan) is a sentence, never blank', async () => {
    const { clipReadoutText } = await import('../src/ui/ClipPanel');
    const t = clipReadoutText(null, 'keep-inside');
    expect(t.length).toBeGreaterThan(20);
    expect(t).toContain('streaming');
  });
});

describe('clipStatusText (state strip, export scope)', () => {
  it('says "Clipped: k of n" only when something is clipped', () => {
    expect(clipStatusText({ kept: 5, total: 9 })).toBe('Clipped: 5 of 9 points');
    expect(clipStatusText({ kept: 9, total: 9 })).toBe('Clip on: keeps all 9 points');
  });
});

describe('sumClipCounts', () => {
  const layers = [
    { id: 'a', visible: true, kept: 3, total: 10 },
    { id: 'b', visible: true, kept: 5, total: 20 },
    { id: 'c', visible: false, kept: 1, total: 7 },
  ];
  it('breaks out the active layer and sums the drawn ones', () => {
    expect(sumClipCounts(layers, 'b')).toEqual({ kept: 5, total: 20, visible: { kept: 8, total: 30, scans: 2 } });
  });
  it('a hidden active layer still has its own count; one drawn layer has no union', () => {
    expect(sumClipCounts([layers[0], layers[2]], 'c')).toEqual({ kept: 1, total: 7, visible: null });
  });
  it('null when the active layer was not counted', () => {
    expect(sumClipCounts(layers, 'zz')).toBeNull();
  });
});

describe('fitMergedBounds', () => {
  it('turns the merged six-tuple into a box a hair wider than the data', () => {
    const b = fitMergedBounds([0, 10, -2, 2000, 2010, 3])!;
    expect(b.min[0]).toBeLessThanOrEqual(0);
    expect(b.max[0]).toBeGreaterThan(2000);
    expect(b.max[0] - 2000).toBeLessThan(0.001);
    expect(b.min[2]).toBeLessThan(-2);
  });
  it('null without visible data', () => {
    expect(fitMergedBounds(null)).toBeNull();
    expect(fitMergedBounds([0, 0, 0, Number.NaN, 1, 1])).toBeNull();
  });
});

describe('export summary with a clip', () => {
  const base = { pointCount: 2_416_493, format: 'las14' as const, crsMode: 'keep' as const, hasRgb: true, viewDecimated: true, sourcePointCount: 151_050_743 };

  it('a display-resolution export writes exactly the kept points', () => {
    const s = buildExportSummary({ ...base, pointCount: 11_611, clip: { kept: 11_611, total: 2_416_493 } });
    expect(s.line).toMatch(/^11,611 points · /);
    expect(s.pointCountApproximate).toBe(false);
  });

  it('a full-resolution export keeps about the clip\'s share of the file, sized from that', () => {
    const s = buildExportSummary({ ...base, fullRes: true, clip: { kept: 11_611, total: 2_416_493 } });
    // 11,611 / 2,416,493 × 151,050,743 ≈ 725,800 (three significant figures).
    expect(s.line).toMatch(/^about 726,000 points · /);
    expect(s.pointCountApproximate).toBe(true);
    expect(s.basisLabel).toBe('Point basis: full file, clipped (about 726,000 of 151,050,743 points)');
    expect(s.sizeBytesEst).toBe(375 + 726_000 * 36);
    // The whole file's 5 GiB is not what is written: no large-scan warning.
    expect(s.warnings.some((w) => /Large scan/.test(w.message))).toBe(false);
  });

  it('without a clip a full-resolution export is the whole file, as before', () => {
    const s = buildExportSummary({ ...base, fullRes: true });
    expect(s.line).toMatch(/^151,050,743 points · /);
    expect(s.warnings.some((w) => /Large scan/.test(w.message))).toBe(true);
  });

  it('a clip that keeps no points says so, blocks, and offers the way out', () => {
    for (const fullRes of [false, true]) {
      const s = buildExportSummary({ ...base, pointCount: 0, fullRes, clip: { kept: 0, total: 2_416_493 } });
      expect(s.line).toBe('The clip keeps no points.');
      expect(s.clipKeepsNone).toBe(true);
      expect(s.warnings[0]).toEqual({ level: 'error', message: 'Move or resize the clip box, or turn the clip off, to export points.' });
    }
  });
});

describe('the clip GPU fold and the outline', () => {
  it('the fold enters with the first clip, stays while off, and leaves when a scan opens with the clip off', async () => {
    const { ClipBoxGpu } = await import('../src/render/clip/clipGpu');
    const gpu = new ClipBoxGpu();
    const on = { box: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }, mode: 'keep-inside' as const, enabled: true };
    expect(gpu.folded()).toBe(false);
    gpu.apply(on);
    expect(gpu.folded()).toBe(true);
    gpu.apply(null);
    expect(gpu.isActive()).toBe(false);
    expect(gpu.folded()).toBe(true);
    // A scan opening while the clip is on keeps the fold (it is in use).
    gpu.apply(on);
    expect(gpu.forget()).toBe(false);
    expect(gpu.folded()).toBe(true);
    gpu.apply(null);
    expect(gpu.forget()).toBe(true);
    expect(gpu.folded()).toBe(false);
  });

  it('the outline is the twelve edges of the box', async () => {
    const { boxEdgeSegments } = await import('../src/render/clip/clipGpu');
    const seg = boxEdgeSegments({ min: [0, 0, 0], max: [2, 3, 4] });
    expect(seg.length).toBe(12 * 2 * 3);
    let length = 0;
    for (let i = 0; i < seg.length; i += 6) length += Math.hypot(seg[i + 3] - seg[i], seg[i + 4] - seg[i + 1], seg[i + 5] - seg[i + 2]);
    expect(length).toBeCloseTo(4 * (2 + 3 + 4), 9);
  });

  it('the outline object follows show(), hides with null and stays out of exports', async () => {
    const { ClipOutline } = await import('../src/render/clip/clipGpu');
    const scene = new Set<unknown>();
    const o = new ClipOutline({ add: (x) => scene.add(x), remove: (x) => scene.delete(x), requestFrame: () => {} });
    o.show({ min: [0, 0, 0], max: [1, 1, 1] }, true);
    expect(scene.has(o.object)).toBe(true);
    expect(o.object.visible).toBe(true);
    o.show({ min: [0, 0, 0], max: [5, 1, 1] }, false);
    expect(o.box?.max[0]).toBe(5);
    const seen = await o.without(async () => o.object.visible);
    expect(seen).toBe(false);
    expect(o.object.visible).toBe(true);
    o.show(null, false);
    expect(scene.has(o.object)).toBe(false);
    o.dispose();
  });
});

describe('the Clip page count from the viewer', () => {
  const viewer = (vis: Record<string, boolean>, offset: Record<string, number[] | null> = {}) => ({
    clouds: () => Object.keys(vis),
    isCloudVisible: (id: string) => vis[id],
    getCloud: (id: string) => ({ name: `${id}.las`, pointCount: 10, declaredPointCount: id === 'a' ? 500 : 10 }),
    layerProjectOffset: (id: string) => offset[id] ?? null,
    clipKeptCounts: (id: string | null) => Object.keys(vis).filter((k) => vis[k] || k === id).map((k) => ({ id: k, visible: vis[k], kept: 4, total: 10 })),
  });

  it('carries the sample\'s declared count and the active name', async () => {
    const { clipCountFor } = await import('../src/app/clipMount');
    const c = clipCountFor(viewer({ a: true, b: true }) as never, 'a')!;
    expect(c).toMatchObject({ kept: 4, total: 10, sourceTotal: 500, name: 'a.las', visible: { kept: 8, total: 20, scans: 2 } });
    expect(clipCountFor(viewer({ a: true }) as never, null)).toBeNull();
  });

  it('the data key moves with visibility, layers and placement, so the count is redone', async () => {
    const { clipDataKey } = await import('../src/app/clipMount');
    const k0 = clipDataKey(viewer({ a: true, b: true }) as never, 'a');
    expect(clipDataKey(viewer({ a: true, b: true }) as never, 'a')).toBe(k0);
    expect(clipDataKey(viewer({ a: true, b: false }) as never, 'a')).not.toBe(k0);
    expect(clipDataKey(viewer({ a: true }) as never, 'a')).not.toBe(k0);
    expect(clipDataKey(viewer({ a: true, b: true }, { b: [5, 0, 0] }) as never, 'a')).not.toBe(k0);
    expect(clipDataKey(viewer({ a: true, b: true }) as never, 'b')).not.toBe(k0);
  });
});
