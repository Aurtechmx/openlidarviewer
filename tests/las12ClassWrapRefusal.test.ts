/**
 * las12ClassWrapRefusal.test.ts — the LAS 1.2 write gate for classes above 31.
 *
 * The legacy record holds the class in five bits and `writeLas` writes
 * `class & 0x1f`, so class 33 reads back as 1 and 64 as 0. A wrapped class is
 * itself a valid class, which means the file reads back without an error: the
 * corruption is silent. The gate in `convertCloud` therefore refuses such a
 * write unless the request opts in with `allowLegacyClassWrap`, and the batch
 * runner carries that refusal to the user as a failed file with its reason.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { cloudToGlobal } from '../src/convert/globalPoints';
import { writeLas } from '../src/convert/writeLas';
import { loadLas } from '../src/io/loadLas';
import { runBatch, summariseBatch, type DecodeFn } from '../src/convert/convertRunner';
import {
  countLegacyClassWrap,
  legacyClassWrapRefusal,
  legacyClassWrapWarning,
  previewLegacyClassWrap,
} from '../src/convert/legacyClassGuard';
import { LEGACY_CLASS_WRAP_OPT_IN } from '../src/convert/types';

function cloudWithClasses(classes: number[], extra: Record<string, unknown> = {}): PointCloud {
  const n = classes.length;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = 2 * i;
    positions[i * 3 + 2] = 0.5 * i;
  }
  return new PointCloud({
    positions,
    origin: [500000, 4100000, 100],
    classification: Uint8Array.from(classes),
    sourceFormat: 'las',
    name: 'survey.las',
    ...extra,
  } as never);
}

const errors = (log: ReadonlyArray<{ level: string; message: string }>): string[] =>
  log.filter((l) => l.level === 'error').map((l) => l.message);

describe('countLegacyClassWrap', () => {
  it('counts every point above 31 and lists each code once, ascending', () => {
    const wrap = countLegacyClassWrap(Uint8Array.from([2, 255, 33, 64, 33, 31, 0]));
    expect(wrap.points).toBe(4);
    expect(wrap.codes).toEqual([33, 64, 255]);
  });

  it('finds nothing for classes 0 to 31, or for no classification at all', () => {
    expect(countLegacyClassWrap(Uint8Array.from([0, 1, 2, 31]))).toEqual({ points: 0, codes: [] });
    expect(countLegacyClassWrap(undefined)).toEqual({ points: 0, codes: [] });
  });
});

describe('convertCloud refuses a LAS 1.2 write whose classes would wrap', () => {
  it('writes nothing for classes 33, 64 and 255, and says how many points and which codes', () => {
    const { file, report } = convertCloud(cloudWithClasses([2, 33, 64, 255, 64]), { format: 'las' });
    expect(file).toBeNull();
    expect(report.ok).toBe(false);
    expect(report.pointCount).toBe(0);
    const [error] = errors(report.log);
    expect(error, report.log.map((l) => l.message).join(' | ')).toBeDefined();
    // Four of the five points carry a code above 31.
    expect(error).toMatch(/\b4 points\b/);
    expect(error).toContain('33 (Reserved)');
    expect(error).toContain('64 (User Definable)');
    expect(error).toContain('255 (User Definable)');
    expect(error).not.toMatch(/\b2 \(/); // class 2 fits and is not named
    // Both ways forward, by the names the UI shows.
    expect(error).toContain('LAS 1.4');
    expect(error).toContain(`"${LEGACY_CLASS_WRAP_OPT_IN}"`);
    // One source for the wording: the gate quotes the guard verbatim.
    expect(error).toBe(legacyClassWrapRefusal({ points: 4, codes: [33, 64, 255] }));
    // Nothing is claimed as written.
    expect(report.log.some((l) => /^Wrote /.test(l.message))).toBe(false);
  });

  it('refuses a single point at 32, the first code that does not fit', () => {
    const { file, report } = convertCloud(cloudWithClasses([31, 32]), { format: 'las' });
    expect(file).toBeNull();
    expect(errors(report.log)[0]).toMatch(/\b1 point\b/);
  });

  it('writes with the explicit opt-in, wrapping each class to its low 5 bits and warning', async () => {
    const { file, report } = convertCloud(cloudWithClasses([2, 33, 64, 255]), {
      format: 'las',
      allowLegacyClassWrap: true,
    });
    expect(report.ok).toBe(true);
    expect(file).not.toBeNull();
    expect(report.log).toContainEqual({ level: 'warn', message: legacyClassWrapWarning(3) });
    expect(errors(report.log)).toEqual([]);
    const back = await loadLas(file!.bytes.buffer as ArrayBuffer, 'las', file!.filename);
    expect(Array.from(back.classification ?? [])).toEqual([2, 33 & 0x1f, 64 & 0x1f, 255 & 0x1f]);
  });

  it('LAS 1.4 needs no opt-in and keeps the full byte', async () => {
    const { file, report } = convertCloud(cloudWithClasses([2, 33, 64, 255]), { format: 'las14' });
    expect(report.ok).toBe(true);
    const back = await loadLas(file!.bytes.buffer as ArrayBuffer, 'las', file!.filename);
    expect(Array.from(back.classification ?? [])).toEqual([2, 33, 64, 255]);
  });

  it('omitting the classification writes class 0, so nothing wraps and nothing is refused', () => {
    const { file, report } = convertCloud(cloudWithClasses([33, 64]), { format: 'las', omitClassification: true });
    expect(report.ok).toBe(true);
    expect(file).not.toBeNull();
  });

  it('keeps the overlap-flag loss a warning: the base class is still correct', () => {
    const { file, report } = convertCloud(
      cloudWithClasses([2, 2, 6], { classificationFlags: Uint8Array.from([0x8, 0, 0]) }),
      { format: 'las' },
    );
    expect(report.ok).toBe(true);
    expect(file).not.toBeNull();
    expect(report.log.some((l) => l.level === 'warn' && /overlap/i.test(l.message))).toBe(true);
  });
});

describe('a LAS 1.2 write with every class at or below 31 is unchanged', () => {
  const cases: Record<string, PointCloud> = {
    plain: cloudWithClasses([0, 2, 6, 31]),
    flagged: cloudWithClasses([2, 6, 31], { classificationFlags: Uint8Array.from([0x1, 0x8, 0x4]) }),
    rgbGps: cloudWithClasses([0, 1, 9], {
      colors: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      gpsTime: Float64Array.from([1, 2, 3]),
    }),
  };

  for (const [name, cloud] of Object.entries(cases)) {
    it(`${name}: the bytes are the writer's own, with or without the opt-in`, () => {
      const plain = convertCloud(cloud, { format: 'las' });
      const optedIn = convertCloud(cloud, { format: 'las', allowLegacyClassWrap: true });
      // What the pure writer produces for the same points and the same
      // keep-mode, no-CRS options convertCloud passes it.
      const direct = writeLas(cloudToGlobal(cloud), {
        gpsStandardTime: undefined,
        epsg: undefined,
        isGeographic: false,
        linearUnitCode: null,
        verticalEpsg: null,
        verticalUnitCode: null,
        description: null,
      });
      expect(plain.report.ok).toBe(true);
      expect(Array.from(plain.file!.bytes)).toEqual(Array.from(direct));
      expect(Array.from(optedIn.file!.bytes)).toEqual(Array.from(direct));
      expect(plain.report.log.some((l) => l.level === 'error')).toBe(false);
    });
  }
});

describe('the batch runner surfaces the refusal as a failed file with its reason', () => {
  const decode = (classes: number[]): DecodeFn => async (_buf, name) =>
    cloudWithClasses(classes, { name });
  const input = (name: string) => ({ name, sizeBytes: 8, bytes: async () => new ArrayBuffer(8) });

  it('refuses the wrapping file and still converts the clean one', async () => {
    const results = await runBatch(
      [input('high.las'), input('low.las')],
      { format: 'las' },
      async (buf, name, signal) => (name === 'high.las' ? decode([2, 64]) : decode([2, 6]))(buf, name, signal),
    );
    const [high, low] = results;
    expect(high.file).toBeNull();
    expect(high.report.ok).toBe(false);
    expect(errors(high.report.log)).toEqual([legacyClassWrapRefusal({ points: 1, codes: [64] })]);
    expect(low.file).not.toBeNull();
    expect(summariseBatch(results)).toMatchObject({ ok: 1, failed: 1 });
  });

  it('writes both with the opt-in, and the wrapping file carries the warning', async () => {
    const results = await runBatch([input('high.las')], { format: 'las', allowLegacyClassWrap: true }, decode([2, 64]));
    expect(results[0].file).not.toBeNull();
    expect(results[0].report.log).toContainEqual({ level: 'warn', message: legacyClassWrapWarning(1) });
  });
});

describe('previewLegacyClassWrap', () => {
  it('gives the preview the gate’s own refusal and warning', () => {
    const classes = [2, 33, 64, 255, 64];
    const note = previewLegacyClassWrap(Uint8Array.from(classes));
    const gate = convertCloud(cloudWithClasses(classes), { format: 'las' });
    expect(note).not.toBeNull();
    expect(note!.refusal).toBe(errors(gate.report.log)[0]);
    expect(note!.warning).toBe(legacyClassWrapWarning(4));
  });

  it('is null when nothing wraps or no classification is resident', () => {
    expect(previewLegacyClassWrap(Uint8Array.from([0, 2, 31]))).toBeNull();
    expect(previewLegacyClassWrap(undefined)).toBeNull();
  });
});
