/**
 * las14DefaultFormat.test.ts
 *
 * LAS 1.4 stores the CRS as WKT and this build holds a WKT for only some EPSG
 * codes, so a State Plane scan (and EPSG:28992 or 3006) exported on the default
 * path used to fail after Export was pressed. The Export panel and the batch
 * converter now ask the writer's own CRS plan first: LAS 1.4 is disabled with
 * the reason, LAS 1.2 is selected, and the default export succeeds. A pill the
 * user chose is never undone. Node environment via a recording DOM stub.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { FakeEl as BaseFakeEl } from './helpers/exportPanelPillDomFake';
import { PointCloud } from '../src/model/PointCloud';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { las14Availability, las14OutputEpsg } from '../src/convert/las14Availability';
import { wktForEpsg } from '../src/io/epsgWkt';

const rec = vi.hoisted(() => ({
  downloads: [] as Array<{ name: string; bytes: Uint8Array }>,
  decode: null as null | ((name: string) => unknown),
  results: [] as Array<Array<{ file: { filename: string } | null; report: { ok: boolean; log: Array<{ message: string }> } }>>,
}));
vi.mock('../src/io/download', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  downloadBytes: (name: string, bytes: Uint8Array) => rec.downloads.push({ name, bytes }),
}));
vi.mock('../src/convert/decodeFull', () => ({
  decodeFull: async (_buf: ArrayBuffer, name: string) => rec.decode!(name),
}));
vi.mock('../src/convert/convertRunner', async (orig) => {
  const real = await orig<typeof import('../src/convert/convertRunner')>();
  return {
    ...real,
    runBatch: async (...args: Parameters<typeof real.runBatch>) => {
      const results = await real.runBatch(...args);
      rec.results.push(results as never);
      return results;
    },
  };
});

class FakeEl extends BaseFakeEl {
  private readonly _listeners: Record<string, (() => void)[]> = {};
  override addEventListener(type: string, handler: () => void): void {
    (this._listeners[type] ??= []).push(handler);
  }
  fire(type: string): void {
    for (const h of this._listeners[type] ?? []) h();
  }
  click(): void {
    this.fire('click');
  }
  /** Type into an input the way the browser does. */
  enter(text: string): void {
    this.value = text;
    this.fire('input');
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
  rec.downloads.length = 0;
  rec.results.length = 0;
});

const crs = (epsg: number, unit: 'metre' | 'us-survey-foot', toM: number, name: string): ResolvedCrs => ({
  kind: 'projected', name, epsg, linearUnit: unit, linearUnitToMetres: toM,
  source: 'user-override', confidence: 'high', userConfirmed: true,
} as ResolvedCrs);
const UTM13N = crs(32613, 'metre', 1, 'WGS 84 / UTM zone 13N');
const STATE_PLANE = crs(2229, 'us-survey-foot', 1200 / 3937, 'NAD83 / California zone 5 (ftUS)');

function scan(): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
    origin: [6000000, 2000000, 100],
    sourceFormat: 'las',
    name: 'survey.las',
  });
}

