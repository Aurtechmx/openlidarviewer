/**
 * mapSheetNotes.test.ts: the map sheet dialog's Notes and Prepared by. A
 * generated note is made again from the scan, CRS and interval drawn; typed
 * text stays with the scan it was typed for; Prepared by is suggested from the
 * company details and never written back.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import type { AnalyseContoursResult, TerrainCoreParams } from '../src/terrain/contour/analyseContours';

vi.mock('../src/io/download', async () => (await import('./helpers/mapSheetDialogHarness')).downloadModuleMock());
vi.mock('../src/ui/Modal', async () => (await import('./helpers/mapSheetDialogHarness')).modalModuleMock());
const store = vi.hoisted(() => ({ remembered: null as null | Record<string, string>, writes: 0 }));
vi.mock('../src/ui/companyStore', () => ({ rememberedCompany: () => store.remembered, rememberCompany: () => { store.writes++; return true; } }));

import { FakeEl } from './helpers/analysePanelDom';
import { fire, installDialogListeners, recorded, slopePositions } from './helpers/mapSheetDialogHarness';
import { companyDetails, setCompanyDetails } from '../src/model/deliverableFields';
import { mapNotes } from '../src/render/measure/mapSheetExportOptions';

let n = 0;
let A: Scan = { id: 'a', name: 'river', crs: 'EPSG:32610' };
let B: Scan = { id: 'b', name: 'quarry', crs: 'EPSG:32613' };
beforeAll(installDialogListeners);
beforeEach(() => { recorded.modals.length = 0; store.remembered = null; store.writes = 0; setCompanyDetails({}); n++; A = { ...A, id: `a${n}` }; B = { ...B, id: `b${n}` }; });

interface Printed { notes: string; preparedBy: string }
interface Scan { id: string; name: string; crs: string }
const core = (crs: string) => computeTerrainCore(slopePositions(), { cellSizeM: 1, crs, verticalUnitToMetres: 1 } as TerrainCoreParams);

async function panelOn(first: Scan) {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  let scan = first;
  const printed: Printed[] = [];
  const regen = vi.fn(async (o: { intervalM?: number }) => contoursFromCore(core(scan.crs), { intervalM: o.intervalM }));
  const p = new AnalysePanel({
    getActiveScanId: () => scan.id, getExportBasename: () => scan.name,
    getMapContext: () => ({ worldOrigin: { x: 0, y: 0, z: 0 }, linearUnit: 'metre' as const, verticalUnitToMetres: 1 }),
    buildResultForExport: regen as never,
  });
  const live = p as unknown as {
    _openMapPdfDialog(b: unknown): void;
    _buildAndDownloadMapPdf(r: AnalyseContoursResult, o: Printed): Promise<{ ok: true }>;
  };
  live._buildAndDownloadMapPdf = async (_r, o) => { printed.push(o); return { ok: true }; };
  const open = () => {
    live._openMapPdfDialog(new FakeEl('button'));
    const rec = recorded.modals.at(-1)!;
    const inputs = (rec.body as FakeEl).findByClass('olv-modal-input') as Array<FakeEl & { value: string; placeholder?: string }>;
    const notes = inputs.find((n) => n.tagName.toLowerCase() === 'textarea')!;
    return {
      notes, prepared: inputs.find((n) => n.placeholder?.startsWith('Name or organisation'))!,
      selects: inputs.filter((n) => n.tagName.toLowerCase() === 'select'),
      close: () => fire((rec.footer as FakeEl).findByText('Cancel')[0], 'click'),
      export: async () => {
        fire((rec.footer as FakeEl).findByText('Export PDF')[0], 'click');
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
      },
    };
  };
  const analyse = (s: Scan, intervalM = 0.5) => { scan = s; p.update(contoursFromCore(core(s.crs), { intervalM })); };
  analyse(first);
  return { open, analyse, printed, regen };
}

describe('map sheet notes', () => {
  it('unedited notes follow the scan, the CRS and the interval drawn', async () => {
    const t = await panelOn(A);
    let d = t.open();
    expect(d.notes.value).toBe('Contours from river · interval 0.5 m · EPSG:32610');
    await d.export();
    t.analyse(A, 1);
    d = t.open();
    expect(d.notes.value).toBe('Contours from river · interval 1 m · EPSG:32610');
    d.close();
    t.analyse(B);
    expect(t.open().notes.value).toBe('Contours from quarry · interval 0.5 m · EPSG:32613');
  });

  it('the printed note states the interval regenerated inside the dialog, not the picked one', async () => {
    const t = await panelOn(A);
    const d = t.open();
    for (const s of d.selects) s.value = '1';
    // The picker asked for 1; what was drawn came out at 2.
    t.regen.mockImplementation(async () => contoursFromCore(core(A.crs), { intervalM: 2 }));
    await d.export();
    expect(t.regen).toHaveBeenCalled();
    expect(t.printed[0]!.notes).toBe('Contours from river · interval 2 m · EPSG:32610');
  });

  it('typed notes stay with their scan and print as typed', async () => {
    const t = await panelOn(A);
    let d = t.open();
    d.notes.value = 'Bank survey, phase 2';
    await d.export();
    expect(t.printed[0]!.notes).toBe('Bank survey, phase 2');
    t.analyse(B);
    d = t.open();
    expect(d.notes.value).toContain('quarry');
    d.close();
    t.analyse(A, 1);
    d = t.open();
    expect(d.notes.value).toBe('Bank survey, phase 2');
    d.close();
  });

  it('keeps nothing without a scan id, and forgets text put back to the generated note', () => {
    const model = { intervalM: 1, crs: null };
    mapNotes(null, 's', model, () => 1).keep('typed');
    expect(mapNotes(null, 's', model, () => 1).shown).toContain('interval 1 m');
    const n = mapNotes('z', 's', model, () => 1);
    n.keep('typed');
    expect(mapNotes('z', 's', model, () => 1).shown).toBe('typed');
    n.keep(n.shown);
    expect(mapNotes('z', 's', { intervalM: 2, crs: null }, () => 1).shown).toContain('interval 2 m');
  });
});

describe('map sheet Prepared by', () => {
  it('is suggested from the company details, follows them, and never writes back', async () => {
    store.remembered = { company: 'Remembered Co', preparedBy: 'R. Person' };
    const t = await panelOn(A);
    let d = t.open();
    expect(d.prepared.value).toBe('R. Person');
    await d.export();
    expect(t.printed[0]!.preparedBy).toBe('R. Person');
    setCompanyDetails({ company: 'Given Co' });
    d = t.open();
    expect(d.prepared.value).toBe('Given Co');
    d.prepared.value = 'Field crew 7';
    await d.export();
    expect(t.open().prepared.value).toBe('Field crew 7');
    expect(store.writes).toBe(0);
    expect(companyDetails()).toEqual({ company: 'Given Co' });
  });
});
