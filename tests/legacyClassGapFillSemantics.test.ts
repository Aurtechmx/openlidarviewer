/**
 * Producer classes kept by "Fill unclassified" keep their source meaning on
 * export. A legacy LAS (point format 0 to 5) carries class 8 (Model Key-point)
 * and 12 (Overlap Points); LAS 1.4 reserves both and carries the meaning as a
 * classification flag beside class 1. The gap fill keeps those codes but marks
 * the buffer derived, and the LAS 1.4 export used to write them as raw 8 and
 * 12 with no flags and no warning.
 *
 * Sources are hand-built with helpers/rawLas.ts and every written file is read
 * back with its independent reader, not with the application's decoder.
 */

import { describe, it, expect } from 'vitest';
import { buildLas, readLas, type RawPoint } from './helpers/rawLas';
import { loadLas } from '../src/io/loadLas';
import { deriveClassification } from '../src/render/class/deriveClassification';
import { convertCloud } from '../src/convert/convertCloud';
import { ClassEditHistory, recordClassEdit, stepClassEdit } from '../src/render/measure/classEditHistory';
import { clipCloud } from '../src/render/clip/clipCloud';
import { PointCloud } from '../src/model/PointCloud';
import { planClassSemantics } from '../src/convert/classSemantics';

const KEY_POINT = 2;
const WITHHELD = 4;
const OVERLAP = 8;
const N = 100;

/** Point 0 class 8, point 1 class 12 (withheld), point 2 class 2, the rest 0 or 1. */
function legacySource(): Uint8Array {
  const points: RawPoint[] = Array.from({ length: N }, (_, i) => ({
    cls: i === 0 ? 8 : i === 1 ? 12 : i === 2 ? 2 : i % 2,
    flags: i === 1 ? WITHHELD : 0,
  }));
  return buildLas({ version: '1.2', pdrf: 3, points });
}

async function open(bytes: Uint8Array): Promise<PointCloud> {
  return loadLas(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    'las', 'legacy.las', 1, undefined, true);
}

/** The gap fill as the viewer applies it: one recorded whole-scan replace, marked derived. */
function fillGaps(cloud: PointCloud, history = new ClassEditHistory()): ClassEditHistory {
  const derived = deriveClassification(cloud.positions, cloud.pointCount,
    { cellSizeM: 1, existingClassification: cloud.classification });
  recordClassEdit(history, cloud, (buf) => buf.set(derived.codes), 'derived', derived.classifier.method);
  return history;
}

function write(cloud: PointCloud, format: 'las' | 'las14') {
  const result = convertCloud(cloud, { format });
  expect(result.file, result.report.log.map((e) => e.message).join('\n')).not.toBeNull();
  return { raw: readLas(result.file!.bytes), log: result.report.log };
}

