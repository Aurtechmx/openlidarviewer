/**
 * A LAS 1.2 write refuses two class-table losses unless the request allows
 * each one: a class number whose meaning differs between LAS 1.4 and LAS 1.2,
 * and the LAS 1.4 overlap flag, which LAS 1.2 has no place for. Each has its
 * own opt-in, no opt-in allows another loss, one refusal names every opt-in a
 * write needs, and the file's record says the loss was allowed. Sources are
 * hand-built LAS 1.4 files read back with the independent parser.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { convertCloud } from '../src/convert/convertCloud';
import { loadLas } from '../src/io/loadLas';
import { runBatch, type DecodeFn } from '../src/convert/convertRunner';
import {
  LEGACY_ACQUISITION_LOSS_OPT_IN,
  LEGACY_CLASS_REINTERPRETATION_OPT_IN,
  LEGACY_CLASS_WRAP_OPT_IN,
  LEGACY_OVERLAP_DROP_OPT_IN,
  LEGACY_RETURN_CLAMP_OPT_IN,
  type ConvertOptions,
} from '../src/convert/types';
import type { PointCloud } from '../src/model/PointCloud';
import { buildLas, readLas, type RawPoint } from './helpers/rawLas';
import {
  installFakeDom,
  pickFormat,
  checkRow,
  setCheckbox,
  panelFor,
  exportStatus as status,
  pressExport,
} from './helpers/exportPanelHarness';

const hoisted = vi.hoisted(() => ({ downloads: [] as { name: string; bytes: Uint8Array }[] }));

vi.mock('../src/io/download', () => ({
  downloadBytes: (name: string, bytes: Uint8Array) => { hoisted.downloads.push({ name, bytes }); },
  triggerDownload: () => { /* unused here */ },
}));

beforeAll(() => { installFakeDom(); });
beforeEach(() => { hoisted.downloads.length = 0; });

const OVERLAP = 0x8;

async function decode(points: RawPoint[]): Promise<PointCloud> {
  const bytes = buildLas({ version: '1.4', pdrf: 6, points });
  return loadLas(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'las', 'src.las', 1, undefined, true);
}

/** Class 10 is Rail in LAS 1.4 and reserved in LAS 1.2. */
const reinterpreted = (): Promise<PointCloud> => decode([{ cls: 10 }, { cls: 2 }]);
/** Class 2 means the same in both; only the overlap flag is lost. */
const overlapped = (): Promise<PointCloud> => decode([{ cls: 2, flags: OVERLAP }, { cls: 2 }]);

const REINTERPRET = { allowLegacyClassReinterpretation: true } as const;
const OVERLAP_DROP = { allowLegacyOverlapDrop: true } as const;
/** Every other opt-in, none of which allows the two losses under test. */
const OTHERS = { allowLegacyClassWrap: true, allowLegacyReturnClamp: true, allowLegacyAcquisitionLoss: true } as const;

function legacy(cloud: PointCloud, extra: Partial<ConvertOptions> = {}) {
  return convertCloud(cloud, { format: 'las', ...extra });
}

function recordLines(bytes: Uint8Array): string[] {
  const vlr = readLas(bytes).vlrs.find((v) => v.userId === 'LASF_Spec' && v.recordId === 3);
  return vlr ? new TextDecoder().decode(vlr.data).replace(/\0+$/, '').split('\n') : [];
}

describe('class reinterpretation on a LAS 1.2 write', () => {
  it('refuses by default, names the class and both ways forward', async () => {
    const { file, report } = legacy(await reinterpreted());
    expect(file).toBeNull();
    const msg = report.log.at(-1)!.message;
    expect(msg).toMatch(/^LAS 1\.2 was not written\. 1 point has class 10/);
    expect(msg).toContain('Choose LAS 1.4');
    expect(msg).toContain(`"${LEGACY_CLASS_REINTERPRETATION_OPT_IN}"`);
    expect(msg).not.toContain(LEGACY_OVERLAP_DROP_OPT_IN);
  });

  it('writes with its own opt-in, keeps the number and records the loss as allowed', async () => {
    const { file, report } = legacy(await reinterpreted(), REINTERPRET);
    expect(file).not.toBeNull();
    expect(readLas(file!.bytes).cls).toEqual([10, 2]);
    const event = report.events!.find((e) => e.id === 'class-meaning-10')!;
    expect(event.acknowledged).toBe(true);
    expect(recordLines(file!.bytes).find((l) => l.startsWith('Conversion event class-meaning-10:'))).toMatch(/Allowed in the export request\.$/);
  });

  it('is not allowed by any other opt-in', async () => {
    const cloud = await reinterpreted();
    expect(legacy(cloud, OVERLAP_DROP).file).toBeNull();
    expect(legacy(cloud, OTHERS).file).toBeNull();
    expect(legacy(cloud, { ...OTHERS, ...OVERLAP_DROP }).report.log.at(-1)!.message).toContain(LEGACY_CLASS_REINTERPRETATION_OPT_IN);
  });
});

