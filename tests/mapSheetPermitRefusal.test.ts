/**
 * mapSheetPermitRefusal.test.ts
 *
 * The contour map sheet is written only under a granted evidence permit. When
 * the dialog's Export runs without one, nothing downloads, and the dialog must
 * say so: it stays open, shows why in its error line, and keeps none of the
 * entered values as if the sheet had been written.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import type { TerrainCoreParams } from '../src/terrain/contour/analyseContours';

const hoisted = vi.hoisted(() => ({
  downloads: [] as { name: string; blob: Blob }[],
  modals: [] as { footer: unknown; body: unknown; closed: number }[],
}));

vi.mock('../src/io/download', () => ({
  triggerDownload: (blob: Blob, name: string) => { hoisted.downloads.push({ name, blob }); },
  downloadBytes: () => {},
}));

vi.mock('../src/ui/Modal', () => ({
  FOCUSABLE: '',
  focusableIn: () => [],
  openModal: (opts: { footer: unknown; body: unknown; onClose?: () => void }) => {
    const rec = { footer: opts.footer, body: opts.body, closed: 0 };
    hoisted.modals.push(rec);
    return {
      close: () => {
        if (rec.closed++ === 0) opts.onClose?.();
      },
      dialog: opts.body,
    };
  },
}));

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

type Listener = () => void;
const listeners = new WeakMap<FakeEl, Map<string, Listener[]>>();

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
  // The stub drops listeners; the dialog is driven through its own buttons, so
  // record them here and fire them on demand.
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

function slope(): Float32Array {
  const pts: number[] = [];
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) pts.push(x * 0.5, y * 0.5, 50 + 0.4 * x + 0.2 * y);
  }
  return new Float32Array(pts);
}

interface Internals {
  _openMapPdfDialog(btn: unknown): void;
  _contourPdfPermit: unknown;
}

async function panel(): Promise<Internals> {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const p = new AnalysePanel({
    getActiveScanId: () => 'scan-a',
    getExportBasename: () => 'site',
    getMapContext: () => ({ worldOrigin: { x: 0, y: 0, z: 0 }, linearUnit: 'metre' as const }),
  });
  const params: TerrainCoreParams = { cellSizeM: 1, crs: 'EPSG:32610', verticalUnitToMetres: 1 };
  const result = contoursFromCore(computeTerrainCore(slope(), params), { intervalM: 0.5 });
  expect(result.model.features.length).toBeGreaterThan(0);
  expect(result.quality.exportReadiness).not.toBe('blocked');
  p.update(result);
  return p as unknown as Internals;
}

function openDialog(p: Internals): { footer: FakeEl; exportBtn: FakeEl; errLine: FakeEl; prepared: FakeEl & { value: string }; closed: () => number } {
  p._openMapPdfDialog(new FakeEl('button'));
  const rec = hoisted.modals.at(-1);
  if (!rec) throw new Error('the map sheet dialog did not open');
  const footer = rec.footer as FakeEl;
  const body = rec.body as FakeEl;
  const exportBtn = footer.findByText('Export PDF')[0];
  const errLine = footer.findByClass('olv-modal-error')[0];
  const prepared = body
    .findByClass('olv-modal-input')
    .find((n) => (n as unknown as { placeholder?: string }).placeholder?.startsWith('Name or organisation')) as
    | (FakeEl & { value: string })
    | undefined;
  if (!exportBtn || !errLine || !prepared) throw new Error('the dialog is missing its controls');
  return { footer, exportBtn, errLine, prepared, closed: () => rec.closed };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('map sheet dialog without a granted permit', () => {
  it('stays open, says why, writes nothing and keeps none of the entered values', async () => {
    const p = await panel();
    p._contourPdfPermit = null;
    const d = openDialog(p);
    d.prepared.value = 'Field crew 7';
    fire(d.exportBtn, 'click');
    await settle();

    expect(hoisted.downloads).toHaveLength(0);
    expect(d.closed()).toBe(0);
    expect(d.errLine.style.display).not.toBe('none');
    expect(d.errLine.textContent).toMatch(/not exported/i);
    expect(d.errLine.textContent).toMatch(/Contour Studio/);
    expect(d.exportBtn.disabled).toBe(false);

    // Cancelled, then opened again: the new dialog has the default, not the
    // value of the refused run.
    fire(d.footer.findByText('Cancel')[0], 'click');
    expect(d.closed()).toBe(1);
    const again = openDialog(p);
    expect(again.prepared.value).toBe('');
  });
});
