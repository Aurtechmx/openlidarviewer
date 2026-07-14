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
 *     uniform-tolerance simplify + smooth — never the panel's on-screen default
 *     style) stamped `olv.contour.generalize@1`, each at its OWN per-purpose
 *     tolerance (`generalizeToleranceCells`). The stamp names the transformation
 *     the pipeline actually runs: a uniform Douglas–Peucker tolerance, NOT the
 *     terrain-adaptive module (`contourAdaptiveGeneralize`, which has no
 *     production caller). Stamping `terrain-adaptive` here would be an overclaim.
 *
 * The chosen `shapeStyle` + `generalizeToleranceCells` drive the host's
 * `buildResultForExport`, which regenerates the contour geometry at that style
 * and tolerance, so two purposes with different tolerances genuinely serialize
 * different vertices. The `methodId@methodVersion`, the `generalizeToleranceCells`
 * and the `purpose` travel into the export provenance, making each file
 * self-describing, distinct, and reproducible.
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
  /**
   * Generalization tolerance (cells) the export regenerates at when `shapeStyle`
   * is 'generalized' — the per-purpose Douglas–Peucker epsilon as a fraction of
   * the grid cell. 0 for the exact (crisp) purpose. Threaded into
   * `buildResultForExport` so each purpose serialises distinct vertices, and
   * stamped into provenance so each file names the tolerance it used.
   */
  readonly generalizeToleranceCells: number;
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
 * Derive the export intent from a Contour Studio state. The per-purpose
 * generalization tolerance (`surface.generalizeToleranceCells`) is the single
 * predicate: a tolerance of 0 means EXACT geometry → the crisp analytical style;
 * any positive tolerance means the generalized cartographic style AT THAT
 * tolerance. So the geometry, the method stamp and the tolerance all derive from
 * one number and can never disagree — a transformed line is never stamped
 * "exact", and a line stamped "generalized" is genuinely regenerated (never the
 * untransformed on-screen default).
 */
export function contourExportIntentFromState(state: ContourStudioState): ContourExportIntent {
  // Non-positive tolerance ⇒ exact (crisp). Positive ⇒ generalized at `tol`.
  const tol = state.surface.generalizeToleranceCells;
  const exact = !(tol > 0);

  // Exact → 'crisp'. Generalized → 'generalized' at the purpose's tolerance.
  // Deliberately NOT 'smooth': 'smooth' is the panel's on-screen default style,
  // and an intent that resolves to the default style regenerates nothing — the
  // export host reuses the on-screen result and the purpose changes only a
  // provenance string (the v0.5.9 "all purposes export the same file" bug).
  const shapeStyle: ContourShapeStyle = exact ? 'crisp' : 'generalized';

  // Honest method id: the crisp path is the exact analytical geometry; the
  // generalized path is the shipped UNIFORM-tolerance Douglas–Peucker pass, so it
  // is stamped `olv.contour.generalize` — NOT `terrain-adaptive`, which names a
  // module (`contourAdaptiveGeneralize`) that has no production caller. The
  // per-purpose tolerance is carried alongside so the stamp is fully specified.
  const methodId = exact ? 'olv.contour.analytical' : 'olv.contour.generalize';
  const methodVersion = 1;

  return {
    purpose: state.purpose,
    shapeStyle,
    generalizeToleranceCells: exact ? 0 : tol,
    labelsIndexOnly: state.labels.indexOnly,
    methodId,
    methodVersion,
    methodTag: `${methodId}@${methodVersion}`,
  };
}
