/**
 * exportPanelClipPlacement.test.ts
 *
 * The clip box is in the project frame. A placed layer's buffer is
 * source-local, so the export must place each point before testing it, or it
 * writes a different region from the one shown inside the box.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { type ClipBox, clipMaskArray } from '../src/render/clip/clipBox';
import { clipCloud } from '../src/render/clip/clipCloud';
import { copyPlacedPositions } from '../src/render/measure/lassoVolumeCompute';

const hoisted = vi.hoisted(() => ({
  /** Every cloud handed to the converter, so a test can see what was written. */
  converted: [] as { pointCount: number }[],
  /** The ConvertOptions each export actually reached the writer with. */
  options: [] as Record<string, unknown>[],
  /** Filenames that reached the browser download helper. */
  downloads: [] as string[],
}));

vi.mock('../src/lazyChunks', () => ({
  loadConvertEngine: async () => ({
    resolveExportDigests: async () => ({ sourceSha256: 'a'.repeat(64), sourceSha256Note: null, crsOrigin: { source: 'unknown', name: 'unknown', epsg: 'unknown', verticalDatum: 'unknown', verticalSource: 'unknown' } }),
    convertCloud: (cloud: { pointCount: number }, options: Record<string, unknown>) => {
      hoisted.converted.push(cloud);
      hoisted.options.push(options);
      return {
        file: { filename: 'scan.las', bytes: new Uint8Array([0]), mime: 'application/octet-stream' },
        report: { pointCount: cloud.pointCount, crsNote: 'CRS kept', log: [] },
      };
    },
  }),
}));

vi.mock('../src/io/download', () => ({
  downloadBytes: (filename: string) => { hoisted.downloads.push(filename); },
  triggerDownload: () => { /* unused here */ },
}));

class FakeEl {
  className = '';
  title = '';
  type = '';
  href = '';
  value = '';
  placeholder = '';
  inputMode = '';
  checked = false;
  disabled = false;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  private _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly _listeners: Record<string, (() => void)[]> = {};
  readonly classList = {
    _set: new Set<string>(),
    add: (c: string): void => { this.classList._set.add(c); },
    remove: (c: string): void => { this.classList._set.delete(c); },
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this.classList._set.has(c);
      if (on) this.classList._set.add(c);
      else this.classList._set.delete(c);
    },
    contains: (c: string): boolean => this.classList._set.has(c),
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(v: string) { this._text = v; this.children.length = 0; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) { /* icons only */ }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  append(...kids: (FakeEl | string)[]): void {
    for (const k of kids) if (k) this.children.push(typeof k === 'string' ? FakeEl.text(k) : k);
  }
  replaceChildren(...kids: (FakeEl | string)[]): void {
    this._text = '';
    this.children.length = 0;
    this.append(...kids);
  }
  /** A text node: a childless '#text' carrying only its own text. */
  static text(v: string): FakeEl {
    const t = new FakeEl('#text');
    t._text = v;
    return t;
  }
  addEventListener(type: string, fn: () => void): void {
    (this._listeners[type] ??= []).push(fn);
  }
  /** Fire every listener registered for `type` (the panel binds click/change). */
  fire(type: string): void {
    for (const fn of this._listeners[type] ?? []) fn();
  }
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

beforeEach(() => {
  hoisted.converted.length = 0;
  hoisted.options.length = 0;
  hoisted.downloads.length = 0;
});

/**
 * A layer placed 100 m east in the project frame. Source-local x = 0 is
 * Ground, x = 100 is Building. On screen (project frame) the Ground point
 * sits at x = 100, the Building point at x = 200.
 */
const OFFSET: [number, number, number] = [100, 0, 0];
function placedLayer(origin: [number, number, number] = [500000, 0, 0]): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 100, 0, 0]),
    classification: new Uint8Array([2, 6]),
    gpsTime: new Float64Array([1, 2]),
    origin,
    sourceFormat: 'las',
    name: 'placed.las',
  });
}
/** A box around project x = 100: on screen it holds only the Ground point. */
const clipAt100: ClipBox = { box: { min: [99, -1, -1], max: [101, 1, 1] }, mode: 'keep-inside', enabled: true };

