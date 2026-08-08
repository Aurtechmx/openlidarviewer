/**
 * processStages.ts — the adaptive Process Studio stage model (Phase 1).
 *
 * The Process Studio shows only the stages that matter for the loaded data:
 * Prepare → Classify → Surface → Align → Extract → Validate/Export. This pure
 * function decides which stages are relevant from the capability plan and scan
 * facts, so the shell renders the adaptive flow without re-deriving eligibility.
 * No UI, no side effects — the shell reads this.
 */

import type { ProcessInputs } from './ProcessPlan';
import { evaluateCapabilities, capabilityFor } from './processCapabilities';

export type StageId = 'prepare' | 'classify' | 'surface' | 'align' | 'extract' | 'validate-export';

export interface Stage {
  readonly id: StageId;
  readonly title: string;
  readonly relevant: boolean;
  /** One sentence on why this stage is shown or skipped. */
  readonly reason: string;
}

/**
 * Compute the adaptive stage list for the current inputs. Prepare and
 * Validate/Export are always relevant (every dataset is prepared and every run
 * ends at validation/export); the middle stages appear only when the data can
 * actually use them.
 */
export function adaptiveStages(inputs: ProcessInputs): Stage[] {
  const plan = evaluateCapabilities(inputs);
  const scans = inputs.scans;
  const one = scans[0];
  const notBlocked = (p: Parameters<typeof capabilityFor>[1]): boolean =>
    (capabilityFor(plan, p)?.readiness ?? 'blocked') !== 'blocked';

  const classifyRelevant = one !== undefined && one.classification !== 'full';
  const surfaceRelevant = notBlocked('dtm') || notBlocked('dsm') || notBlocked('contours');
  const alignRelevant = scans.length >= 2;
  const extractRelevant = notBlocked('building-footprints');

  return [
    { id: 'prepare', title: 'Prepare', relevant: true, reason: 'Every dataset is inspected and prepared first.' },
    {
      id: 'classify', title: 'Classify', relevant: classifyRelevant,
      reason: classifyRelevant ? 'Classification is missing or partial; gaps can be classified.' : 'The cloud is already fully classified.',
    },
    {
      id: 'surface', title: 'Surface', relevant: surfaceRelevant,
      reason: surfaceRelevant ? 'A terrain surface (DTM/DSM/contours) is buildable.' : 'No terrain surface is available for this data.',
    },
    {
      id: 'align', title: 'Align', relevant: alignRelevant,
      reason: alignRelevant ? `${scans.length} scans loaded; alignment applies.` : 'A single scan needs no alignment.',
    },
    {
      id: 'extract', title: 'Extract', relevant: extractRelevant,
      reason: extractRelevant ? 'Structure extraction (e.g. building footprints) is available.' : 'No feature-extraction product is currently available.',
    },
    { id: 'validate-export', title: 'Validate / Export', relevant: true, reason: 'Every run ends at validation and export.' },
  ];
}

/** Only the stages worth showing. */
export function relevantStages(inputs: ProcessInputs): Stage[] {
  return adaptiveStages(inputs).filter((s) => s.relevant);
}
