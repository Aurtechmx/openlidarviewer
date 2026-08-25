/**
 * profilePdfInput.ts
 *
 * The one assembly of a profile sheet's inputs.
 *
 * WHY IT IS A MODULE OF ITS OWN. Two surfaces export the same sheet — the
 * Measurements panel's own control and the docked workbench's — and the
 * parameters a second call site silently drops are the ones that matter most:
 * the read scope, the classification basis of the heights, the CRS, the unit
 * system. That has happened here before; the builder has carried those
 * parameters since v0.4.0 and a call site discarding them was why every sheet
 * printed "not georeferenced" over a resolved frame. So there is one function
 * and both controls run it, and a sheet exported from either surface carries
 * the same provenance because it was assembled the same way.
 *
 * Pure. No DOM, no clock: `generatedAt` arrives as a parameter for the same
 * reason the builder demands one, so the same measurement is the same bytes.
 */

import type { ProfilePdfInput } from '../render/measure/profilePdf';
import type { MeasurementSummary } from '../render/measure/MeasureController';
import type { UnitSystem } from '../render/measure/types';

/** CRS provenance for the sheet header, as the host resolves it at export time. */
export interface ProfileExportContext {
  readonly crs: string | null;
  readonly verticalDatum: string | null;
}

/** What the caller states about the moment of export. */
export interface ProfilePdfInputOptions {
  /** Resolved frame, or null when the host could not state one. */
  readonly context: ProfileExportContext | null;
  readonly unitSystem: UnitSystem;
  /** Read at the app boundary, never inside the builder. */
  readonly generatedAt: Date;
}

/**
 * The sheet's inputs for one profile measurement.
 *
 * Every field the app knows is passed. `provenance` in particular: a reader of
 * an exported file cannot see the app state that produced it, so the sources,
 * the class policy and the read scope have to travel on the page or they are
 * lost the moment the session ends.
 */
export function profilePdfInputFor(
  s: MeasurementSummary,
  options: ProfilePdfInputOptions,
): ProfilePdfInput {
  return {
    name: s.name,
    samples: s.profileChart ?? [],
    residentOnly: s.profileChartResidentOnly,
    corridorWidthM: s.profileCorridorWidthM ?? null,
    groundPercentile: s.profileGroundPercentile ?? null,
    crs: options.context?.crs ?? null,
    verticalDatum: options.context?.verticalDatum ?? null,
    unitSystem: options.unitSystem,
    // False only when the loaded clouds hold conflicting render origins, in
    // which case the samples are local heights and the sheet must not print
    // the word elevation against them.
    datumKnown: s.profileDatumKnown !== false,
    provenance: s.profileProvenance ?? null,
    generatedAt: options.generatedAt,
  };
}
