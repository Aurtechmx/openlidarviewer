/**
 * Conversion events: what a LAS conversion loses or changes is recorded once,
 * shown in the report, and written into the file's text area description
 * record. Sources are hand-built LAS files and outputs are read with the
 * independent parser in helpers/rawLas.ts.
 *
 * Spec facts used: LAS 1.2 stores the scan angle as an int8 rank in whole
 * degrees, -90 to 90, and has no scanner channel; LAS 1.4 formats 6 to 10 store
 * an int16 angle in 0.006 degree steps and a 2-bit scanner channel; the Text
 * Area Description is the LASF_Spec record 3.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { loadLas } from '../src/io/loadLas';
import { LEGACY_ACQUISITION_LOSS_OPT_IN } from '../src/convert/types';
import { fitProvenance, notableEntries, warningSummary, type ConversionEvent } from '../src/convert/conversionEvents';
import { buildLas, readLas, type RawPoint } from './helpers/rawLas';

async function decode(bytes: Uint8Array) {
  return loadLas(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'las', 'src.las', 1, undefined, true);
}

const ext = (points: RawPoint[]): Uint8Array => buildLas({ version: '1.4', pdrf: 6, points });

async function toLegacy(points: RawPoint[], opts: Parameters<typeof convertCloud>[1] = { format: 'las' }) {
  const cloud = await decode(ext(points));
  const result = convertCloud(cloud, opts);
  return { result, out: result.file ? readLas(result.file.bytes) : null };
}

/** The text area description record, as lines. */
function recordLines(bytes: Uint8Array): string[] {
  const vlr = readLas(bytes).vlrs.find((v) => v.userId === 'LASF_Spec' && v.recordId === 3);
  if (!vlr) return [];
  return new TextDecoder().decode(vlr.data).replace(/\0+$/, '').split('\n');
}

const ALLOW = { format: 'las' as const, allowLegacyAcquisitionLoss: true };
/** The two class-table losses, each allowed by its own control. */
const ALLOW_SEMANTIC = { allowLegacyClassReinterpretation: true, allowLegacyOverlapDrop: true } as const;

describe('scan angle and scanner channel on a LAS 1.2 write', () => {
  it('refuses a clipped angle and a dropped channel unless the request allows them, naming both', async () => {
    const { result } = await toLegacy([{ cls: 2, angle: 120, channel: 3 }]);
    expect(result.file).toBeNull();
    const msg = result.report.log.at(-1)!.message;
    expect(msg).toMatch(/1 point has a scan angle that rounds beyond 90 degrees/);
    expect(msg).toMatch(/1 point carries a scanner channel/);
    expect(msg).toContain(LEGACY_ACQUISITION_LOSS_OPT_IN);
    expect(msg).toContain('LAS 1.4');
  });

  it('writes the clipped angle and records both losses when allowed', async () => {
    const { result, out } = await toLegacy([{ cls: 2, angle: 120, channel: 3 }, { cls: 2, angle: -120, channel: 1 }, { cls: 2, angle: 10, channel: 0 }], ALLOW);
    expect(out!.angle[0]).toBe(90);
    expect(out!.angle[1]).toBe(-90);
    expect(out!.angle[2]).toBe(10);
    expect(out!.channel).toEqual([0, 0, 0]);
    const warns = result.report.log.filter((e) => e.level === 'warn').map((e) => e.message);
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatch(/^LAS 1\.2 stores the scan angle as -90 to 90 whole degrees\. 2 points/);
    expect(warns[1]).toMatch(/channel \(1, 3\) of 2 points is not written/);
    const lines = recordLines(result.file!.bytes);
    expect(lines).toContain('Conversion event scan-angle-clipped: ' + result.report.events!.find((e) => e.id === 'scan-angle-clipped')!.message + ' Allowed in the export request.');
    expect(lines.some((l) => l.startsWith('Conversion event scanner-channel-dropped:') && l.endsWith('Allowed in the export request.'))).toBe(true);
  });

  // The writer stores the angle rounded to a whole degree, so only a value that
  // rounds beyond 90 is clipped: 90.006 and 90.402 are rounded, 90.6 is clipped.
  it.each([
    [-180, 'clipped'], [-91, 'clipped'], [-90.6, 'clipped'], [-90.4, 'rounded'], [-90, 'exact'],
    [0, 'exact'], [90, 'exact'], [90.006, 'rounded'], [90.402, 'rounded'], [90.6, 'clipped'], [180, 'clipped'],
  ])('angle %f degrees is %s', async (angle, outcome) => {
    const { result, out } = await toLegacy([{ cls: 2, angle }], ALLOW);
    expect(result.file).not.toBeNull();
    const ids = result.report.events!.map((e) => e.id);
    expect(ids.includes('scan-angle-clipped')).toBe(outcome === 'clipped');
    expect(ids.includes('scan-angle-rounded')).toBe(outcome === 'rounded');
    expect(Math.abs(out!.angle[0])).toBeLessThanOrEqual(90);
    // Without the opt-in only a clipped angle is refused.
    const strict = await toLegacy([{ cls: 2, angle }]);
    expect(strict.result.file === null).toBe(outcome === 'clipped');
  });

  it.each([[90.5, 'clipped'], [-90.5, 'clipped'], [90.49, 'rounded']])('angle %f degrees held exactly in float32 is %s', (angle, outcome) => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0]), scanAngle: Float32Array.from([angle]),
      sourceFormat: 'las', name: 'a.las', origin: [0, 0, 0],
    });
    const { file, report } = convertCloud(cloud, ALLOW);
    expect(readLas(file!.bytes).angle[0]).toBe(Math.sign(angle) * 90);
    expect(report.events!.map((e) => e.id)).toContain(outcome === 'clipped' ? 'scan-angle-clipped' : 'scan-angle-rounded');
  });

  it.each([[0, false], [1, true], [2, true], [3, true]])('scanner channel %i refused: %s', async (channel, refused) => {
    const { result } = await toLegacy([{ cls: 2, channel }]);
    expect(result.file === null).toBe(refused);
  });

  it('records a fractional in-range angle as rounding, without refusing or warning', async () => {
    const { result, out } = await toLegacy([{ cls: 2, angle: 12.4 }, { cls: 2, angle: 30 }]);
    expect(result.file).not.toBeNull();
    expect(out!.angle).toEqual([12, 30]);
    expect(result.report.log.some((e) => e.level === 'warn')).toBe(false);
    const ev = result.report.events!.find((e) => e.id === 'scan-angle-rounded')!;
    expect(ev.points).toBe(1);
    expect(recordLines(result.file!.bytes).some((l) => l.startsWith('Conversion event scan-angle-rounded:'))).toBe(true);
  });

  it('keeps both in a LAS 1.4 write and records nothing', async () => {
    const cloud = await decode(ext([{ cls: 2, angle: 120, channel: 3 }]));
    const { file, report } = convertCloud(cloud, { format: 'las14' });
    const out = readLas(file!.bytes);
    expect(out.angle[0]).toBeCloseTo(120, 2);
    expect(out.channel).toEqual([3]);
    expect(report.events).toEqual([]);
  });

  it('an allowed acquisition loss does not allow a class wrap, and the reverse', async () => {
    const wrap = await toLegacy([{ cls: 64, angle: 120 }], ALLOW);
    expect(wrap.result.file).toBeNull();
    expect(wrap.result.report.log.at(-1)!.message).toMatch(/Allow classes above 31/);
    const acq = await toLegacy([{ cls: 64, angle: 120 }], { format: 'las', allowLegacyClassWrap: true });
    expect(acq.result.file).toBeNull();
    expect(acq.result.report.log.at(-1)!.message).toContain(LEGACY_ACQUISITION_LOSS_OPT_IN);
  });
});

