/**
 * exportPanelSnapshotIntegrity.test.ts
 *
 * A full-resolution export re-decodes the source file off-thread. That takes
 * seconds, and nothing in the app is disabled while it runs — the user can
 * reclassify points, drag the clip box, or open another scan in the gap between
 * pressing Export and the bytes being written.
 *
 * These tests pin the two halves of the answer:
 *
 *   1. CAPTURE BEFORE THE AWAIT — the clip box that decides which points reach
 *      the file is the one the user had set when they pressed Export.
 *   2. VERIFY BEFORE THE WRITE — the classification gate and the active-scan
 *      identity are re-checked after the decode, and a change refuses the export
 *      instead of writing a file that silently omits the edits.
 *
 * The decode is simulated by mutating the panel's own callback state INSIDE the
 * awaited `getFullCloud`, which is exactly when a real user's edit would land.
 * Node environment via a recording DOM stub.
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
  /** Runs while the convert engine loads, the way a scan swap lands then. */
  onEngineLoad: null as (() => void) | null,
  /** The object each digest was resolved from. */
  digestKeys: [] as unknown[],
}));

vi.mock('../src/lazyChunks', () => ({
  loadConvertEngine: async () => {
    hoisted.onEngineLoad?.();
    return {
    resolveExportDigests: async (src: { key: unknown }) => (hoisted.digestKeys.push(src.key), { sourceSha256: 'a'.repeat(64), sourceSha256Note: null, crsOrigin: { source: 'unknown', name: 'unknown', epsg: 'unknown', verticalDatum: 'unknown', verticalSource: 'unknown' } }),
    convertCloud: (cloud: { pointCount: number }, options: Record<string, unknown>) => {
      hoisted.converted.push(cloud);
      hoisted.options.push(options);
      return {
        file: { filename: 'scan.las', bytes: new Uint8Array([0]), mime: 'application/octet-stream' },
        report: { pointCount: cloud.pointCount, crsNote: 'CRS kept', log: [] },
      };
    },
    };
  },
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
  hoisted.digestKeys.length = 0;
  hoisted.onEngineLoad = null;
});

/** Two points one unit apart on x, so a clip box can keep exactly one of them. */
function twoPointCloud(name = 'scan.las'): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 10, 0, 0]),
    classification: new Uint8Array([2, 2]),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name,
  });
}

/** A clip that keeps only the point at the origin. */
const keepsFirstPointOnly: ClipBox = {
  box: { min: [-1, -1, -1], max: [1, 1, 1] },
  mode: 'keep-inside',
  enabled: true,
};

/**
 * Tick the full-resolution checkbox the way a user does. The gzip row reuses the
 * same class names, so the label text is what tells the two checkboxes apart.
 */
function enableFullRes(root: FakeEl): void {
  const label = root
    .findByClass('olv-export-fullres-label')
    .find((l) => l.textContent.includes('Convert at full resolution'));
  expect(label, 'full-resolution checkbox missing').toBeDefined();
  const box = label!.children[0];
  box.checked = true;
  box.fire('change');
}

function statusText(root: FakeEl): string {
  return root.findByClass('olv-export-status')[0]?.textContent ?? '';
}

/** Click the format pill whose label contains `label` (pills are `olv-bc-pill`). */
function pickFormat(root: FakeEl, label: string): void {
  const pill = root.findByClass('olv-bc-pill')
    .find((p) => p.textContent.toLowerCase().includes(label.toLowerCase()));
  expect(pill, `format pill ${label} missing`).toBeDefined();
  pill!.fire('click');
}

/** Toggle the checkbox whose label mentions `text`. */
function setCheckbox(root: FakeEl, text: string, on: boolean): void {
  const label = root.findByClass('olv-export-fullres-label')
    .find((l) => l.textContent.toLowerCase().includes(text.toLowerCase()));
  expect(label, `checkbox "${text}" missing`).toBeDefined();
  const box = label!.children[0];
  box.checked = on;
  box.fire('change');
}

