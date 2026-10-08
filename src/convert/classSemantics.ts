/**
 * classSemantics.ts: what a class number means in the source and in the target.
 *
 * LAS 1.0 to 1.3 (point formats 0 to 5) and LAS 1.4 formats 6 to 10 give
 * several of the numbers 0 to 31 a different meaning. One table, built from
 * the names in `lasSemantics`, drives both directions of a conversion, so the
 * single export and the batch converter (both go through `convertCloud`) agree.
 *
 *   code      legacy (LAS 1.2, Table 4)   extended (LAS 1.4 R15, Table 17)
 *   0-7, 9    same                        same
 *   8         Model Key-point             Reserved
 *   10, 11    Reserved                    Rail, Road Surface
 *   12        Overlap Points              Reserved
 *   13-22     Reserved                    Wire-Guard ... Temporal Exclusion
 *   23-31     Reserved                    Reserved
 *
 * Two legacy codes have an extended equivalent that is not a class. Class 12
 * becomes the overlap flag (bit 3) and class 8 becomes the key-point flag
 * (bit 1); the written class is 1 (Unclassified) because the legacy code says
 * nothing about the underlying class. Every other differing number is carried
 * unchanged and reported, since no mapping between the tables exists.
 *
 * Codes above 31 are the wrap guard's business (`legacyClassGuard.ts`).
 * Pure data. No DOM, no I/O.
 */

import { classAllocation, classificationName, isExtendedPdrf, FIRST_EXTENDED_PDRF, LEGACY_MAX_CLASS } from '../lasSemantics';
import type { ConversionEvent } from './conversionEvents';
import { LEGACY_CLASS_REINTERPRETATION_OPT_IN } from './types';

/** A PDRF inside the legacy table and one inside the extended table. */
const LEGACY_PDRF = 3;
const EXTENDED_PDRF = FIRST_EXTENDED_PDRF;

/** Extended classification-flag bits (LAS 1.4 R15, Classification Flags). */
const KEY_POINT_FLAG = 0x2;
const OVERLAP_FLAG = 0x8;
const UNCLASSIFIED = 1;

/** Legacy codes that become a flag beside class 1 when a file is upgraded. */
const LEGACY_CODE_TO_FLAG: Readonly<Record<number, { flag: number; name: string; flagName: string }>> = {
  8: { flag: KEY_POINT_FLAG, name: 'Model Key-Point (Mass Point)', flagName: 'key-point flag' },
  12: { flag: OVERLAP_FLAG, name: 'Overlap Points', flagName: 'overlap flag' },
};

/** What a code means under one table, or null when the table reserves it. */
function meaning(code: number, pdrf: number): string | null {
  if (classAllocation(code, pdrf) !== 'defined') return null;
  const name = classificationName(code, pdrf);
  // The legacy table lists codes 10 and 11 by the name "Reserved for ASPRS Definition".
  return name.startsWith('Reserved') ? null : name;
}

/** The codes 0 to 31 whose meaning differs between the two tables. */
export const DIFFERING_CLASS_CODES: readonly number[] = Array.from({ length: LEGACY_MAX_CLASS + 1 }, (_, c) => c).filter(
  (c) => meaning(c, LEGACY_PDRF) !== meaning(c, EXTENDED_PDRF),
);

export type ClassTarget = 'legacy' | 'extended';

export interface ClassSemanticsInput {
  /** Point format of the source file, when the source was a LAS file. */
  readonly sourcePdrf: number | undefined;
  /** Where the class buffer came from; only 'source' carries the producer's codes. */
  readonly provenance: string | undefined;
  readonly classification: Uint8Array | undefined;
  readonly classificationFlags: Uint8Array | undefined;
  readonly count: number;
  readonly target: ClassTarget;
}

export interface ClassFinding {
  readonly code: number;
  readonly points: number;
  readonly message: string;
}

export interface ClassSemanticsPlan {
  /** Translated copies when a translation applied; the input buffers otherwise. */
  readonly classification: Uint8Array | undefined;
  readonly classificationFlags: Uint8Array | undefined;
  /** Legacy codes written as class 1 plus a flag. */
  readonly translations: readonly ClassFinding[];
  /** Codes carried unchanged whose meaning differs in the target. */
  readonly changes: readonly ClassFinding[];
  /** One event per finding, translations first. */
  readonly events: readonly ConversionEvent[];
}

function pointsLabel(points: number): string {
  return `${points.toLocaleString()} point${points === 1 ? '' : 's'}`;
}

function reading(code: number, pdrf: number): string {
  return meaning(code, pdrf) ?? 'reserved';
}

/** Tally the codes of the first `count` points. */
function tally(classification: Uint8Array, count: number): Uint32Array {
  const perCode = new Uint32Array(256);
  for (let i = 0; i < count; i++) perCode[classification[i]]++;
  return perCode;
}

