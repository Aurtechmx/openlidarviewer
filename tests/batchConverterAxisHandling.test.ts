/**
 * batchConverterAxisHandling.test.ts
 *
 * The Batch converter's "Rotate a local Y-up model to Z-up" checkbox, with the
 * real batch runner and converter behind it. The row is offered only in Keep
 * mode, is off by default, reaches the converter only when ticked in Keep, and
 * a file that carries a CRS refuses the rotation with the reason. Node
 * environment via a recording DOM stub.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { FakeEl as BaseFakeEl } from './helpers/exportPanelPillDomFake';
import { PointCloud } from '../src/model/PointCloud';
import type { CrsInfo } from '../src/io/crs';
import { Y_UP_TO_Z_UP_OPT_IN } from '../src/convert/types';

const rec = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  results: [] as Array<Array<{ source: string; file: { filename: string; bytes: Uint8Array } | null; report: { ok: boolean; crsNote: string; log: Array<{ message: string }>; events?: Array<{ id: string }> } }>>,
  decode: null as null | ((name: string) => unknown),
}));

vi.mock('../src/convert/decodeFull', () => ({
  decodeFull: async (_buf: ArrayBuffer, name: string) => rec.decode!(name),
}));
vi.mock('../src/convert/convertRunner', async (orig) => {
  const real = await orig<typeof import('../src/convert/convertRunner')>();
  return {
    ...real,
    runBatch: async (...args: Parameters<typeof real.runBatch>) => {
      rec.options.push(args[1] as unknown as Record<string, unknown>);
      const results = await real.runBatch(...args);
      rec.results.push(results as never);
      return results;
    },
  };
});
vi.mock('../src/io/download', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  downloadBytes: () => undefined,
}));

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
  rec.options.length = 0;
  rec.results.length = 0;
});

/** A Y-up model: height runs along Y, depth along Z. First point (1, 7, 3). */
function yUpModel(crs?: CrsInfo): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([1, 7, 3, 2, 8, 4, 3, 9, 5]),
    origin: [0, 0, 0],
    sourceFormat: 'ply',
    name: 'model.ply',
    metadata: crs ? { crs } : undefined,
  });
}

const UTM13N = { epsg: 32613, name: 'WGS 84 / UTM zone 13N' } as unknown as CrsInfo;

type Converter = {
  element: FakeEl;
  _files: unknown[];
  _targetEpsg: string;
  _rotateYUp: boolean;
  _convert(): Promise<void>;
};

async function makeConverter(): Promise<Converter> {
  const { BatchConverter } = await import('../src/ui/BatchConverter');
  const host = new FakeEl('div');
  const bc = new BatchConverter(host as unknown as HTMLElement) as unknown as Converter;
  bc._files.push({ name: 'model.ply', sizeBytes: 16, bytes: async () => new ArrayBuffer(16) });
  return bc;
}

function axisRow(bc: Converter): FakeEl {
  const label = bc.element.findOwnText(Y_UP_TO_Z_UP_OPT_IN)[0];
  expect(label).toBeDefined();
  const rows = bc.element.findByClass('olv-export-fullres').filter((r) => r.findOwnText(Y_UP_TO_Z_UP_OPT_IN).length > 0);
  expect(rows).toHaveLength(1);
  return rows[0] as FakeEl;
}

const pill = (bc: Converter, label: string): FakeEl => bc.element.findOwnText(label)[0] as FakeEl;
const hidden = (row: FakeEl): boolean => row.classList.contains('olv-hidden');

function tick(row: FakeEl): void {
  const box = row.findByClass('olv-export-fullres-box')[0] as FakeEl;
  box.checked = true;
  box.fire('change');
}

function xyzRows(): string[] {
  const text = new TextDecoder().decode(rec.results[0][0].file!.bytes);
  return text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
}

describe('BatchConverter: the Y-up to Z-up option', () => {
  it('is offered only in Keep mode', async () => {
    const bc = await makeConverter();
    const row = axisRow(bc);
    expect(hidden(row)).toBe(false);
    pill(bc, 'Assign EPSG').click();
    expect(hidden(row)).toBe(true);
    pill(bc, 'Reproject').click();
    expect(hidden(row)).toBe(true);
    pill(bc, 'Keep').click();
    expect(hidden(row)).toBe(false);
  });

  it('is off by default: the converter is asked to preserve the axes', async () => {
    rec.decode = () => yUpModel();
    const bc = await makeConverter();
    pill(bc, 'XYZ').click();
    expect(bc._rotateYUp).toBe(false);
    await bc._convert();
    expect(rec.options[0].axisHandling).toBe('preserve');
    expect(xyzRows()[0].split(/\s+/).map(Number)).toEqual([1, 7, 3]);
    expect(rec.results[0][0].report.crsNote).toContain('coordinates unchanged');
  });

  it('ticked in Keep, a local Y-up file is written rotated and the report says so', async () => {
    rec.decode = () => yUpModel();
    const bc = await makeConverter();
    pill(bc, 'XYZ').click();
    tick(axisRow(bc));
    expect(bc._rotateYUp).toBe(true);
    await bc._convert();
    expect(rec.options[0].axisHandling).toBe('y-up-to-z-up');
    // (x, y, z) -> (x, -z, y)
    expect(xyzRows()[0].split(/\s+/).map(Number)).toEqual([1, -3, 7]);
    const { report } = rec.results[0][0];
    expect(report.crsNote).toBe('no CRS recorded (axes rotated Y-up to Z-up)');
    expect(report.events?.some((e) => e.id === 'axes-y-up-to-z-up')).toBe(true);
    expect(new TextDecoder().decode(rec.results[0][0].file!.bytes)).toContain('Conversion event axes-y-up-to-z-up');
  });

  it('a tick left on does not reach the converter once Assign or Reproject is chosen', async () => {
    rec.decode = () => yUpModel();
    const bc = await makeConverter();
    pill(bc, 'XYZ').click();
    tick(axisRow(bc));
    pill(bc, 'Assign EPSG').click();
    bc._targetEpsg = '32613';
    await bc._convert();
    expect(rec.options[0].crsMode).toBe('assign');
    expect(rec.options[0].axisHandling).toBe('preserve');
    expect(rec.results[0][0].report.ok).toBe(true);
    expect(xyzRows()[0].split(/\s+/).map(Number)).toEqual([1, 7, 3]);
  });

  it('refuses a file that carries a CRS, with the reason and no output', async () => {
    rec.decode = () => yUpModel(UTM13N);
    const bc = await makeConverter();
    pill(bc, 'XYZ').click();
    tick(axisRow(bc));
    await bc._convert();
    expect(rec.options[0].axisHandling).toBe('y-up-to-z-up');
    const { report, file } = rec.results[0][0];
    expect(report.ok).toBe(false);
    expect(file).toBeNull();
    const text = report.log.map((l) => l.message).join('\n');
    expect(text).toContain('Nothing was written.');
    expect(text).toContain('EPSG:32613');
    expect(text).toContain(`"${Y_UP_TO_Z_UP_OPT_IN}" is for local models with no CRS`);
    // The row names the failure to the user.
    expect(bc.element.textContent).toContain('is for local models with no CRS');
  });
});
