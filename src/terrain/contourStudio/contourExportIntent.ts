/**
 * contourExportIntent.ts
 *
 * Turns the active Contour Studio purpose/settings into a concrete EXPORT intent
 * so the deliverable a user downloads actually differs by purpose — not just the
 * on-screen summary. This is what makes the purposes "real":
 *
 *   - Survey Review keeps smoothing off and emits exact analytical isolines, so
 *     it exports the CRISP geometry stamped `olv.contour.analytical@1`.
 *   - Presentation Map / Engineering Plan / Terrain Research apply cartographic
 *     generalization, so they export the smoothed geometry stamped
 *     `olv.contour.generalize.terrain-adaptive@1`.
 *
 * The chosen `shapeStyle` drives the host's `buildResultForExport`, which
 * regenerates the contour geometry at that style, so two purposes genuinely
 * serialize different vertices. The `methodId@methodVersion` + `purpose` travel
 * into the export provenance, making each file self-describing and reproducible.
 *
 * Pure and unit-testable: no DOM, no I/O, no host coupling.
 */

import type { ContourStudioState } from './contourStudioState';
import type { ContourShapeStyle } from '../contour/contourShapeStyle';

export interface ContourExportIntent {
  /** The purpose that produced this intent (stamped into provenance). */
  readonly purpose: string;
  /** Geometry style the export regenerates at (drives buildResultForExport). */
  readonly shapeStyle: ContourShapeStyle;
  /** Whether only index (bold) contours are labelled. */
  readonly labelsIndexOnly: boolean;
  /** Stable method id of the geometry actually exported. */
  readonly methodId: string;
  /** Method version paired with `methodId`. */
  readonly methodVersion: number;
  /** Human tag "id@version" for provenance and diagnostics. */
  readonly methodTag: string;
}

/**
 * Derive the export intent from a Contour Studio state. Exact analytical
 * geometry is used only when the purpose emits analytical contours AND applies
 * no cartographic smoothing (Survey Review); any generalization/smoothing routes
 * to the cartographic method so a smoothed line is never stamped "exact".
 */
export function contourExportIntentFromState(state: ContourStudioState): ContourExportIntent {
  const smoothing = state.surface.cartographicSmoothing;
  const analyticalExact = state.contour.analytical && !smoothing;

  const shapeStyle: ContourShapeStyle = analyticalExact
    ? 'crisp'
    : smoothing
      ? 'smooth'
      : 'generalized';

  const methodId = analyticalExact
    ? 'olv.contour.analytical'
    : 'olv.contour.generalize.terrain-adaptive';
  const methodVersion = 1;

  return {
    purpose: state.purpose,
    shapeStyle,
    labelsIndexOnly: state.labels.indexOnly,
    methodId,
    methodVersion,
    methodTag: `${methodId}@${methodVersion}`,
  };
}