describe('the overlap flag on a LAS 1.2 write', () => {
  it('refuses by default and names its own opt-in', async () => {
    const { file, report } = legacy(await overlapped());
    expect(file).toBeNull();
    const msg = report.log.at(-1)!.message;
    expect(msg).toMatch(/1 point carries the overlap flag/);
    expect(msg).toContain('Choose LAS 1.4');
    expect(msg).toContain(`"${LEGACY_OVERLAP_DROP_OPT_IN}"`);
    expect(msg).not.toContain(LEGACY_CLASS_REINTERPRETATION_OPT_IN);
  });

  it('writes the base class with its own opt-in and records the loss as allowed', async () => {
    const { file, report } = legacy(await overlapped(), OVERLAP_DROP);
    expect(file).not.toBeNull();
    expect(readLas(file!.bytes).cls).toEqual([2, 2]);
    expect(report.events!.find((e) => e.id === 'overlap-dropped')!.acknowledged).toBe(true);
    expect(recordLines(file!.bytes).find((l) => l.startsWith('Conversion event overlap-dropped:'))).toMatch(/Allowed in the export request\.$/);
  });

  it('is not allowed by any other opt-in', async () => {
    const cloud = await overlapped();
    expect(legacy(cloud, REINTERPRET).file).toBeNull();
    expect(legacy(cloud, OTHERS).file).toBeNull();
  });
});

describe('no loss, no refusal', () => {
  it('a LAS 1.2 write with no overlap flag set never refuses for overlap', async () => {
    const { file, report } = legacy(await decode([{ cls: 2 }, { cls: 6, flags: 0x1 | 0x4 }]));
    expect(file).not.toBeNull();
    expect(report.events?.some((e) => e.id === 'overlap-dropped') ?? false).toBe(false);
  });

  it('a LAS 1.2 write with no classification never refuses for reinterpretation', async () => {
    const { file, report } = legacy(await reinterpreted(), { omitClassification: true });
    expect(file).not.toBeNull();
    expect(report.events?.some((e) => e.kind === 'reinterpreted') ?? false).toBe(false);
  });

  it('an omitted classification still refuses a dropped overlap flag, and writes once allowed', async () => {
    const cloud = await overlapped();
    const refused = legacy(cloud, { omitClassification: true });
    expect(refused.file).toBeNull();
    expect(refused.report.log.at(-1)!.message).toContain(LEGACY_OVERLAP_DROP_OPT_IN);
    expect(legacy(cloud, { omitClassification: true, ...OVERLAP_DROP }).file).not.toBeNull();
  });
});

describe('several losses at once', () => {
  async function everyLoss(): Promise<PointCloud> {
    const cloud = await decode([{ cls: 64, angle: 120, channel: 1 }, { cls: 19, flags: OVERLAP }]);
    cloud.returnNumber![0] = 9;
    cloud.returnCount![0] = 12;
    return cloud;
  }

  it('names all five opt-ins in one refusal', async () => {
    const { file, report } = legacy(await everyLoss());
    expect(file).toBeNull();
    const msg = report.log.at(-1)!.message;
    expect(msg).toMatch(/needs 5 opt-ins/);
    for (const optIn of [LEGACY_CLASS_WRAP_OPT_IN, LEGACY_RETURN_CLAMP_OPT_IN, LEGACY_ACQUISITION_LOSS_OPT_IN, LEGACY_CLASS_REINTERPRETATION_OPT_IN, LEGACY_OVERLAP_DROP_OPT_IN]) {
      expect(msg).toContain(`"${optIn}"`);
    }
    expect(msg.match(/Choose LAS 1\.4/g)).toHaveLength(1);
  });

  it('names only the two class-table opt-ins once the others are allowed', async () => {
    const msg = legacy(await everyLoss(), OTHERS).report.log.at(-1)!.message;
    expect(msg).toMatch(/needs 2 opt-ins/);
    expect(msg).toContain(`"${LEGACY_CLASS_REINTERPRETATION_OPT_IN}" and "${LEGACY_OVERLAP_DROP_OPT_IN}"`);
    expect(msg).not.toContain(LEGACY_CLASS_WRAP_OPT_IN);
  });

  it('writes once all five are allowed, every warning acknowledged', async () => {
    const { file, report } = legacy(await everyLoss(), { ...OTHERS, ...REINTERPRET, ...OVERLAP_DROP });
    expect(file).not.toBeNull();
    const warns = report.events!.filter((e) => e.level === 'warn');
    expect(warns.map((e) => e.id)).toEqual(['class-wrap', 'return-clamp', 'scan-angle-clipped', 'scanner-channel-dropped', 'class-meaning-19', 'overlap-dropped']);
    expect(warns.every((e) => e.acknowledged)).toBe(true);
  });

  it('a LAS 1.4 write of the same cloud never refuses', async () => {
    const { file, report } = convertCloud(await everyLoss(), { format: 'las14' });
    expect(file).not.toBeNull();
    expect(report.ok).toBe(true);
    expect(readLas(file!.bytes).flags[1] & OVERLAP).toBe(OVERLAP);
  });
});

