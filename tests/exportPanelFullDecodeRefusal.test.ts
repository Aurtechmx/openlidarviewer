/**
 * The Export panel refuses to write a full-resolution export whose re-decode
 * did not read every point, and states the counts it did read.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl } from './helpers/exportPanelPillDomFake';

const cap = vi.hoisted(() => ({ converted: 0 }));
vi.mock('../src/lazyChunks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadConvertEngine: async () => ({
    convertCloud: () => {
      cap.converted++;
      return { file: null, report: {} };
    },
    resolveExportDigests: async () => undefined,
  }),
}));

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

async function runFullExport(full: unknown): Promise<string> {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const display = { pointCount: 10, declaredPointCount: 100, sourceOrigin: [0, 0, 0], sourceFormat: 'las', metadata: {} };
  const panel = new ExportPanel({
    getCloud: () => display,
    hasFullSource: () => true,
    isReduced: () => true,
    getFullCloud: async () => full,
    exportMeasurements: async () => {},
    measurementCount: () => 0,
  } as never);
  const p = panel as unknown as { _fullRes: boolean; _export(): Promise<void>; _status: FakeEl };
  p._fullRes = true;
  await p._export();
  return p._status.textContent;
}

describe('ExportPanel full-resolution shortfall', () => {
  it('refuses a truncated re-decode and writes nothing', async () => {
    cap.converted = 0;
    const text = await runFullExport({
      pointCount: 60, declaredPointCount: 100, loadStride: 1, sourceOrigin: [0, 0, 0], sourceFormat: 'las',
      metadata: { truncation: { read: 60, declared: 100 } },
    });
    expect(text).toBe('The source file ends after 60 of its 100 declared points, so nothing was exported as the full file.');
    expect(cap.converted).toBe(0);
  });

  it('refuses a strided re-decode and writes nothing', async () => {
    cap.converted = 0;
    const text = await runFullExport({
      pointCount: 50, declaredPointCount: 100, loadStride: 2, sourceOrigin: [0, 0, 0], sourceFormat: 'e57', metadata: {},
    });
    expect(text).toMatch(/one record in 2/);
    expect(cap.converted).toBe(0);
  });

  it('a complete re-decode reaches the converter', async () => {
    cap.converted = 0;
    await runFullExport({ pointCount: 100, declaredPointCount: 100, loadStride: 1, sourceOrigin: [0, 0, 0], sourceFormat: 'las', metadata: {} });
    expect(cap.converted).toBe(1);
  });
});
