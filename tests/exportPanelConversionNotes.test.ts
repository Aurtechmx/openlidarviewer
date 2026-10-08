/**
 * The Export panel and the batch converter list every warning of a
 * conversion, not only the first, and the LAS 1.2 write refuses a clipped scan
 * angle or a dropped scanner channel until the request allows it. Node
 * environment via the recording DOM stub; the converter is the real one.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { LEGACY_ACQUISITION_LOSS_OPT_IN, LEGACY_CLASS_WRAP_OPT_IN, LEGACY_OVERLAP_DROP_OPT_IN } from '../src/convert/types';
import { convertCloud } from '../src/convert/convertCloud';
import { exportedLine } from '../src/ui/conversionNotes';
import {
  installFakeDom,
  pickFormat,
  checkRow,
  setCheckbox,
  panelFor,
  exportStatus as status,
  pressExport,
  FakeEl as FakeElCtor,
  type FakeEl,
} from './helpers/exportPanelHarness';

const hoisted = vi.hoisted(() => ({ downloads: [] as { name: string; bytes: Uint8Array }[] }));

vi.mock('../src/io/download', () => ({
  downloadBytes: (name: string, bytes: Uint8Array) => { hoisted.downloads.push({ name, bytes }); },
  triggerDownload: () => { /* unused here */ },
}));

beforeAll(() => { installFakeDom(); });
beforeEach(() => { hoisted.downloads.length = 0; });

/** Four independent losses on a LAS 1.2 write: wrap, overlap, clipped angle, dropped channel. */
function lossyCloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 1, 1, 1]),
    origin: [500000, 4100000, 0],
    classification: Uint8Array.from([64, 2]),
    classificationFlags: Uint8Array.from([8, 0]),
    scanAngle: Float32Array.from([120, 5]),
    scannerChannel: Uint8Array.from([2, 0]),
    sourceFormat: 'las',
    name: 'survey.las',
    metadata: { pointFormat: 6 },
  });
}

const notes = (root: FakeEl): FakeEl | undefined => root.findByClass('olv-export-notes')[0];
const noteTexts = (root: FakeEl): string[] => root.findByClass('olv-conv-note').map((n) => n.textContent);

describe('ExportPanel: every warning is listed', () => {
  it('shows all four warnings and a count in the status line', async () => {
    const root = await panelFor(lossyCloud());
    pickFormat(root, 'LAS 1.2');
    setCheckbox(root, LEGACY_CLASS_WRAP_OPT_IN, true);
    setCheckbox(root, LEGACY_ACQUISITION_LOSS_OPT_IN, true);
    setCheckbox(root, LEGACY_OVERLAP_DROP_OPT_IN, true);
    await pressExport(root);

    expect(hoisted.downloads).toHaveLength(1);
    expect(status(root).textContent).toBe('Exported 2 points with 4 warnings · no CRS recorded (coordinates unchanged)');
    expect(status(root).className).toContain('is-warn');
    const texts = noteTexts(root);
    expect(texts).toHaveLength(4);
    expect(texts.some((t) => /classes > 31|class > 31/.test(t))).toBe(true);
    expect(texts.some((t) => /overlap flag/.test(t))).toBe(true);
    expect(texts.some((t) => /scan angle as -90 to 90/.test(t))).toBe(true);
    expect(texts.some((t) => /no scanner channel field/.test(t))).toBe(true);
    // The list is open and sits under an announced status.
    expect(root.findByClass('olv-conv-notes')[0].attrs.open).toBeDefined();
    expect(status(root).attrs.role).toBe('status');
  });

  it('shows no list when nothing was warned about', async () => {
    const plain = new PointCloud({ positions: new Float32Array([0, 0, 0]), origin: [0, 0, 0], sourceFormat: 'las', name: 'p.las' });
    const root = await panelFor(plain);
    await pressExport(root);
    expect(status(root).textContent).toMatch(/^Exported 1 point/);
    expect(notes(root)!.children).toHaveLength(0);
  });

  it('clears the list when the next export is refused', async () => {
    const root = await panelFor(lossyCloud());
    pickFormat(root, 'LAS 1.2');
    setCheckbox(root, LEGACY_CLASS_WRAP_OPT_IN, true);
    setCheckbox(root, LEGACY_ACQUISITION_LOSS_OPT_IN, true);
    setCheckbox(root, LEGACY_OVERLAP_DROP_OPT_IN, true);
    await pressExport(root);
    expect(noteTexts(root)).toHaveLength(4);
    setCheckbox(root, LEGACY_ACQUISITION_LOSS_OPT_IN, false);
    await pressExport(root);
    expect(noteTexts(root)).toHaveLength(0);
    expect(status(root).className).toContain('is-error');
  });
});

describe('ExportPanel: the acquisition-loss opt-in', () => {
  it('is shown only for LAS 1.2', async () => {
    const root = await panelFor(lossyCloud());
    const row = (): FakeEl | undefined => checkRow(root, LEGACY_ACQUISITION_LOSS_OPT_IN);
    expect(row()!.hidden).toBe(true);
    pickFormat(root, 'LAS 1.2');
    expect(row()!.hidden).toBe(false);
  });

  it('refuses the write without it, names the control, and writes no file', async () => {
    const root = await panelFor(lossyCloud());
    pickFormat(root, 'LAS 1.2');
    setCheckbox(root, LEGACY_CLASS_WRAP_OPT_IN, true);
    setCheckbox(root, LEGACY_OVERLAP_DROP_OPT_IN, true);
    await pressExport(root);
    expect(hoisted.downloads).toEqual([]);
    expect(status(root).className).toContain('is-error');
    expect(status(root).textContent).toContain(LEGACY_ACQUISITION_LOSS_OPT_IN);
    expect(status(root).textContent).toMatch(/1 point has a scan angle that rounds beyond 90 degrees/);
    expect(status(root).textContent).toMatch(/1 point carries a scanner channel/);
  });

  it('writes LAS 1.4 without it', async () => {
    const root = await panelFor(lossyCloud());
    await pressExport(root);
    expect(hoisted.downloads).toHaveLength(1);
    expect(status(root).className).not.toContain('is-error');
  });
});

describe('batch converter: every warning is listed', () => {
  it('renders each warning of a result under its row', async () => {
    const { BatchConverter } = await import('../src/ui/BatchConverter');
    const host = new FakeElCtor('div');
    const bc = new BatchConverter(host as unknown as HTMLElement);
    const report = convertCloud(lossyCloud(), { format: 'las', allowLegacyClassWrap: true, allowLegacyAcquisitionLoss: true, allowLegacyOverlapDrop: true });
    (bc as unknown as { _renderResults(r: unknown[]): void })._renderResults([
      { source: 'survey.las', report: report.report, file: report.file },
    ]);
    const items = host.findByClass('olv-conv-note').map((n) => n.textContent);
    expect(items).toHaveLength(4);
    expect(items).toEqual(report.report.log.filter((l) => l.level === 'warn').map((l) => l.message));
  });
});

describe('exportedLine', () => {
  it('names the count and keeps the clip scope', () => {
    expect(exportedLine(1, 1, '1 warning', ' · clipped')).toBe('Exported 1 point with 1 warning · clipped');
    expect(exportedLine(3, 0, '', ' · clipped')).toBe('Exported 3 points · clipped');
    expect(exportedLine(2, 1, '1 warning', '', 'reprojected to EPSG:32614')).toBe('Exported 2 points with 1 warning · reprojected to EPSG:32614');
  });
});
