/**
 * legacyClassGuard.ts
 *
 * Refuse, rather than silently write, a LAS 1.2 file whose classes would wrap.
 *
 * The legacy point formats (0 to 5) hold the class in five bits and `writeLas`
 * writes `class & 0x1f`. A code above 31 is not rejected by anything: it lands
 * on another valid class, so 33 reads back as 1 (Unclassified) and 64 as 0
 * (Created, Never Classified), and every reader opens the file without an
 * error. The corruption is silent, so the write gate in `convertCloud.ts`
 * refuses it unless the request sets `allowLegacyClassWrap`, and says which
 * way forward keeps the classes (LAS 1.4) and which writes them wrapped (the
 * opt-in control, named by `LEGACY_CLASS_WRAP_OPT_IN`).
 *
 * The writer itself stays a pure writer: masking is its documented job, and
 * the refusal belongs to the caller that chose the format, the same split as
 * `export/fullResClassGuard.ts`.
 *
 * The wording comes from `lasSemantics` (`inspectLegacyConversion` /
 * `describeLoss`), so the refusal names classes the way the rest of the app
 * does. Those class tables are kept out of the eager shell, which is why the
 * export preview (`export/exportSummary.ts`) receives this module's sentences
 * through `previewLegacyClassWrap` rather than composing its own.
 *
 * Pure data. No DOM, no three.js, no I/O.
 */

import {
  FIRST_EXTENDED_PDRF,
  LEGACY_MAX_CLASS,
  describeLoss,
  inspectLegacyConversion,
} from '../lasSemantics';
import { LEGACY_CLASS_WRAP_OPT_IN, LEGACY_RETURN_CLAMP_OPT_IN } from './types';

/** The classes a LAS 1.2 write would wrap. */
export interface LegacyClassWrap {
  /** Points whose class is above 31. */
  readonly points: number;
  /** Each such code once, ascending. */
  readonly codes: readonly number[];
}

/** What the LAS 1.2 write gate says about one cloud's classes above 31. */
export interface LegacyClassWrapNote {
  /** The refusal returned when the write is not opted in. */
  readonly refusal: string;
  /** The warning logged when it is. */
  readonly warning: string;
}

/**
 * Count the points and codes a legacy write would wrap. One pass over the
 * buffer into a per-code tally, so the cost is the same whether none or all
 * of the points wrap.
 */
export function countLegacyClassWrap(classification: Uint8Array | null | undefined): LegacyClassWrap {
  if (!classification) return { points: 0, codes: [] };
  const perCode = new Uint32Array(256);
  for (let i = 0; i < classification.length; i++) perCode[classification[i]]++;
  let points = 0;
  const present: number[] = [];
  for (let code = LEGACY_MAX_CLASS + 1; code < perCode.length; code++) {
    if (perCode[code] === 0) continue;
    points += perCode[code];
    present.push(code);
  }
  return { points, codes: inspectLegacyConversion(present).wrappingCodes };
}

/**
 * The refusal. Names how many points and which codes would wrap, and both ways
 * forward. Codes above 31 exist only in the extended formats, so they are
 * named against the extended table.
 */
export function legacyClassWrapRefusal(wrap: LegacyClassWrap): string {
  const loss = describeLoss(inspectLegacyConversion(wrap.codes), FIRST_EXTENDED_PDRF);
  const points = `${wrap.points.toLocaleString()} point${wrap.points === 1 ? '' : 's'}`;
  return (
    `LAS 1.2 was not written. In ${points}, ${loss}. Choose LAS 1.4 to keep them, ` +
    `or tick "${LEGACY_CLASS_WRAP_OPT_IN}" to write each as its low 5 bits.`
  );
}

/** The warning an opted-in write logs, with the arithmetic a reader will see. */
export function legacyClassWrapWarning(points: number): string {
  return `LAS 1.2 stores 5-bit classes — ${points.toLocaleString()} points with classes > 31 wrap to their low 5 bits (class & 31), so 33 reads back as 1 and 64 as 0; use LAS 1.4 to preserve them.`;
}

/**
 * The gate's verdict on a resident class buffer, for the export preview. Null
 * when nothing wraps or no classification is resident, so the preview says
 * nothing about a loss that will not happen.
 */
export function previewLegacyClassWrap(
  classification: Uint8Array | null | undefined,
): LegacyClassWrapNote | null {
  const wrap = countLegacyClassWrap(classification);
  if (wrap.points === 0) return null;
  return { refusal: legacyClassWrapRefusal(wrap), warning: legacyClassWrapWarning(wrap.points) };
}

/*
 * Returns. The legacy formats hold the return number and the number of
 * returns in 3 bits each, and `writeLas` clamps both to 7, so return 8 of 12
 * reads back as 7 of 7. The write gate refuses that unless the request sets
 * `allowLegacyReturnClamp`, the same split as the class wrap above.
 */

/** Highest value the legacy 3-bit return fields hold. */
const LEGACY_MAX_RETURN = 7;

/** Points whose return number or number of returns is above 7. */
export function countLegacyReturnClamp(
  returnNumber: Uint8Array | undefined,
  returnCount: Uint8Array | undefined,
  count: number,
): number {
  let points = 0;
  for (let i = 0; i < count; i++) {
    if ((returnNumber && returnNumber[i] > LEGACY_MAX_RETURN) || (returnCount && returnCount[i] > LEGACY_MAX_RETURN)) {
      points++;
    }
  }
  return points;
}

function pointsLabel(points: number): string {
  return `${points.toLocaleString()} point${points === 1 ? '' : 's'}`;
}

/** The refusal, with the count and both ways forward. */
export function legacyReturnClampRefusal(points: number): string {
  return (
    `LAS 1.2 was not written. ${pointsLabel(points)} have a return number or number of returns above 7, ` +
    `which LAS 1.2 clamps to 7, so return 8 of 12 would read back as 7 of 7. ` +
    `Choose LAS 1.4 to keep them, or tick "${LEGACY_RETURN_CLAMP_OPT_IN}" to write them clamped.`
  );
}

/** The warning an opted-in write logs. */
export function legacyReturnClampWarning(points: number): string {
  return `LAS 1.2 stores returns in 3 bits. ${pointsLabel(points)} with returns above 7 are written clamped to 7; use LAS 1.4 to keep them.`;
}

/** The line recorded in the written file's provenance. */
export function legacyReturnClampProvenance(points: number): string {
  return `LAS 1.2: returns above 7 clamped to 7 on ${pointsLabel(points)}.`;
}
