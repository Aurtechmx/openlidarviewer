/**
 * flowDrainageSheetUnits.ts: the linear unit of the drainage sheet's frame.
 * and why the catchment study is unavailable. Kept apart from the PDF builder
 * so the Lab can name both without loading pdf-lib.
 */

import { UNIT_FACTORS } from '../units/units';
import type { ReportGate } from '../simulation/flowPulse/watershed/reportGate';

export type DrainageLinearUnit = 'metre' | 'foot' | 'us-survey-foot' | 'unknown';

export const UNIT_TO_METRES: Readonly<Record<DrainageLinearUnit, number | null>> = {
  metre: 1, foot: UNIT_FACTORS.M_PER_FT, 'us-survey-foot': UNIT_FACTORS.M_PER_US_FT, unknown: null,
};

/** The linear unit for metres-per-unit, or 'unknown' when it is none of the three. */
export function linearUnitOf(unitToMetres: number | null | undefined): DrainageLinearUnit {
  if (unitToMetres == null) return 'unknown';
  for (const u of ['metre', 'foot', 'us-survey-foot'] as const) {
    if (Math.abs(unitToMetres - UNIT_TO_METRES[u]!) < 1e-9) return u;
  }
  return 'unknown';
}

/** Why the catchment study cannot be printed for this run, or null when it can. */
export function catchmentStudyGateText(gate: ReportGate): string | null {
  if (gate.ok) return null;
  switch (gate.reason) {
    case 'incomplete-coverage': return 'The terrain was built from part of the source; run terrain on the full scan.';
    case 'scale-unresolved': return 'The horizontal scale is not resolved, so there are no metres to measure.';
    case 'raw-routing': return 'The run uses raw terrain; switch to Priority-Flood conditioned.';
    default: return 'Flow Pulse has not produced a run.';
  }
}

