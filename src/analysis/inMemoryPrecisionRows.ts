/**
 * inMemoryPrecisionRows.ts — the two report rows that disclose what the
 * Float32 position buffer can still tell apart.
 *
 * REPRESENTATIONAL RESOLUTION, not accuracy. Every other extent row on a scan
 * card describes the survey; these two describe the STORAGE. On a wide extent
 * the two diverge: a millimetre-quantized source file can sit in a buffer whose
 * step is a centimetre, and nothing else on the card would say so. The wording
 * therefore never borrows survey, sensor or vertical-accuracy vocabulary.
 *
 * One formatter for both report paths. The static Scan Report reads a resident
 * `PointCloud`; the streaming report reads a header extent against a render
 * origin. They measure different clouds, but the figure they print is the same
 * measurement from `geo/inMemoryPrecision.ts`, so the sentence that prints it
 * lives here rather than once per caller, where the two would drift.
 *
 * FAILS CLOSED on the unit: with no established linear unit there is no length
 * to report, so the step is shown in source units and left ungraded rather than
 * stamped with a fabricated millimetre.
 *
 * Pure — no DOM, no three.js. Runs unchanged in Node tests.
 */

import type { AnalysisRow } from './ModuleApi';
import type { InMemoryPrecision } from '../geo/inMemoryPrecision';
import { formatPrecisionMetres, precisionGradeLabel } from '../geo/inMemoryPrecision';

/**
 * The `In-memory resolution` headline plus the advanced `Quantization basis`
 * diagnostic, in that order, for an already-measured estimate.
 */
export function inMemoryPrecisionRows(precision: InMemoryPrecision): AnalysisRow[] {
  const pm = precision.metres;
  return [
    pm
      ? {
          label: 'In-memory resolution',
          value:
            `${formatPrecisionMetres(pm.worstCaseSpacing)} worst case, `
            + `${formatPrecisionMetres(pm.typicalSpacing)} mean over the reach `
            + `(${precisionGradeLabel(precision.grade)})`,
          status: precision.grade === 'fine' ? 'info' : 'warn',
        }
      : {
          label: 'In-memory resolution',
          value:
            `${precision.worstCaseSpacing.toPrecision(3)} (source units) worst case — `
            + 'no linear unit declared, not graded',
          status: 'warn',
        },
    {
      label: 'Quantization basis',
      value:
        `Float32 positions, ${precision.governingAxis} axis, `
        + `${precision.reach.toFixed(0)} source units from the local origin `
        + `(${precision.localOrigin.map((n) => n.toFixed(0)).join(', ')})`,
      status: 'info',
      advanced: true,
    },
  ];
}
