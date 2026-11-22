/**
 * sheetMeasurement.ts: a measurement as a drawn sheet shows it. The figure is
 * the Measure panel's own formatted value and the support line is the panel's
 * own grade caption, so the sheet and the panel cannot word them apart.
 */

/** One measurement for a sheet. Points are in the raw scene frame, as picked. */
export interface SheetMeasurement {
  readonly name: string;
  readonly kind: string;
  /** The panel's formatted value, e.g. "1.24 ha" or "Cut 12.4 m³ · Fill 3.1 m³". */
  readonly value: string;
  /** The panel's support grade and its caption; null when no cloud graded it. */
  readonly grade: 'green' | 'yellow' | 'red' | null;
  readonly support: string | null;
  /** Picked points, raw scene frame. */
  readonly points: ReadonlyArray<readonly [number, number, number]>;
  /** A closed ring (area, volume, lasso). */
  readonly closed: boolean;
  /** Caveats the panel prints under the value (base level, partial read, unverified unit). */
  readonly notes: readonly string[];
}

/** The support word the sheet's table prints, from the grade. */
export function supportWord(grade: SheetMeasurement['grade']): string {
  if (grade === 'green') return 'Supported';
  if (grade === 'yellow') return 'Caution';
  if (grade === 'red') return 'Unverified';
  return 'Not graded';
}