describe('one refusal names every opt-in a write needs', () => {
  async function needsAll() {
    const cloud = await decode(ext([{ cls: 64, angle: 120, channel: 1 }]));
    cloud.returnNumber![0] = 9;
    cloud.returnCount![0] = 12;
    return cloud;
  }

  it('lists all three losses and all three controls in one message', async () => {
    const { file, report } = convertCloud(await needsAll(), { format: 'las' });
    expect(file).toBeNull();
    const msg = report.log.at(-1)!.message;
    expect(msg).toMatch(/^LAS 1\.2 was not written\. It would lose data that needs 3 opt-ins\./);
    expect(msg).toMatch(/classes/);
    expect(msg).toMatch(/return number/);
    expect(msg).toMatch(/scan angle that rounds beyond 90/);
    expect(msg).toMatch(/scanner channel/);
    expect(msg).toContain('"Allow classes above 31 to wrap"');
    expect(msg).toContain('"Allow returns above 7 to be clamped"');
    expect(msg).toContain(`"${LEGACY_ACQUISITION_LOSS_OPT_IN}"`);
    expect(msg.match(/Choose LAS 1\.4/g)).toHaveLength(1);
    expect(msg).toContain('"Allow returns above 7 to be clamped" and "Allow scan angles to clip and scanner channels to be dropped"');
  });

  it('names only the opt-ins still missing', async () => {
    const { file, report } = convertCloud(await needsAll(), { format: 'las', allowLegacyClassWrap: true });
    expect(file).toBeNull();
    const msg = report.log.at(-1)!.message;
    expect(msg).toMatch(/needs 2 opt-ins/);
    expect(msg).not.toContain('"Allow classes above 31 to wrap"');
    expect(msg).toContain('"Allow returns above 7 to be clamped"');
  });

  it('writes the file once all three are allowed', async () => {
    const { file } = convertCloud(await needsAll(), {
      format: 'las', allowLegacyClassWrap: true, allowLegacyReturnClamp: true, allowLegacyAcquisitionLoss: true,
    });
    expect(file).not.toBeNull();
  });
});

