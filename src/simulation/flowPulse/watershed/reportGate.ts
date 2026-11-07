/**
 * reportGate.ts: whether a Flow Pulse run may carry a catchment study, and
 * if not, why. Kept apart from the study model so the Lab can ask without
 * loading it.
 */

import type { FlowConditioning, FlowPulseResult } from '../flowPulseRunner';

export type ReportGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'incomplete-coverage' | 'scale-unresolved' | 'raw-routing' | 'no-run' };

/** Offered only for a complete, metre-scaled, Priority-Flood conditioned run. */
export function watershedReportGate(result: FlowPulseResult | null, conditioning: FlowConditioning): ReportGate {
  if (result === null) return { ok: false, reason: 'no-run' };
  if (!result.basis.complete) return { ok: false, reason: 'incomplete-coverage' };
  if (!result.basis.horizontalScaleResolved) return { ok: false, reason: 'scale-unresolved' };
  if (conditioning !== 'priority-flood') return { ok: false, reason: 'raw-routing' };
  return { ok: true };
}