function upgradeFinding(code: number, points: number): ClassFinding {
  const t = LEGACY_CODE_TO_FLAG[code];
  if (t) {
    return {
      code,
      points,
      message: `${pointsLabel(points)} carried legacy class ${code} (${t.name}). LAS 1.4 reserves class ${code}, so they are written as class ${UNCLASSIFIED} (Unclassified) with the ${t.flagName} set.`,
    };
  }
  return { code, points, message: '' };
}

function changeFinding(code: number, points: number, target: ClassTarget): ClassFinding {
  const legacy = reading(code, LEGACY_PDRF);
  const extended = reading(code, EXTENDED_PDRF);
  const head = `Class ${code} (${pointsLabel(points)}): the number is written unchanged. It is ${extended} in LAS 1.4 and ${legacy} in LAS 1.0 to 1.3.`;
  // Where LAS 1.4 reserves the number and the legacy table defines it (8, 12),
  // a legacy reader does not see "reserved": it reads the legacy class.
  const legacyReads =
    extended === 'reserved' && legacy !== 'reserved'
      ? `LAS 1.2 readers will read ${pointsLabel(points) === '1 point' ? 'it' : 'them'} as ${legacy}.`
      : 'LAS 1.2 readers will not read the LAS 1.4 meaning.';
  const message =
    target === 'legacy'
      ? `${head} ${legacyReads} Use LAS 1.4 to keep the meaning.`
      : `${head} LAS 1.4 readers will read a meaning the source did not define.`;
  return { code, points, message };
}

/**
 * Plan the class and flag buffers for a write to `target`.
 *
 * Source codes are interpreted only when the source format is known and the
 * buffer is the producer's. For anything else (a derived or edited class, a
 * non-LAS source) no table is assumed: an upgrade translates nothing, and a
 * legacy write reports only the codes the extended table defines, which a
 * legacy reader cannot name whatever the source meant by them.
 */
export function planClassSemantics(input: ClassSemanticsInput): ClassSemanticsPlan {
  const { classification, classificationFlags, count, target } = input;
  const unchanged: ClassSemanticsPlan = { classification, classificationFlags, translations: [], changes: [], events: [] };
  if (!classification || count === 0) return unchanged;

  const known = input.sourcePdrf !== undefined && input.provenance === 'source';
  const sourceExtended = known && isExtendedPdrf(input.sourcePdrf as number);
  const sourceLegacy = known && !sourceExtended;
  if (target === 'extended' && !sourceLegacy) return unchanged;
  if (target === 'legacy' && sourceLegacy) return unchanged;

  const perCode = tally(classification, count);
  const translations: ClassFinding[] = [];
  const changes: ClassFinding[] = [];

  for (const code of DIFFERING_CLASS_CODES) {
    const points = perCode[code];
    if (points === 0) continue;
    if (target === 'extended') {
      if (LEGACY_CODE_TO_FLAG[code]) translations.push(upgradeFinding(code, points));
      // A legacy-reserved code the extended table now names.
      else if (meaning(code, EXTENDED_PDRF) !== null) changes.push(changeFinding(code, points, target));
    } else if (sourceExtended || meaning(code, EXTENDED_PDRF) !== null) {
      // Known extended source: every differing code. Unknown source: only the
      // codes the extended table defines.
      changes.push(changeFinding(code, points, target));
    }
  }

  let cls = classification;
  let flags = classificationFlags;
  if (translations.length > 0) {
    cls = classification.slice(0, count);
    flags = new Uint8Array(count);
    if (classificationFlags) flags.set(classificationFlags.subarray(0, count));
    for (let i = 0; i < count; i++) {
      const t = LEGACY_CODE_TO_FLAG[cls[i]];
      if (!t) continue;
      cls[i] = UNCLASSIFIED;
      flags[i] |= t.flag;
    }
  }

  const events: ConversionEvent[] = [
    ...translations.map((f): ConversionEvent => ({
      id: `class-${f.code}-translated`, kind: 'translated', level: 'info', points: f.points, message: f.message, acknowledged: false,
    })),
    ...changes.map((f): ConversionEvent => ({
      id: `class-meaning-${f.code}`, kind: 'reinterpreted', level: 'warn', points: f.points, message: f.message, acknowledged: false,
    })),
  ];
  return { classification: cls, classificationFlags: flags, translations, changes, events };
}

/**
 * The refusal a LAS 1.2 write returns when class numbers would change meaning
 * and the request has not allowed it. Names the points, the codes and both
 * ways forward.
 */
export function legacyClassReinterpretationRefusal(changes: readonly ClassFinding[]): string {
  const points = changes.reduce((n, f) => n + f.points, 0);
  const codes = changes.map((f) => f.code);
  const codeList = codes.length === 1 ? `class ${codes[0]}` : `classes ${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1]}`;
  return (
    `LAS 1.2 was not written. ${pointsLabel(points)} ${points === 1 ? 'has' : 'have'} ${codeList}, ` +
    `whose meaning in LAS 1.2 differs from the source, so LAS 1.2 readers would read a different class. ` +
    `Choose LAS 1.4 to keep the meaning, or tick "${LEGACY_CLASS_REINTERPRETATION_OPT_IN}" to write the numbers unchanged.`
  );
}
