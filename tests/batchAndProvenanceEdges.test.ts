/**
 * Edges between the converters and the provenance lines:
 *  - the batch converter refuses a re-decode that read only a sample or a
 *    truncated file, as the single export does;
 *  - the "Classes edited in app" line says so when the classes are omitted;
 *  - an E57 whose invalid points were dropped on load is still the full file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { runBatch, type BatchInput } from '../src/convert/convertRunner';
import { convertCloud } from '../src/convert/convertCloud';
import { classEditLine } from '../src/export/exportProvenanceLines';
import { pointBasisOfCloud } from '../src/export/exportProvenanceLines';
import { fullDecodeRefusal } from '../src/app/fullFileActions';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import { readLas } from './helpers/rawLas';
import { READ_EVERY_RECORD, parseResult, scan } from './helpers/e57ScanFixtures';

vi.mock('../src/io/e57/parseE57', () => ({ parseE57: vi.fn() }));
const mockedParse = vi.mocked(parseE57);
beforeEach(() => { mockedParse.mockReset(); });

function cloud(extra: Partial<ConstructorParameters<typeof PointCloud>[0]> = {}): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    classification: Uint8Array.from([2, 2, 6]),
    origin: [500000, 4100000, 0],
    sourceFormat: 'e57',
    name: 'scan.e57',
    ...extra,
  });
}

const input = (name: string): BatchInput => ({ name, sizeBytes: 1, bytes: async () => new ArrayBuffer(1) });

describe('batch converter: a re-decode that did not read every point', () => {
  it('refuses a strided decode with the single export\'s message, and writes nothing', async () => {
    const strided = cloud({ declaredPointCount: 300, loadStride: 100 });
    const [r] = await runBatch([input('big.e57')], { format: 'las14' }, async () => strided);
    expect(r.report.ok).toBe(false);
    expect(r.file).toBeNull();
    expect(r.report.log.at(-1)).toEqual({ level: 'error', message: fullDecodeRefusal(strided)! });
    expect(r.report.log.at(-1)!.message).toMatch(/one record in 100/);
  });

  it('refuses a truncated file', async () => {
    const truncated = cloud({ metadata: { truncation: { read: 3, declared: 90 } } as never });
    const [r] = await runBatch([input('cut.las')], { format: 'las14' }, async () => truncated);
    expect(r.report.ok).toBe(false);
    expect(r.file).toBeNull();
    expect(r.report.log.at(-1)!.message).toMatch(/ends after 3 of its 90 declared points/);
  });

  it('refuses a decode that holds fewer points than it declares', async () => {
    const short = cloud({ declaredPointCount: 10 });
    const [r] = await runBatch([input('short.e57')], { format: 'las14' }, async () => short);
    expect(r.report.ok).toBe(false);
  });

  it('converts a complete decode, and keeps the other files of the batch', async () => {
    const results = await runBatch(
      [input('bad.e57'), input('good.e57')],
      { format: 'las14' },
      async (_b, name) => (name === 'bad.e57' ? cloud({ declaredPointCount: 300, loadStride: 100 }) : cloud({ declaredPointCount: 3 })),
    );
    expect(results.map((r) => r.report.ok)).toEqual([false, true]);
  });
});

describe('"Classes edited in app" when the classes are omitted', () => {
  const edited = { format: 'las' as const, classesEdited: true };

  it('says not applicable in the LAS text area', () => {
    const { file } = convertCloud(cloud(), { ...edited, omitClassification: true });
    const vlr = readLas(file!.bytes).vlrs.find((v) => v.recordId === 3)!;
    const text = new TextDecoder().decode(vlr.data);
    expect(text).toContain('Classes edited in app: not applicable (classes omitted)');
    expect(text).not.toContain('Classes edited in app: yes');
  });

  it('says not applicable in the XYZ and ASC headers', () => {
    for (const format of ['xyz', 'asc'] as const) {
      const { file } = convertCloud(cloud(), { format, classesEdited: true, omitClassification: true });
      expect(new TextDecoder().decode(file!.bytes)).toContain('# Classes edited in app: not applicable (classes omitted)');
    }
  });

  it('keeps yes and no when the classes are written', () => {
    const yes = convertCloud(cloud(), { format: 'xyz', classesEdited: true });
    expect(new TextDecoder().decode(yes.file!.bytes)).toContain('# Classes edited in app: yes');
    expect(classEditLine(false)).toBe('Classes edited in app: no');
    expect(classEditLine(true, true)).toBe('Classes edited in app: not applicable (classes omitted)');
  });
});

describe('E57 points dropped on load', () => {
  it('counts only the surviving points as declared, so the cloud is still the full file', async () => {
    const s = scan('s', 4, {
      cartesianX: Float64Array.from([10.5, Number.NaN, 12.5, 13.5]),
      cartesianY: Float64Array.from([20.5, 21.5, 22.5, 23.5]),
      cartesianZ: Float64Array.from([5.5, 6.5, 7.5, 8.5]),
    });
    mockedParse.mockReturnValue(parseResult([s]));
    const c = await loadE57(new ArrayBuffer(0), 'holes.e57', { plan: READ_EVERY_RECORD });
    expect(c.pointCount).toBe(3);
    expect(c.declaredPointCount).toBe(3);
    expect(c.decodedPointCount).toBe(3);
    expect(fullDecodeRefusal(c)).toBeNull();
    expect(pointBasisOfCloud(c, false)).toMatch(/full file \(3 points\)/);
    expect(pointBasisOfCloud(c, null)).toMatch(/full file \(3 points\)/);
  });
});
