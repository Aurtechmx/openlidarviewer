import type { CrsLinearUnit } from '../io/crs';
import { isLinearUnitKnown } from '../geo/CoordinateTypes';

/** One extent/density/spacing row the streaming Scan-report emits. */
export interface ExtentRowSpec {
  readonly label: string;
  readonly value: string;
  /**
   * true → the caller wraps this row with the class-scope honesty sentinel
   * (the full-cloud header figures — density / spacing — that a class filter
   * cannot scope). false → a plain info row.
   */
  readonly scoped: boolean;
}

export interface StreamingExtentResult {
  /**
   * Whether the source CRS declares a real linear unit. false when the CRS is
   * absent or carries `linearUnit: 'unknown'` — in which case the rows are in
   * raw source units and NOT labelled "m" / "pts/m²".
   */
  readonly unitConfirmed: boolean;
  readonly rows: readonly ExtentRowSpec[];
}

type ExtentCrs = {
  readonly linearUnit?: CrsLinearUnit;
  readonly linearUnitToMetres?: number;
  readonly verticalUnitToMetres?: number;
} | null;

/**
 * Build the Width / Depth / Height / Density / Spacing rows for the streaming
 * Scan-report, FAILING CLOSED on an unconfirmed linear unit.
 *
 * An unknown-unit CRS carries the inert placeholder `linearUnitToMetres: 1`,
 * and a CRS-less cloud resolves the same way. Multiplying a source span by
 * that factor and stamping "m" silently reports non-metre data as metres — a
 * state-plane-FEET COPC would over-report extent ~3.28× mislabelled as metres.
 * So metres are only claimed when the CRS declares a real linear unit
 * (`crsInfo != null && crsInfo.linearUnit !== 'unknown'`), the same gate the
 * measure tool (`setCrsKnown`) and the lasso (`densityUnitKnown`) already
 * apply. When the unit is unconfirmed the metre factor is dropped, the raw
 * source span is shown, and the "m" / "pts/m²" claim is withheld.
 *
 * COPC/EPT are Z-up by spec, so the horizontal footprint is X·Y and height is
 * Z; the vertical span uses the vertical unit when the CRS declares one.
 */
export function streamingExtentRows(
  header: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] },
  crsInfo: ExtentCrs,
  sourcePointCount: number,
): StreamingExtentResult {
  const unitConfirmed = isLinearUnitKnown(crsInfo);

  // Apply the metre factor ONLY when the unit is real. Otherwise the span stays
  // in raw source units (factor 1) and is not labelled "m".
  const mpu = unitConfirmed ? (crsInfo?.linearUnitToMetres ?? 1) : 1;
  const vmpu = unitConfirmed ? (crsInfo?.verticalUnitToMetres ?? mpu) : 1;

  const w = (header.max[0] - header.min[0]) * mpu;
  const d = (header.max[1] - header.min[1]) * mpu;
  const h = (header.max[2] - header.min[2]) * vmpu;

  const lenUnit = unitConfirmed ? ' m' : ' (source units)';
  const rows: ExtentRowSpec[] = [
    { label: 'Width', value: `${w.toFixed(1)}${lenUnit}`, scoped: false },
    { label: 'Depth', value: `${d.toFixed(1)}${lenUnit}`, scoped: false },
    { label: 'Height', value: `${h.toFixed(1)}${lenUnit}`, scoped: false },
  ];

  const footprintArea = w * d;
  if (footprintArea > 0 && sourcePointCount > 0) {
    const density = sourcePointCount / footprintArea;
    const spacing = Math.sqrt(footprintArea / sourcePointCount);
    const densityUnit = unitConfirmed ? ' pts/m²' : ' pts/unit²';
    const spacingUnit = unitConfirmed ? ' m' : ' (source units)';
    rows.push(
      { label: 'Density', value: `${density.toFixed(1)}${densityUnit}`, scoped: true },
      { label: 'Spacing', value: `${spacing.toFixed(2)}${spacingUnit}`, scoped: true },
    );
  }

  return { unitConfirmed, rows };
}
