/**
 * The Export panel refuses a findings report when the active scan changes
 * while the export chunk is still loading, wired the way the app host wires it.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl } from './helpers/exportPanelPillDomFake';
import type { ReportFinding } from '../src/render/measure/reportManifest';
import type { FindingsPanelDeps } from '../src/ui/findingsPanel';

const cap = vi.hoisted(() => ({ deps: null as unknown }));
vi.mock('../src/lazyChunks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadFindingsPanel: async () => ({
    buildFindingsPanel: (deps: unknown) => {
      cap.deps = deps;
      return { element: new FakeEl('div'), refresh: () => {} };
    },
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('ExportPanel findings export across a scan switch', () => {
  it('refuses, and writes nothing, when the scan changes while the export chunk loads', async () => {
    const { ExportPanel } = await import('../src/ui/ExportPanel');
    const { runFindingsExport } = await import('../src/export/exportScanIdentity');
    let active = 'scan-A';
    const names: Record<string, string> = { 'scan-A': 'A.laz', 'scan-B': 'B.laz' };
    const written: string[] = [];
    let release!: () => void;
    const actions = {
      exportFindingsReport: async (d: { geo: () => unknown }) => { written.push((d.geo() as { name: string }).name); },
    };
    const deps = {
      geo: () => ({ name: names[active] }),
      activeClassificationEpoch: () => (active === 'scan-A' ? 1 : 2),
      measure: { crsKnown: true, geographicCrs: false },
    };
    const panel = new ExportPanel({
      getCloud: () => null,
      hasFullSource: () => false,
      isReduced: () => false,
      getFullCloud: async () => null,
      exportMeasurements: async () => {},
      measurementCount: () => 1,
      activeFindingsTargetId: () => active,
      collectMeasurementFindings: async () => [{ label: 'on A', value: 1, unit: 'm' }] as ReportFinding[],
      // As src/main.ts wires it.
      exportFindingsReport: (f: readonly ReportFinding[], isCurrent: () => boolean) =>
        runFindingsExport(() => new Promise<typeof actions>((r) => { release = () => r(actions); }), deps, f, isCurrent),
    } as never);
    await flush();
    const p = cap.deps as FindingsPanelDeps;
    expect(p).toBeTruthy();
    const added = await p.collectMeasurements();
    for (const f of added) p.findings.add(f);
    expect(p.findings.count).toBe(1);

    const result = p.exportReport(p.findings.all);
    active = 'scan-B';
    release();
    expect(await result).toBe('refused');
    expect(written).toEqual([]);
    const text = (panel.element as unknown as FakeEl).textContent;
    expect(text).toMatch(/Report not written/);
    expect(text).not.toMatch(/download started/i);
  });
});
