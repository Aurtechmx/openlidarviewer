/**
 * exportProductContours.test.ts
 *
 * The Export mode's map sheet button runs the Contour Studio PDF export through
 * the export adapter. These cases cover what the press leads to: the dialog
 * under a granted permit, the gate's own reason when the permit is refused, one
 * dialog per press, a press overtaken by a new analysis, a second Export in the
 * same dialog, and the panel's quick-export style after a cancel.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import type { AnalyseContoursResult, TerrainCoreParams } from '../src/terrain/contour/analyseContours';
import type { LaunchFrameContext } from '../src/terrain/contourStudio/contourStudioLaunchStateFromResult';

const hoisted = vi.hoisted(() => ({
  downloads: [] as { name: string; blob: Blob }[],
  modals: [] as { footer: unknown; body: unknown; closed: number; close: () => void }[],
}));

vi.mock('../src/io/download', () => ({
  triggerDownload: (blob: Blob, name: string) => { hoisted.downloads.push({ name, blob }); },
  downloadBytes: () => {},
}));

vi.mock('../src/ui/Modal', () => ({
  FOCUSABLE: '',
  focusableIn: () => [],
  openModal: (opts: { footer: unknown; body: unknown; onClose?: () => void }) => {
    const rec = {
      footer: opts.footer,
      body: opts.body,
      closed: 0,
      close: () => {
        if (rec.closed++ === 0) opts.onClose?.();
      },
    };
    hoisted.modals.push(rec);
    return { close: rec.close, dialog: opts.body };
  },
}));

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

type Listener = () => void;
const listeners = new WeakMap<FakeEl, Map<string, Listener[]>>();

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
  FakeEl.prototype.addEventListener = function (this: FakeEl, type: string, fn: Listener): void {
    const m = listeners.get(this) ?? new Map<string, Listener[]>();
    m.set(type, [...(m.get(type) ?? []), fn]);
    listeners.set(this, m);
  } as FakeEl['addEventListener'];
});
beforeEach(() => {
  hoisted.downloads.length = 0;
  hoisted.modals.length = 0;
});

function fire(node: FakeEl, type: string): void {
  for (const fn of listeners.get(node)?.get(type) ?? []) fn();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Wait for the dialog's Export to finish: a download, or the error line shown. */
async function exported(errLine: FakeEl, downloads: number): Promise<void> {
  const until = Date.now() + 15_000;
  while (Date.now() < until && hoisted.downloads.length === downloads && errLine.style.display === 'none') {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function slope(): Float32Array {
  const pts: number[] = [];
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) pts.push(x * 0.5, y * 0.5, 50 + 0.4 * x + 0.2 * y);
  }
  return new Float32Array(pts);
}

function analyse(): AnalyseContoursResult {
  const params: TerrainCoreParams = { cellSizeM: 1, crs: 'EPSG:32610', verticalUnitToMetres: 1 };
  return contoursFromCore(computeTerrainCore(slope(), params), { intervalM: 0.5 });
}

const CTX: LaunchFrameContext = {
  streaming: false,
  crsProjected: true,
  crsKind: 'projected',
  verticalUnitsKnown: true,
  verticalUnitToMetres: 1,
  verticalUnitLabel: 'm',
  precision: null,
};

interface Internals {
  _contourFrame: LaunchFrameContext | null;
  _contourStyle: string;
  update(r: AnalyseContoursResult): void;
  exportProduct(
    kind: 'contours',
    btn?: unknown,
  ): { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
}

async function panel(opts: { scan?: () => string; result?: AnalyseContoursResult } = {}): Promise<Internals> {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const p = new AnalysePanel({
    getActiveScanId: opts.scan ?? (() => 'scan-a'),
    getExportBasename: () => 'site',
    getMapContext: () => ({ worldOrigin: { x: 0, y: 0, z: 0 }, linearUnit: 'metre' as const }),
  }) as unknown as Internals;
  const result = opts.result ?? analyse();
  expect(result.model.features.length).toBeGreaterThan(0);
  expect(result.quality.exportReadiness).not.toBe('blocked');
  p.update(result);
  p._contourFrame = CTX;
  return p;
}

function dialog(i = -1) {
  const rec = hoisted.modals.at(i);
  if (!rec) throw new Error('no dialog opened');
  const footer = rec.footer as FakeEl;
  return {
    rec,
    exportBtn: footer.findByText('Export PDF')[0],
    cancelBtn: footer.findByText('Cancel')[0],
    errLine: footer.findByClass('olv-modal-error')[0],
  };
}

describe('exportProduct(contours) through the export adapter', () => {
  it('opens the map sheet dialog under a granted permit and writes the PDF', async () => {
    const p = await panel();
    const outcome = await p.exportProduct('contours', new FakeEl('button'));
    await settle();
    expect(outcome).toEqual({ ok: true });
    expect(hoisted.modals).toHaveLength(1);
    fire(dialog().exportBtn, 'click');
    await exported(dialog().errLine, 0);
    expect(dialog().errLine.textContent).toBe('');
    expect(hoisted.downloads).toHaveLength(1);
    expect(hoisted.downloads[0].blob.type).toBe('application/pdf');
  });

  it('returns the gate reason when the Studio launch state is unavailable', async () => {
    const r = analyse();
    const total = r.cellStatusTally.total;
    const unsupported = { ...r, cellStatusTally: { ...r.cellStatusTally, empty: Math.ceil(total * 0.9) } };
    const p = await panel({ result: unsupported as AnalyseContoursResult });
    const before = p._contourStyle;
    const outcome = await p.exportProduct('contours', new FakeEl('button'));
    await settle();
    expect(p._contourStyle).toBe(before);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('too much unsupported surface');
    expect(hoisted.modals).toHaveLength(0);
  });

  it('opens one dialog for two quick presses', async () => {
    const p = await panel();
    const btn = new FakeEl('button');
    const a = p.exportProduct('contours', btn);
    const b = p.exportProduct('contours', btn);
    await Promise.all([a, b]);
    await settle();
    expect(hoisted.modals).toHaveLength(1);
  });

  it('says the analysis changed when a new result lands before the export starts', async () => {
    const p = await panel();
    const pending = p.exportProduct('contours', new FakeEl('button'));
    p.update(analyse());
    p._contourFrame = CTX;
    const outcome = await pending;
    await settle();
    expect(outcome).toEqual({ ok: false, reason: 'The analysis changed. Press again.' });
    expect(hoisted.modals).toHaveLength(0);
  });

  it('writes the sheet on a second Export after a refusal in the same dialog', async () => {
    let scan = 'scan-a';
    const p = await panel({ scan: () => scan });
    const before = p._contourStyle;
    await p.exportProduct('contours', new FakeEl('button'));
    await settle();
    const d = dialog();
    scan = 'scan-b';
    fire(d.exportBtn, 'click');
    await exported(d.errLine, 0);
    expect(hoisted.downloads).toHaveLength(0);
    expect(d.errLine.textContent).toMatch(/different scan/);
    expect(p._contourStyle).toBe(before);
    scan = 'scan-a';
    d.errLine.style.display = 'none';
    fire(d.exportBtn, 'click');
    await exported(d.errLine, 0);
    expect(hoisted.downloads).toHaveLength(1);
    expect(d.rec.closed).toBe(1);
  });

  it('leaves the quick-export style as it was after a cancel', async () => {
    const p = await panel();
    const before = p._contourStyle;
    await p.exportProduct('contours', new FakeEl('button'));
    await settle();
    fire(dialog().cancelBtn, 'click');
    expect(p._contourStyle).toBe(before);
  });
});
