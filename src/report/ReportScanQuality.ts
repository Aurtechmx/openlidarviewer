/**
 * ReportScanQuality.ts — the Scan QA facts, assembled from what the loaded
 * cloud can prove.
 *
 * This is the honest successor to the retired `scan-acceptance` report, whose
 * checklist was metadata-PRESENCE rows dressed as a certificate. The rule here
 * is the opposite: state only facts read off the cloud — the georeferencing
 * verdict, how the classification arose, which attributes the cloud carries —
 * and pair them with an explicit, non-optional list of what the report does NOT
 * establish. Nothing here asserts survey-grade acceptance, vertical accuracy, or
 * a density figure it did not measure.
 *
 * Pure and deterministic: given the facts it returns the section model and the
 * caveats. No DOM, no pdf-lib, no cloud import — the caller reads the facts off
 * the cloud and passes primitives across, keeping the report module model-blind.
 */

import type { ReportScanQuality } from './types';
import { georefStatus } from '../geo/georefStatus';

/**
 * The raw facts the caller reads off the cloud, as primitives only. Kept
 * separate from {@link ScanQualityInput} so the caller (the EAGER report-export
 * path) passes primitives and never imports `georefStatus` or the builder:
 * {@link scanQualityFromFacts} turns these into the section in the lazy report
 * chunk, so nothing here weighs on the startup bundle.
 */
export interface ScanQualityFacts {
  readonly crsKnown: boolean;
  readonly datumKnown: boolean;
  readonly crsName: string | null;
  readonly datumName: string | null;
  readonly hasClassification: boolean;
  readonly classificationDerived: boolean;
  readonly attributes: readonly { readonly name: string; readonly present: boolean }[];
}

/**
 * Build the Scan QA section from the raw cloud facts: resolve the plain-language
 * georeferencing verdict, then assemble the section and its caveats. Called from
 * the lazy report composer so `georefStatus` and the builder ride that chunk.
 */
export function scanQualityFromFacts(facts: ScanQualityFacts): ReportScanQuality {
  const gs = georefStatus(facts.crsKnown, facts.datumKnown, {
    crsName: facts.crsName,
    datumName: facts.datumName,
  });
  return buildScanQuality({
    coordinateHeadline: gs.headline,
    positionLabel: gs.positionLabel,
    heightLabel: gs.heightLabel,
    positionKnown: gs.positionKnown,
    heightKnown: gs.heightKnown,
    hasClassification: facts.hasClassification,
    classificationDerived: facts.classificationDerived,
    attributes: facts.attributes,
  });
}

/** The facts a Scan QA section is built from, as primitives. */
export interface ScanQualityInput {
  /** Plain-language georeferencing headline (from `geo/georefStatus`). */
  readonly coordinateHeadline: string;
  readonly positionLabel: string;
  readonly heightLabel: string;
  /** Whether the scan has a horizontal position (CRS). */
  readonly positionKnown: boolean;
  /** Whether the scan has a real-world height reference (vertical datum). */
  readonly heightKnown: boolean;
  /** Whether the cloud carries any classification at all. */
  readonly hasClassification: boolean;
  /** Whether that classification was DERIVED in the viewer vs producer-supplied. */
  readonly classificationDerived: boolean;
  /** Which point attributes the cloud carries. */
  readonly attributes: readonly { readonly name: string; readonly present: boolean }[];
}

/** How the classification arose, stated so a reader knows what to trust. */
function classificationNote(hasClassification: boolean, derived: boolean): string {
  if (!hasClassification) return 'No classification present.';
  return derived
    ? 'Classification derived in the viewer (heuristic) — review before trusting.'
    : 'Classification supplied by the producer, carried through unchanged.';
}

/**
 * The always-shown boundary of the report. The first two are unconditional (a
 * QA report is never an acceptance certificate and this viewer establishes no
 * vertical accuracy); the rest are added only where the cloud lacks the thing.
 */
function buildCaveats(input: ScanQualityInput): string[] {
  const caveats = [
    'This is a data-quality summary, not a survey-grade acceptance certificate.',
    'Vertical accuracy is not established — no checkpoint comparison was run.',
  ];
  if (!input.positionKnown) {
    caveats.push('The scan carries no horizontal CRS, so it is not placed on a map.');
  }
  if (!input.heightKnown) {
    caveats.push('No vertical datum is declared, so heights are not tied to a known reference.');
  }
  if (input.hasClassification && input.classificationDerived) {
    caveats.push('Derived classification is heuristic and is not a ground-truthed label.');
  }
  return caveats;
}

export function buildScanQuality(input: ScanQualityInput): ReportScanQuality {
  return {
    coordinateHeadline: input.coordinateHeadline,
    positionLabel: input.positionLabel,
    heightLabel: input.heightLabel,
    classificationNote: classificationNote(input.hasClassification, input.classificationDerived),
    attributes: input.attributes.map((a) => ({ name: a.name, present: a.present })),
    caveats: buildCaveats(input),
  };
}
