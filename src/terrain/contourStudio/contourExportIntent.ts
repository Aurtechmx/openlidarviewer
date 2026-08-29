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
 *     simplify + smooth — never the panel's on-screen default style), each at its
 *     OWN per-purpose tolerance (`generalizeToleranceCells`). The stamp names the
 *     transformation the pipeline actually runs: `olv.contour.generalize@1` for
 *     the uniform Douglas–Peucker tolerance, or `olv.contour.generalize.terrain-adaptive@1`
 *     when the surface's `generalizeMode` is 'terrain-aware' — the honesty-gated
 *     styler then scales that tolerance DOWN per feature (never up), which is a
 *     real production path, so the stamp is honest either way.
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
import type { ContourGeneralizeMode } from '../contour/terrainAwareTolerance';
import { PURPOSE_META } from './contourStudioPurpose';
import { methodRef, methodTag } from '../../science/methodRegistry';

/**
 * The purpose-driven product facts a deliverable renders on its sheet, so a
 * map-sheet PDF (or any deliverable) can DOCUMENT the settings the chosen purpose
 * applied — the geometry claim, generalization, labels, appearance and packaging.
 * These are PRESENTATION/product defaults only: none of them raises an evidence
 * level, hides a warning, or bypasses a gate.
 */
export interface ContourDeliverableFacts {
  /** Human label of the purpose ("Engineering Plan"). */
  readonly label: string;
  /** One-line purpose statement (from PURPOSE_META.summary). */
  readonly statement: string;
  /** Exact analytical isolines are emitted. */
  readonly analytical: boolean;
  /** Generalized cartographic contours are emitted. */
  readonly cartographic: boolean;
  /** Cartographic smoothing is applied. */
  readonly cartographicSmoothing: boolean;
  /** Generalization tolerance (cells): ε = tolerance × cell. 0 = exact. */
  readonly generalizeToleranceCells: number;
  /** Every Nth contour is an index (bold) line. */
  readonly indexEvery: number;
  /** Only index contours are labelled. */
  readonly labelsIndexOnly: boolean;
  /** Hillshade appearance requested (raster documented, see mapSheetPdf). */
  readonly hillshade: boolean;
  /** Hypsometric tint requested (raster documented, see mapSheetPdf). */
  readonly hypsometricTint: boolean;
  /** Exploratory (watermarked) output may be produced for this purpose. */
  readonly allowExploratory: boolean;
  /** The complete deliverable package is part of this purpose. */
  readonly completePackage: boolean;
  /** The purpose demands the internal-validation appendix. */
  readonly appendixRequired: boolean;
}

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
  /**
   * How the 'generalized' style distributes its tolerance across features. The
   * export host passes it to `applyContourShapeStyle`, and it selects the method
   * stamp. 'uniform' on the exact (crisp) path, since it generalizes nothing.
   */
  readonly generalizeMode: ContourGeneralizeMode;
  /** Whether only index (bold) contours are labelled. */
  readonly labelsIndexOnly: boolean;
  /** Stable method id of the geometry actually exported. */
  readonly methodId: string;
  /** Method version paired with `methodId`. */
  readonly methodVersion: number;
  /** Human tag "id@version" for provenance and diagnostics. */
  readonly methodTag: string;
  /**
   * The purpose-driven product facts (label, statement, and the deliverable
   * config). A deliverable renderer uses these to DOCUMENT what the chosen
   * purpose applied — never to change any evidence/gate decision.
   */
  readonly deliverable: ContourDeliverableFacts;
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

  // The exact path generalizes nothing, so it always reports 'uniform'; only the
  // generalized path honours the surface's chosen mode.
  const generalizeMode: ContourGeneralizeMode = exact ? 'uniform' : state.surface.generalizeMode;

  // Honest method id: the crisp path is the exact analytical geometry; the
  // generalized path is the uniform-tolerance Douglas–Peucker pass, stamped
  // `olv.contour.generalize` — unless the surface selected terrain-aware, in
  // which case the honesty-gated styler scales that tolerance per feature and the
  // pass that actually runs is stamped `olv.contour.generalize.terrain-adaptive`.
  const methodId = exact
    ? 'olv.contour.analytical'
    : generalizeMode === 'terrain-aware'
      ? 'olv.contour.generalize.terrain-adaptive'
      : 'olv.contour.generalize';
  // Version and tag come from the registry, fail-closed: methodRef throws on an
  // unregistered id, so a stamped export can never name a method the catalogue
  // does not define, and a method-version bump flows through here on its own
  // instead of being hand-kept at 1.
  const ref = methodRef(methodId);
  const methodVersion = ref.version;

  const meta = PURPOSE_META[state.purpose];
  return {
    purpose: state.purpose,
    shapeStyle,
    generalizeToleranceCells: exact ? 0 : tol,
    generalizeMode,
    labelsIndexOnly: state.labels.indexOnly,
    methodId,
    methodVersion,
    methodTag: methodTag(ref),
    deliverable: {
      label: meta.label,
      statement: meta.summary,
      analytical: state.contour.analytical,
      cartographic: state.contour.cartographic,
      cartographicSmoothing: state.surface.cartographicSmoothing,
      // Report the tolerance actually in effect for the exported geometry: 0 on
      // the exact path, else the state's per-purpose tolerance.
      generalizeToleranceCells: exact ? 0 : tol,
      indexEvery: state.contour.indexEvery,
      labelsIndexOnly: state.labels.indexOnly,
      hillshade: state.appearance.hillshade,
      hypsometricTint: state.appearance.hypsometricTint,
      allowExploratory: state.deliverable.allowExploratory,
      completePackage: state.deliverable.completePackage,
      appendixRequired: state.validation.appendixRequired,
    },
  };
}
