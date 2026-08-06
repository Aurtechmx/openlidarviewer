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
import type { ClipBox } from '../src/render/clip/clipBox';
import { createScanService } from '../src/app/ScanService';
import { createAppContext } from '../src/app/appContext';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { Viewer } from '../src/render/Viewer';

const hoisted = vi.hoisted(() => ({
  /** Every cloud handed to the converter, so a test can see what was written. */
  converted: [] as { pointCount: number }[],
  /** Filenames that reached the browser download helper. */
  downloads: [] as string[],
}));

vi.mock('../src/lazyChunks', () => ({
  loadConvertEngine: async () => ({
    convertCloud: (cloud: { pointCount: number }) => {
      hoisted.converted.push(cloud);
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
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) { /* icons only */ }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
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
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

beforeEach(() => {
  hoisted.converted.length = 0;
  hoisted.downloads.length = 0;
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

  // ─── ROADMAP #19 — the streaming→streaming swap the guard used to miss ───
  // A streaming scan leaves `scans.activeId` null, so BOTH scans in a swap used
  // to read as null and `sameExportTarget(null, null)` passed the export. The
  // shell now mints a stable id per streaming scan and surfaces it through
  // `activeExportTargetId()`; these drive the panel through the REAL accessor so
  // the whole read path (ScanService → viewer.streamingCloud.id) is under test.

  /** A viewer stub exposing only the streaming cloud the service reads. */
  function streamingViewer(current: () => StreamingSource | null): Viewer {
    return {
      getCloud: () => undefined,
      get streamingCloud() {
        return current();
      },
    } as unknown as Viewer;
  }
  const streamingScan = (id: string): StreamingSource => ({ id }) as unknown as StreamingSource;

  it('refuses when one streaming scan is swapped for another during the re-decode', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const { EXPORT_SCAN_CHANGED_REFUSAL } = await import('../src/export/exportScanIdentity');
    const cloud = twoPointCloud();
    // Streaming throughout — activeId is never set, so the OLD wiring would have
    // read null both before and after and written the file. The mint is what
    // makes the swap visible.
    let streaming: StreamingSource | null = streamingScan('streaming-scan_1');
    const scans = createScanService({
      getViewer: () => streamingViewer(() => streaming),
      context: createAppContext(),
    });
    expect(scans.activeId, 'streaming leaves activeId null (safety pin)').toBeNull();
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => {
        streaming = streamingScan('streaming-scan_2'); // user opened another streaming scan
        return cloud;
      },
      getActiveScanId: () => scans.activeExportTargetId(),
    });
    const root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    await pressExport(root);

    expect(hoisted.downloads, 'a file was written despite the streaming swap').toEqual([]);
    expect(statusText(root)).toBe(EXPORT_SCAN_CHANGED_REFUSAL);
  });

  it('exports when the SAME streaming scan stays active through the re-decode (no false refusal)', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const cloud = twoPointCloud();
    const streaming = streamingScan('streaming-scan_1');
    const scans = createScanService({
      getViewer: () => streamingViewer(() => streaming),
      context: createAppContext(),
    });
    const panel = new ExportPanel({
      getCloud: () => cloud,
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => cloud, // same streaming scan the whole time
      hasClassEdits: () => false,
      getActiveScanId: () => scans.activeExportTargetId(),
    });
    const root = panel.element as unknown as FakeEl;
    enableFullRes(root);
    await pressExport(root);

    expect(hoisted.downloads).toEqual(['scan.las']);
    expect(hoisted.converted[0].pointCount).toBe(2);
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
    expect(statusText(root)).toMatch(/clipped to box/);
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