describe('legacy key-point and overlap classes after Fill unclassified', () => {
  it('writes preserved legacy 8 and 12 as class 1 with the key-point and overlap flags in LAS 1.4', async () => {
    const cloud = await open(legacySource());
    const plain = write(cloud, 'las14');
    expect(plain.raw.cls.slice(0, 3)).toEqual([1, 1, 2]);
    expect(plain.raw.flags.slice(0, 2)).toEqual([KEY_POINT, OVERLAP | WITHHELD]);

    fillGaps(cloud);
    expect(cloud.classificationProvenance).toBe('derived');
    expect([...cloud.classification!.slice(0, 3)]).toEqual([8, 12, 2]);
    const { raw, log } = write(cloud, 'las14');
    expect(raw.cls.slice(0, 3)).toEqual([1, 1, 2]);
    expect(raw.flags.slice(0, 3)).toEqual([KEY_POINT, OVERLAP | WITHHELD, 0]);
    // Filled points are written as derived, never reinterpreted.
    expect(raw.cls.slice(3).every((c) => c >= 1 && c <= 6)).toBe(true);
    expect(log.some((e) => /1 point carried legacy class 8/.test(e.message))).toBe(true);
    expect(log.some((e) => /1 point carried legacy class 12/.test(e.message))).toBe(true);
    // The live buffer is untouched.
    expect([...cloud.classification!.slice(0, 2)]).toEqual([8, 12]);
  });

  it('writes preserved legacy 8 and 12 unchanged in LAS 1.2, where they keep their meaning', async () => {
    const cloud = await open(legacySource());
    fillGaps(cloud);
    const { raw, log } = write(cloud, 'las');
    expect(raw.version).toBe('1.2');
    expect(raw.cls.slice(0, 3)).toEqual([8, 12, 2]);
    expect(raw.flags.slice(0, 2)).toEqual([0, WITHHELD]);
    expect(log.some((e) => e.level === 'warn' && /^Class (8|12) /.test(e.message))).toBe(false);
  });

  it('follows undo and redo of the fill', async () => {
    const cloud = await open(legacySource());
    const history = fillGaps(cloud);
    stepClassEdit(history, cloud, 'undo');
    expect(cloud.classificationProvenance).toBe('source');
    let out = write(cloud, 'las14').raw;
    expect(out.cls.slice(0, 2)).toEqual([1, 1]);
    expect(out.flags.slice(0, 2)).toEqual([KEY_POINT, OVERLAP | WITHHELD]);
    stepClassEdit(history, cloud, 'redo');
    expect(cloud.classificationProvenance).toBe('derived');
    out = write(cloud, 'las14').raw;
    expect(out.cls.slice(0, 2)).toEqual([1, 1]);
    expect(out.flags.slice(0, 2)).toEqual([KEY_POINT, OVERLAP | WITHHELD]);
  });

  it('keeps the translation on a clip-scoped export', async () => {
    const cloud = await open(legacySource());
    fillGaps(cloud);
    const p = cloud.positions;
    // A box around points 0 to 4 (positions climb with the index).
    const box = { min: [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5] as [number, number, number],
      max: [p[12] + 0.5, p[13] + 0.5, p[14] + 0.005] as [number, number, number] };
    const subset = clipCloud(cloud, { box, mode: 'keep-inside', enabled: true });
    expect(subset.pointCount).toBe(5);
    expect(subset.classificationProvenance).toBe('derived');
    const { raw } = write(subset, 'las14');
    expect(raw.cls.slice(0, 3)).toEqual([1, 1, 2]);
    expect(raw.flags.slice(0, 2)).toEqual([KEY_POINT, OVERLAP | WITHHELD]);
  });

  it('does not translate a point whose preserved class was then edited by hand', async () => {
    const cloud = await open(legacySource());
    const history = fillGaps(cloud);
    // Lasso reclassify point 0 to Ground.
    recordClassEdit(history, cloud, (buf) => { buf[0] = 2; });
    const { raw } = write(cloud, 'las14');
    expect(raw.cls.slice(0, 2)).toEqual([2, 1]);
    expect(raw.flags.slice(0, 2)).toEqual([0, OVERLAP | WITHHELD]);
  });

  it('translates when the derived codes are attached directly over the producer codes', async () => {
    const cloud = await open(legacySource());
    const derived = deriveClassification(cloud.positions, cloud.pointCount,
      { cellSizeM: 1, existingClassification: cloud.classification });
    cloud.attachDerivedClassification(derived.codes, derived.classifier.method);
    const { raw } = write(cloud, 'las14');
    expect(raw.cls.slice(0, 2)).toEqual([1, 1]);
    expect(raw.flags.slice(0, 2)).toEqual([KEY_POINT, OVERLAP | WITHHELD]);
  });

  it('assumes no table for a derived buffer from an unknown source format', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      classification: Uint8Array.from([8, 12]),
      classificationFlags: Uint8Array.from([0, 0]),
      sourceFormat: 'las', name: 'x.las', origin: [0, 0, 0],
    });
    recordClassEdit(new ClassEditHistory(), cloud, () => {}, 'derived');
    const { raw } = write(cloud, 'las14');
    expect(raw.cls).toEqual([8, 12]);
    expect(raw.flags).toEqual([0, 0]);
  });
});

describe('planClassSemantics with producer codes beside a derived buffer', () => {
  const base = { classificationFlags: undefined, count: 3 } as const;

  it('translates only the points whose code is the producer code', () => {
    const plan = planClassSemantics({
      ...base, sourcePdrf: 3, provenance: 'derived', target: 'extended',
      classification: Uint8Array.from([8, 12, 8]),
      producerClassification: Uint8Array.from([8, 12, 1]),
    });
    expect([...plan.classification!]).toEqual([1, 1, 8]);
    expect([...plan.classificationFlags!]).toEqual([KEY_POINT, OVERLAP, 0]);
    expect(plan.translations.map((t) => [t.code, t.points])).toEqual([[8, 1], [12, 1]]);
  });

  it('reports a legacy-reserved producer code that LAS 1.4 names', () => {
    const plan = planClassSemantics({
      ...base, sourcePdrf: 3, provenance: 'derived', target: 'extended',
      classification: Uint8Array.from([11, 2, 2]),
      producerClassification: Uint8Array.from([11, 0, 0]),
    });
    expect(plan.changes.map((c) => c.code)).toEqual([11]);
  });

  it('reports every differing producer code of an extended source on a legacy write', () => {
    const plan = planClassSemantics({
      ...base, sourcePdrf: 6, provenance: 'derived', target: 'legacy',
      classification: Uint8Array.from([8, 2, 2]),
      producerClassification: Uint8Array.from([8, 0, 0]),
    });
    expect(plan.changes.map((c) => c.code)).toEqual([8]);
  });

  it('warns about a legacy-source code with no producer record on an upgrade', () => {
    const plan = planClassSemantics({
      ...base, sourcePdrf: 3, provenance: 'derived', target: 'extended',
      classification: Uint8Array.from([8, 2, 2]),
      producerClassification: undefined,
    });
    expect(plan.translations).toEqual([]);
    expect(plan.changes.map((c) => c.code)).toEqual([8]);
    expect(plan.events.map((e) => e.level)).toEqual(['warn']);
  });
});