describe('refusal wording for a single point', () => {
  it('says "has" for one point and "have" for two in the return-clamp refusal', async () => {
    const make = async (n: number) => {
      const cloud = await decode(ext(Array.from({ length: n }, () => ({ cls: 2 }))));
      cloud.returnNumber!.fill(9);
      cloud.returnCount!.fill(12);
      return convertCloud(cloud, { format: 'las' }).report.log.at(-1)!.message;
    };
    expect(await make(1)).toMatch(/1 point has a return number/);
    expect(await make(2)).toMatch(/2 points have a return number/);
  });

  it('rounds a half away from zero in both directions', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]), scanAngle: Float32Array.from([-1.5, 1.5]),
      sourceFormat: 'las', name: 'a.las', origin: [0, 0, 0],
    });
    expect(readLas(convertCloud(cloud, { format: 'las' }).file!.bytes).angle).toEqual([-2, 2]);
  });
});

describe('the file records every event', () => {
  it('writes class wrap, overlap loss, clipping and channel loss with their counts, with no digest and no CRS', async () => {
    const { result } = await toLegacy(
      [{ cls: 64, flags: 8, angle: 120, channel: 2 }, { cls: 19 }],
      { format: 'las', allowLegacyClassWrap: true, allowLegacyAcquisitionLoss: true, ...ALLOW_SEMANTIC },
    );
    const ids = result.report.events!.map((e) => e.id);
    expect(ids).toEqual(['class-wrap', 'scan-angle-clipped', 'scanner-channel-dropped', 'class-meaning-19', 'overlap-dropped']);
    const lines = recordLines(result.file!.bytes);
    for (const id of ids) expect(lines.some((l) => l.startsWith(`Conversion event ${id}: `)), id).toBe(true);
    expect(lines.find((l) => l.startsWith('Conversion event class-wrap:'))).toMatch(/1 point with a class > 31 wraps.*Allowed in the export request\.$/);
    expect(lines.find((l) => l.startsWith('Conversion event overlap-dropped:'))).toMatch(/overlap flag.*Allowed in the export request\.$/);
    expect(lines.find((l) => l.startsWith('Conversion event class-meaning-19:'))).toMatch(/Allowed in the export request\.$/);
    // Every report warning appears in the file.
    expect(result.report.log.filter((e) => e.level === 'warn')).toHaveLength(ids.length);
  });

  it('writes the return clamp, with the existing wording', async () => {
    const src = buildLas({ version: '1.4', pdrf: 6, points: [{ cls: 2 }] });
    const cloud = await decode(src);
    cloud.returnNumber![0] = 9;
    cloud.returnCount![0] = 12;
    const { file } = convertCloud(cloud, { format: 'las', allowLegacyReturnClamp: true });
    expect(recordLines(file!.bytes)).toContain('Conversion event return-clamp: LAS 1.2: returns above 7 clamped to 7 on 1 point. Allowed in the export request.');
  });

  it('writes a legacy-to-LAS 1.4 translation', async () => {
    const cloud = await decode(buildLas({ version: '1.2', pdrf: 3, points: [{ cls: 8 }, { cls: 12 }] }));
    const { file, report } = convertCloud(cloud, { format: 'las14' });
    expect(report.events!.map((e) => e.id)).toEqual(['class-8-translated', 'class-12-translated']);
    const lines = recordLines(file!.bytes);
    expect(lines.some((l) => l.startsWith('Conversion event class-8-translated:') && /key-point flag/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('Conversion event class-12-translated:') && /overlap flag/.test(l))).toBe(true);
  });

  it('is identical for the same input', async () => {
    const run = async () => recordLines((await toLegacy([{ cls: 19, angle: 120 }], { ...ALLOW, ...ALLOW_SEMANTIC })).result.file!.bytes);
    expect(await run()).toEqual(await run());
  });

  it('keeps the events and says so when the record is too long for the file', () => {
    const events: ConversionEvent[] = [
      { id: 'scan-angle-clipped', kind: 'clipped', level: 'warn', points: 1, message: 'm', acknowledged: true },
    ];
    const fit = fitProvenance(['x'.repeat(70000)], null, events);
    expect(fit.trimmed).toBe(true);
    expect(fit.lines).toHaveLength(1);
    expect(fit.lines[0]).toMatch(/^Conversion event scan-angle-clipped:/);
    expect(fitProvenance(['short'], null, events).trimmed).toBe(false);
  });
});

describe('what the panels list', () => {
  it('lists every warning and each translation, not only the first', async () => {
    const { result } = await toLegacy([{ cls: 64, flags: 8, angle: 120, channel: 2 }], { format: 'las', allowLegacyClassWrap: true, allowLegacyAcquisitionLoss: true, ...ALLOW_SEMANTIC });
    const entries = notableEntries(result.report);
    expect(entries.length).toBe(4);
    expect(warningSummary(entries)).toBe('4 warnings');
    const up = convertCloud(await decode(buildLas({ version: '1.2', pdrf: 3, points: [{ cls: 8 }, { cls: 19 }] })), { format: 'las14' });
    expect(warningSummary(notableEntries(up.report))).toBe('1 warning and 1 translation');
  });
});