/** Press Export and wait for the async export to settle. */
async function pressExport(root: FakeEl): Promise<void> {
  root.findByClass('olv-export-btn')[0].fire('click');
  // Two macrotask turns: the decode promise, then the convert-engine import.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('ExportPanel — full-resolution export re-verifies before it writes', () => {
  it('refuses when points are reclassified during the re-decode', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = twoPointCloud();
    // No edits when Export is pressed — so the up-front gate ALLOWS this export.
    // The edit lands mid-decode, which is the whole point: the display buffer now
    // holds classes the re-decoded file cannot carry.
    let hasClassEdits = false;
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => {
        hasClassEdits = true;
        return cloud;
      },
      hasClassEdits: () => hasClassEdits,
      getActiveScanId: () => 'scan-a',
    });
    const root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    await pressExport(root);

    expect(hoisted.downloads, 'a file was written despite the mid-export edit').toEqual([]);
    expect(hoisted.converted).toEqual([]);
    expect(statusText(root)).toMatch(/reclassified while the full-resolution re-decode was running/);
    // The refusal names both lossless escapes, exactly like the up-front gate.
    expect(statusText(root)).toMatch(/convert at full resolution/);
    expect(statusText(root)).toMatch(/Include classification/);
  });

  it('refuses when the active scan changes during the re-decode', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const { EXPORT_SCAN_CHANGED_REFUSAL } = await import('../src/export/exportScanIdentity');
    const cloud = twoPointCloud();
    let activeId = 'scan-a';
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => {
        activeId = 'scan-b'; // the user opened another scan while we decoded
        return cloud;
      },
      getActiveScanId: () => activeId,
    });
    const root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    await pressExport(root);

    expect(hoisted.downloads).toEqual([]);
    expect(statusText(root)).toBe(EXPORT_SCAN_CHANGED_REFUSAL);
  });

  it('refuses when the active scan changes while the converter loads', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const { EXPORT_SCAN_CHANGED_REFUSAL } = await import('../src/export/exportScanIdentity');
    const cloudA = twoPointCloud('a.las');
    const cloudB = twoPointCloud('b.las');
    let active = { id: 'scan-a', cloud: cloudA };
    const panel = new ExportPanel({
      getCloud: () => active.cloud,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => active.cloud,
      getActiveScanId: () => active.id,
    });
    hoisted.onEngineLoad = () => { active = { id: 'scan-b', cloud: cloudB }; };
    const root = panel.element as unknown as FakeEl;
    await pressExport(root);

    // The digest describes the scan whose points were captured, and the
    // export refuses rather than writing a file once the scan has moved.
    expect(hoisted.digestKeys).not.toContain(cloudB);
    expect(hoisted.downloads).toEqual([]);
    expect(statusText(root)).toBe(EXPORT_SCAN_CHANGED_REFUSAL);
  });

  it('clips with the box captured BEFORE the decode, not the one set during it', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = twoPointCloud();
    // Enabled when Export is pressed (keeps 1 of 2 points); cleared mid-decode.
    // Reading the clip after the await would export both points — a file the
    // user never asked for, in a session where the box was active at request time.
    let clip: ClipBox | null = keepsFirstPointOnly;
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => {
        clip = null;
        return cloud;
      },
      getActiveClip: () => clip,
      getActiveScanId: () => 'scan-a',
    });
    const root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    await pressExport(root);

    expect(hoisted.downloads).toEqual(['scan.las']);
    expect(hoisted.converted.length).toBe(1);
    expect(hoisted.converted[0].pointCount, 'the post-await clip was used').toBe(1);
    expect(statusText(root)).toMatch(/Clipped: 1 of [\d,]+ points/);
  });

  it('exports normally when nothing moved during the decode', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = twoPointCloud();
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => cloud,
      hasClassEdits: () => false,
      getActiveScanId: () => 'scan-a',
    });
    const root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    await pressExport(root);

    expect(hoisted.downloads).toEqual(['scan.las']);
    expect(hoisted.converted[0].pointCount).toBe(2);
    // The source digest rides into the converter for the LAS provenance record.
    expect((hoisted.options[0].digests as { sourceSha256: string }).sourceSha256).toBe('a'.repeat(64));
  });

  it('still exports when the host supplies no scan identity (older wiring)', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = twoPointCloud();
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => null,
    });
    const root = panel.element as unknown as FakeEl;
    await pressExport(root);

    expect(hoisted.downloads).toEqual(['scan.las']);
  });
});

describe('ExportPanel — the request is frozen at click time', () => {
  /**
   * Only the Export BUTTON is disabled while an export runs. The format pills,
   * the CRS pills, both checkboxes and the EPSG inputs stay live, and every one
   * of those was read AFTER the multi-second full-resolution decode. So the file
   * could be written to a request the user never made: pressed as LAS, written
   * as XYZ; pressed with classification excluded, written with it included.
   */
  it('converts with the format chosen at click time, not one picked mid-decode', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = twoPointCloud();
    let root!: FakeEl;
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => {
        // The user changes their mind while the decode runs.
        pickFormat(root, 'xyz');
        return cloud;
      },
      getActiveScanId: () => 'scan-a',
    });
    root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    pickFormat(root, 'las');
    await pressExport(root);

    expect(hoisted.options.length, 'the export should have run').toBe(1);
    expect(hoisted.options[0].format, 'the mid-decode format reached the writer').not.toBe('xyz');
  });

  it('never writes classification the request excluded', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = twoPointCloud();
    let root!: FakeEl;
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => {
        // Re-ticked AFTER the class gate has already judged the request.
        setCheckbox(root, 'classification', true);
        return cloud;
      },
      getActiveScanId: () => 'scan-a',
    });
    root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    setCheckbox(root, 'classification', false);
    await pressExport(root);

    if (hoisted.options.length > 0) {
      // Either the request's own choice was honoured...
      expect(hoisted.options[0].omitClassification).toBe(true);
    } else {
      // ...or the transaction refused. Both are honest; a silent mix is not.
      expect(statusText(root)).toMatch(/scan|classification|refus/i);
    }
  });

  it('a clean run still exports, so the freeze is not a blanket refusal', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = twoPointCloud();
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => cloud,
      getActiveScanId: () => 'scan-a',
    });
    const root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    await pressExport(root);
    expect(hoisted.downloads.length).toBe(1);
  });
});

// The clip box is in the project frame; a placed layer's buffer is source-local.
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
