/**
 * analysePanelScanIdentity.test.ts
 *
 * A terrain result is cleared only when the session resets. Opening a SECOND
 * scan additively leaves the first scan's contours, DEM and report on screen
 * while the host's map context and filename have already moved to the new scan —
 * so an export written then carries A's geometry with B's world origin, CRS,
 * linear unit and name. No race is involved: it reproduces every time.
 *
 * These tests pin the binding that stops it — the result remembers the scan it
 * was computed on, and every export path refuses when that is no longer the
 * active scan — and pin that the refusal is a refusal, not a silent clear: the
 * user's analysis stays on screen with the reason shown.
 *
 * Driven with a REAL analysis result (same approach as
 * analysePanelCoverageTile.test.ts) in the node environment via a DOM stub.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { TERRAIN_RESULT_FOREIGN_SCAN_REFUSAL } from '../src/export/exportScanIdentity';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import type { ContourExportPermit } from '../src/export/contourExportPermit';

const hoisted = vi.hoisted(() => ({ downloads: [] as string[] }));

vi.mock('../src/io/download', () => ({
  triggerDownload: (_blob: unknown, filename: string) => { hoisted.downloads.push(filename); },
  downloadBytes: (filename: string) => { hoisted.downloads.push(filename); },
}));

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  width = 0;
  height = 0;
  href = '';
  download = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    add(): void { /* no-op */ },
    remove(): void { /* no-op */ },
    toggle(): void { /* no-op */ },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  removeAttribute(): void { /* no-op */ }
  getContext(): null { return null; }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 0, height: 0, left: 0, top: 0 };
  }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** Every descendant carrying `cls` in its own className. */
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
  (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
});

beforeEach(() => { hoisted.downloads.length = 0; });

/** A small hill, enough for a real analysis with contours. */
function hillScene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 30; x++) {
    for (let y = 0; y <= 30; y++) {
      const dx = x - 15;
      const dy = y - 15;
      pts.push({ x, y, z: 6 * Math.exp(-(dx * dx + dy * dy) / 200) });
    }
  }
  return pts;
}

/** The private export surface these tests drive directly (no Studio mount). */
interface ExportInternals {
  _resultScanId: string | null;
  _refuseForeignScanExport(): boolean;
  _exportDemPackage(btn: unknown): Promise<void>;
  _exportTerrainReport(btn: unknown): Promise<void>;
  _exportContourFormat(fmt: string, btn?: unknown, extra?: unknown): Promise<void>;
  _exportCompletePackage(permit: unknown, intent: unknown): Promise<void>;
}

/** A panel holding an analysis of scan A, plus the levers to move the session. */
async function panelWithResultForScanA() {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  let activeId: string | null = 'scan-a';
  let basename = 'scan-a';
  /** Every map-context read, so a test can prove a refusal happened FIRST. */
  const mapContextReads: string[] = [];
  const panel = new AnalysePanel({
    getActiveScanId: () => activeId,
    getExportBasename: () => basename,
    getMapContext: () => {
      mapContextReads.push(basename);
      return { worldOrigin: { x: 1, y: 2, z: 3 }, linearUnit: 'metre' as const };
    },
  });
  panel.update(analyseContours(hillScene(), {
    cellSizeM: 2,
    crs: 'EPSG:32610',
    verticalDatum: 'EPSG:5703',
  }));
  return {
    panel,
    internals: panel as unknown as ExportInternals,
    root: panel.element as unknown as FakeEl,
    mapContextReads,
    /** The additive open of a second scan: active id + basename both move. */
    openScanB: (): void => { activeId = 'scan-b'; basename = 'scan-b'; },
    setActiveId: (id: string | null): void => { activeId = id; },
  };
}

const grantedPermit = { ok: true, decision: {} } as unknown as ContourExportPermit;

function noticeText(root: FakeEl): string {
  return root.findByClass('olv-analyse-stale-notice')[0]?.textContent ?? '';
}

describe('AnalysePanel — a result belongs to the scan it was computed on', () => {
  it('stamps the active scan onto the result when it lands', async () => {
    const { internals } = await panelWithResultForScanA();
    expect(internals._resultScanId).toBe('scan-a');
  });

  it('clears the stamp when the result is cleared', async () => {
    const { panel, internals } = await panelWithResultForScanA();
    panel.update(null);
    expect(internals._resultScanId).toBe(null);
  });

  it('refuses the DEM package once another scan is active', async () => {
    const { internals, root, mapContextReads, openScanB } = await panelWithResultForScanA();
    mapContextReads.length = 0;
    openScanB();
    await internals._exportDemPackage(new FakeEl('button'));

    expect(hoisted.downloads, 'a raster was written for the wrong scan').toEqual([]);
    // Refused BEFORE the frame was read: had it been read, the .prj / README
    // would already be describing scan B.
    expect(mapContextReads).toEqual([]);
    expect(noticeText(root)).toBe(TERRAIN_RESULT_FOREIGN_SCAN_REFUSAL);
  });

  it('refuses the intelligence report once another scan is active', async () => {
    const { internals, root, openScanB } = await panelWithResultForScanA();
    openScanB();
    await internals._exportTerrainReport(new FakeEl('button'));
    expect(hoisted.downloads).toEqual([]);
    expect(noticeText(root)).toBe(TERRAIN_RESULT_FOREIGN_SCAN_REFUSAL);
  });

  it('refuses a contour vector export once another scan is active', async () => {
    const { internals, root, mapContextReads, openScanB } = await panelWithResultForScanA();
    mapContextReads.length = 0;
    openScanB();
    await internals._exportContourFormat('geojson', undefined, { permit: grantedPermit });
    expect(hoisted.downloads).toEqual([]);
    expect(mapContextReads).toEqual([]);
    expect(noticeText(root)).toBe(TERRAIN_RESULT_FOREIGN_SCAN_REFUSAL);
  });

  it('refuses the complete deliverable once another scan is active', async () => {
    const { internals, root, openScanB } = await panelWithResultForScanA();
    openScanB();
    await internals._exportCompletePackage(grantedPermit, {
      shapeStyle: 'analytical',
      methodTag: 'analytical',
      purpose: 'survey-review',
    });
    expect(hoisted.downloads).toEqual([]);
    expect(noticeText(root)).toBe(TERRAIN_RESULT_FOREIGN_SCAN_REFUSAL);
  });

  it('keeps the analysis on screen rather than discarding the user\'s work', async () => {
    const { panel, internals, openScanB } = await panelWithResultForScanA();
    openScanB();
    await internals._exportDemPackage(new FakeEl('button'));
    // Refuse, do not clear: re-running the analysis is the user's decision.
    expect(panel.currentResult()).not.toBeNull();
    expect(internals._resultScanId).toBe('scan-a');
  });

  it('allows the export while the originating scan is still active', async () => {
    const { internals } = await panelWithResultForScanA();
    expect(internals._refuseForeignScanExport()).toBe(false);
  });

  it('treats a streaming scan (null id) as a target of its own', async () => {
    // null is a value, not a wildcard: a result computed while a streaming scan
    // was active must not be exportable against a static scan that opened after.
    const { internals, setActiveId } = await panelWithResultForScanA();
    setActiveId(null);
    expect(internals._refuseForeignScanExport()).toBe(true);
  });
});