describe('las14Availability', () => {
  it('accepts a CRS whose WKT the build holds', () => {
    expect(las14Availability({ mode: 'keep', sourceEpsg: 32613, sourceWkt: null, targetEpsg: null })).toEqual({ ok: true });
  });

  it.each([2229, 28992, 3006])('refuses EPSG:%i, which has no stored WKT, and names it', (epsg) => {
    expect(wktForEpsg(epsg)).toBeNull();
    const a = las14Availability({ mode: 'keep', sourceEpsg: epsg, sourceWkt: null, targetEpsg: null });
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.epsg).toBe(epsg);
      expect(a.message).toContain(`EPSG:${epsg}`);
      expect(a.message).toContain('LAS 1.2');
    }
  });

  it('accepts a kept code with no stored WKT when the source carries a usable WKT', () => {
    const wkt = wktForEpsg(32613)!;
    expect(las14Availability({ mode: 'keep', sourceEpsg: 2229, sourceWkt: wkt, targetEpsg: null }).ok).toBe(true);
  });

  it('judges assign and reproject by the target code; the source WKT does not describe the output', () => {
    const wkt = wktForEpsg(32613)!;
    expect(las14Availability({ mode: 'assign', sourceEpsg: 32613, sourceWkt: wkt, targetEpsg: 2229 }).ok).toBe(false);
    expect(las14Availability({ mode: 'reproject', sourceEpsg: 2229, sourceWkt: null, targetEpsg: 32613 }).ok).toBe(true);
    expect(las14OutputEpsg({ mode: 'reproject', sourceEpsg: 2229, targetEpsg: 32613 })).toBe(32613);
  });

  it('writes no code, so nothing blocks, for a scan without one', () => {
    expect(las14Availability({ mode: 'keep', sourceEpsg: null, sourceWkt: null, targetEpsg: null }).ok).toBe(true);
    expect(las14Availability({ mode: 'assign', sourceEpsg: null, sourceWkt: null, targetEpsg: null }).ok).toBe(true);
  });
});

type PanelInternals = {
  _format: string;
  _export(): Promise<void>;
  setCrsKnown(known: boolean): void;
  whenLas14Checked(): Promise<void>;
  element: FakeEl;
};

async function makePanel(resolved: ResolvedCrs | null): Promise<PanelInternals> {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const cloud = scan();
  const panel = new ExportPanel({
    getCloud: () => cloud,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
    getResolvedSourceCrs: () => resolved,
  });
  const p = panel as unknown as PanelInternals;
  p.setCrsKnown(resolved != null);
  await p.whenLas14Checked();
  return p;
}

const pillOf = (root: FakeEl, label: string): FakeEl => root.findOwnText(label)[0] as FakeEl;

describe('ExportPanel: the default format can succeed', () => {
  it('keeps LAS 1.4 for a CRS it can write', async () => {
    const p = await makePanel(UTM13N);
    expect(p._format).toBe('las14');
    expect(pillOf(p.element, 'LAS 1.4').disabled).toBe(false);
    expect(pillOf(p.element, 'LAS 1.4').attrs['aria-pressed']).toBe('true');
  });

  it('selects LAS 1.2 for a State Plane scan, says why, and the default export writes a file', async () => {
    const p = await makePanel(STATE_PLANE);
    expect(p._format).toBe('las');
    const las14 = pillOf(p.element, 'LAS 1.4');
    expect(las14.disabled).toBe(true);
    expect(las14.title).toContain('EPSG:2229');
    expect(pillOf(p.element, 'LAS 1.2').attrs['aria-pressed']).toBe('true');
    const note = p.element.findOwnText(`${las14.title} LAS 1.2 is selected.`);
    expect(note).toHaveLength(1);
    await p._export();
    const out = rec.downloads.find((d) => d.name.endsWith('.las'));
    expect(out).toBeDefined();
    // LAS 1.2 header: version minor byte at offset 25.
    expect(String.fromCharCode(...out!.bytes.subarray(0, 4))).toBe('LASF');
    expect(out!.bytes[25]).toBe(2);
  });

  it('follows an assigned target code and returns to LAS 1.4 when it can be written', async () => {
    const p = await makePanel(UTM13N);
    pillOf(p.element, 'Assign EPSG').click();
    await p.whenLas14Checked();
    const input = p.element.findByClass('olv-bc-input')[0] as FakeEl;
    input.enter('28992');
    await p.whenLas14Checked();
    expect(p._format).toBe('las');
    expect(pillOf(p.element, 'LAS 1.4').disabled).toBe(true);
    (p.element.findByClass('olv-bc-input')[0] as FakeEl).enter('32613');
    await p.whenLas14Checked();
    expect(p._format).toBe('las14');
    expect(pillOf(p.element, 'LAS 1.4').disabled).toBe(false);
  });

  it('never undoes a format the user chose', async () => {
    const p = await makePanel(UTM13N);
    pillOf(p.element, 'LAS 1.2').click();
    expect(p._format).toBe('las');
    pillOf(p.element, 'Assign EPSG').click();
    (p.element.findByClass('olv-bc-input')[0] as FakeEl).enter('28992');
    await p.whenLas14Checked();
    (p.element.findByClass('olv-bc-input')[0] as FakeEl).enter('32613');
    await p.whenLas14Checked();
    expect(p._format).toBe('las');
  });

  it('a scan with no CRS is not blocked', async () => {
    const p = await makePanel(null);
    expect(p._format).toBe('las14');
    expect(pillOf(p.element, 'LAS 1.4').disabled).toBe(false);
  });
});