/** The point identities the viewer shows inside the clip (placed buffer, as clipKeptCount reads it). */
function shownIds(cloud: PointCloud, clip: ClipBox, offset: [number, number, number] | null): number[] {
  const placement = offset
    ? { sourceOrigin: cloud.sourceOrigin, sourceToProject: offset, projectToSource: offset.map((v) => -v) as [number, number, number] }
    : null;
  const placed = copyPlacedPositions(cloud, 1, placement);
  const mask = clipMaskArray(clip, placed);
  return [...mask].flatMap((m, i) => (m ? [cloud.gpsTime![i]] : []));
}

function writtenIds(): number[] {
  const c = hoisted.converted.at(-1) as unknown as PointCloud;
  return [...c.gpsTime!];
}

async function pressExport(root: FakeEl): Promise<void> {
  root.findByClass('olv-export-btn')[0].fire('click');
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

function enableFullRes(root: FakeEl): void {
  const label = root.findByClass('olv-export-fullres-label')
    .find((l) => l.textContent.includes('Convert at full resolution'));
  const box = label!.children[0];
  box.checked = true;
  box.fire('change');
}

describe('clipped export of a placed layer', () => {
  it('clipCloud keeps the points shown inside the project-frame box', () => {
    const cloud = placedLayer();
    const out = clipCloud(cloud, clipAt100, OFFSET);
    expect([...out.gpsTime!]).toEqual(shownIds(cloud, clipAt100, OFFSET));
    expect([...out.gpsTime!]).toEqual([1]);
    expect([...out.classification!]).toEqual([2]);
    // Output stays source-local.
    expect([...out.positions]).toEqual([0, 0, 0]);
    expect(out.sourceOrigin).toEqual([500000, 0, 0]);
  });

  it('clipCloud with no offset is unchanged for a single unplaced layer', () => {
    const cloud = placedLayer();
    expect([...clipCloud(cloud, clipAt100).gpsTime!]).toEqual([2]);
    expect([...clipCloud(cloud, clipAt100, [0, 0, 0]).gpsTime!]).toEqual([2]);
    expect([...clipCloud(cloud, clipAt100).gpsTime!]).toEqual(shownIds(cloud, clipAt100, null));
  });

  it('the panel writes the point shown on screen, not the one at the same local coordinates', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = placedLayer();
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => cloud,
      getActiveClip: () => clipAt100,
      getActiveClipOffset: () => OFFSET,
      getActiveScanId: () => 'b',
    });
    await pressExport(panel.element as unknown as FakeEl);
    expect(writtenIds()).toEqual(shownIds(cloud, clipAt100, OFFSET));
    expect(writtenIds()).toEqual([1]);
    const c = hoisted.converted.at(-1) as unknown as PointCloud;
    expect([...c.classification!]).toEqual([2]);
    expect(c.worldXYZ(0)[0]).toBe(500000);
  });

  it('a full-resolution re-decode with a different source origin still writes the shown point', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const display = placedLayer([500000, 0, 0]);
    // Same points, stated against an origin 50 m further east.
    const full = new PointCloud({
      positions: new Float32Array([-50, 0, 0, 50, 0, 0]),
      classification: new Uint8Array([2, 6]),
      gpsTime: new Float64Array([1, 2]),
      origin: [500050, 0, 0],
      sourceFormat: 'las',
      name: 'placed.las',
    });
    const panel = new ExportPanel({
      getCloud: () => display,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => full,
      getActiveClip: () => clipAt100,
      getActiveClipOffset: () => OFFSET,
      getActiveScanId: () => 'b',
    });
    const root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    await pressExport(root);
    expect(writtenIds()).toEqual(shownIds(display, clipAt100, OFFSET));
  });

  it('an unplaced single layer exports as before', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = placedLayer();
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => cloud,
      getActiveClip: () => clipAt100,
      getActiveClipOffset: () => null,
      getActiveScanId: () => 'a',
    });
    await pressExport(panel.element as unknown as FakeEl);
    expect(writtenIds()).toEqual([2]);
    expect(writtenIds()).toEqual(shownIds(cloud, clipAt100, null));
  });
});