describe('the batch converter', () => {
  const input = (name: string) => ({ name, sizeBytes: 8, bytes: async () => new ArrayBuffer(8) });
  const decodeBy = (map: Record<string, () => Promise<PointCloud>>): DecodeFn => async (_b, name) => map[name]();

  it('refuses each file with every opt-in it needs, and writes each with its own', async () => {
    const decodeFn = decodeBy({
      'meaning.las': reinterpreted,
      'overlap.las': overlapped,
      'both.las': () => decode([{ cls: 10, flags: OVERLAP }]),
    });
    const files = [input('meaning.las'), input('overlap.las'), input('both.las')];
    const refused = await runBatch(files, { format: 'las' }, decodeFn);
    expect(refused.every((r) => r.file === null)).toBe(true);
    const last = (i: number) => refused[i].report.log.at(-1)!.message;
    expect(last(0)).toContain(LEGACY_CLASS_REINTERPRETATION_OPT_IN);
    expect(last(1)).toContain(LEGACY_OVERLAP_DROP_OPT_IN);
    expect(last(2)).toContain(`"${LEGACY_CLASS_REINTERPRETATION_OPT_IN}" and "${LEGACY_OVERLAP_DROP_OPT_IN}"`);

    const onlyMeaning = await runBatch(files, { format: 'las', ...REINTERPRET }, decodeFn);
    expect(onlyMeaning.map((r) => r.file !== null)).toEqual([true, false, false]);

    const all = await runBatch(files, { format: 'las', ...REINTERPRET, ...OVERLAP_DROP }, decodeFn);
    expect(all.every((r) => r.file !== null)).toBe(true);
  });
});

describe('the Export panel', () => {
  it('keeps the overlap opt-in reachable when the classification is omitted', async () => {
    const root = await panelFor(await overlapped());
    pickFormat(root, 'LAS 1.2');
    setCheckbox(root, 'Include classification', false);
    expect(checkRow(root, LEGACY_CLASS_REINTERPRETATION_OPT_IN)!.hidden).toBe(true);
    expect(checkRow(root, LEGACY_OVERLAP_DROP_OPT_IN)!.hidden).toBe(false);
    await pressExport(root);
    expect(hoisted.downloads).toEqual([]);
    expect(status(root).textContent).toContain(LEGACY_OVERLAP_DROP_OPT_IN);
    setCheckbox(root, LEGACY_OVERLAP_DROP_OPT_IN, true);
    await pressExport(root);
    expect(hoisted.downloads).toHaveLength(1);
  });

  it('shows both opt-ins for LAS 1.2 only', async () => {
    const root = await panelFor(await reinterpreted());
    expect(checkRow(root, LEGACY_CLASS_REINTERPRETATION_OPT_IN)!.hidden).toBe(true);
    expect(checkRow(root, LEGACY_OVERLAP_DROP_OPT_IN)!.hidden).toBe(true);
    pickFormat(root, 'LAS 1.2');
    expect(checkRow(root, LEGACY_CLASS_REINTERPRETATION_OPT_IN)!.hidden).toBe(false);
    expect(checkRow(root, LEGACY_OVERLAP_DROP_OPT_IN)!.hidden).toBe(false);
  });

  it('refuses the reinterpreted write, keeps LAS 1.2 selected, and writes once its opt-in is ticked', async () => {
    const root = await panelFor(await reinterpreted());
    pickFormat(root, 'LAS 1.2');
    setCheckbox(root, LEGACY_OVERLAP_DROP_OPT_IN, true);
    await pressExport(root);
    expect(hoisted.downloads).toEqual([]);
    expect(status(root).className).toContain('is-error');
    expect(status(root).textContent).toContain(LEGACY_CLASS_REINTERPRETATION_OPT_IN);
    expect(status(root).textContent).toContain('Choose LAS 1.4');
    const selected = root.findByClass('olv-bc-pill').find((p) => p.className.includes('is-active'));
    expect(selected?.textContent).toBe('LAS 1.2');

    setCheckbox(root, LEGACY_CLASS_REINTERPRETATION_OPT_IN, true);
    await pressExport(root);
    expect(hoisted.downloads).toHaveLength(1);
    expect(readLas(hoisted.downloads[0].bytes).version).toBe('1.2');
  });
});