type BatchInternals = {
  element: FakeEl;
  _format: string;
  _files: unknown[];
  _convert(): Promise<void>;
  whenLas14Checked(): Promise<void>;
};

async function makeBatch(): Promise<BatchInternals> {
  const { BatchConverter } = await import('../src/ui/BatchConverter');
  const bc = new BatchConverter(new FakeEl('div') as unknown as HTMLElement) as unknown as BatchInternals;
  bc._files.push({ name: 'survey.las', sizeBytes: 16, bytes: async () => new ArrayBuffer(16) });
  return bc;
}

describe('BatchConverter: the default format can succeed', () => {
  it('selects LAS 1.2 when the code an assign writes has no WKT, and converts on the default path', async () => {
    rec.decode = () => scan();
    const bc = await makeBatch();
    expect(bc._format).toBe('las14');
    pillOf(bc.element, 'Assign EPSG').click();
    (bc.element.findByClass('olv-bc-input')[0] as FakeEl).enter('2229');
    await bc.whenLas14Checked();
    expect(bc._format).toBe('las');
    const las14 = pillOf(bc.element, 'LAS 1.4');
    expect(las14.disabled).toBe(true);
    expect(las14.title).toContain('EPSG:2229');
    expect(bc.element.textContent).toContain(`${las14.title} LAS 1.2 is selected.`);
    await bc._convert();
    expect(rec.results[0][0].report.ok).toBe(true);
    expect(rec.results[0][0].file!.filename).toMatch(/\.las$/);
  });

  it('returns to LAS 1.4 when the target can be written, and in Keep mode', async () => {
    const bc = await makeBatch();
    pillOf(bc.element, 'Assign EPSG').click();
    (bc.element.findByClass('olv-bc-input')[0] as FakeEl).enter('2229');
    await bc.whenLas14Checked();
    expect(bc._format).toBe('las');
    (bc.element.findByClass('olv-bc-input')[0] as FakeEl).enter('32613');
    await bc.whenLas14Checked();
    expect(bc._format).toBe('las14');
    (bc.element.findByClass('olv-bc-input')[0] as FakeEl).enter('2229');
    await bc.whenLas14Checked();
    expect(bc._format).toBe('las');
    pillOf(bc.element, 'Keep').click();
    await bc.whenLas14Checked();
    expect(bc._format).toBe('las14');
    expect(pillOf(bc.element, 'LAS 1.4').disabled).toBe(false);
  });

  it('a kept State Plane file is refused per file with the reason and a way forward', async () => {
    rec.decode = () => new PointCloud({
      positions: Float32Array.from([0, 0, 0, 10, 20, 1]),
      origin: [6000000, 2000000, 100],
      sourceFormat: 'las',
      name: 'survey.las',
      metadata: { crs: { epsg: 2229, name: 'NAD83 / California zone 5 (ftUS)' } as never },
    });
    const bc = await makeBatch();
    await bc._convert();
    const { report, file } = rec.results[0][0];
    expect(report.ok).toBe(false);
    expect(file).toBeNull();
    expect(report.log.map((l) => l.message).join('\n')).toContain('Choose LAS 1.2');
  });
});
