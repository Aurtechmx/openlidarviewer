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
 *     generalization, so they export the GENERALIZED geometry (honesty-gated
 *     simplify + smooth — never the panel's on-screen default style) stamped
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
 * no cartographic smoothing (Survey Review); every other state routes to the
 * generalized cartographic method so a transformed line is never stamped
 * "exact" — and a line stamped "generalized" is never the untransformed default.
 */
export function contourExportIntentFromState(state: ContourStudioState): ContourExportIntent {
  const smoothing = state.surface.cartographicSmoothing;
  const analyticalExact = state.contour.analytical && !smoothing;

  // Exact analytical → 'crisp'. EVERYTHING else → 'generalized', so the
  // geometry and the method stamp derive from the same predicate and can never
  // disagree. 'generalized' (honesty-gated simplify + smooth) is deliberately
  // NOT 'smooth': 'smooth' is the panel's on-screen default style, and an
  // intent that resolves to the default style regenerates nothing — the export
  // host reuses the on-screen result and the purpose changes only a provenance
  // string (the v0.5.9 "all purposes export the same file" bug).
  const shapeStyle: ContourShapeStyle = analyticalExact ? 'crisp' : 'generalized';

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
