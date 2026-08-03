/**
 * src/geo/SpatialContext.ts
 *
 * ONE explicit description of the frame a dataset's coordinates live in, so a
 * consumer that is about to make a metric claim — a distance in metres, an area
 * in m², a volume in m³, a density in pts/m², an elevation against a datum — can
 * read a single object instead of re-deriving unit, datum, axis and frame from
 * `metadata.crs` five different ways. Today ~13 consumers each reach into a
 * `CrsInfo` / `ResolvedCrs` and re-answer the same questions (see
 * docs/architecture/spatial-context-consumers.md); the divergence between those
 * answers is exactly the class of defect the coordinate-integrity roadmap
 * tracks — plausible output on the wrong unit or axis.
 *
 * This module is a FAÇADE, not a replacement. It builds nothing new: it reuses
 * the pieces already merged and fans them into one shape —
 *
 *   • horizontal identity + linear unit  ← `resolvedFromCrsInfo` (CoordinateTypes)
 *   • the linear-unit-known gate          ← `isLinearUnitKnown`   (CoordinateTypes)
 *   • the metric-confidence ladder        ← `validateCrsForMeasurement` (CrsValidation)
 *   • the vertical reference class        ← `verticalReferenceFromDatum` (height.ts)
 *   • project-frame placement + transform ← `ProjectSpatialFrame` / `LayerSpatialTransform`
 *
 * The single boolean the whole fail-closed program turns on is
 * {@link SpatialContext.metricClaimsPermitted}: it is the AND of the
 * linear-unit-known gate and the ladder's `canDisplayMetric`, so an unknown or
 * degenerate unit and a geographic / unresolved CRS both fail closed through
 * one field rather than through thirteen independent checks that can drift.
 *
 * Pure — no DOM, no three.js, no proj4. Runs unchanged in Node tests.
 *
 * NOTE (scope): this PR adds the model, its cross-product matrix test, and the
 * consumer inventory ONLY. No consumer is routed through it here; that is the
 * atomic follow-up. Nothing imports this module yet by design.
 */

import type { CrsInfo, CrsLinearUnit } from '../io/crs';
import type { CrsKind, CrsSource } from './CoordinateTypes';
import { isLinearUnitKnown, resolvedFromCrsInfo, unknownCrs } from './CoordinateTypes';
import type { CrsValidity, CrsValiditySeverity } from './CrsValidation';
import { validateCrsForMeasurement } from './CrsValidation';
import type { VerticalReference } from './height';
import { verticalReferenceFromDatum } from './height';
import type { LayerSpatialTransform, ProjectSpatialFrame } from './ProjectSpatialFrame';

// ─────────────────────────────────────────────────────────────────────────────
// Up axis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which storage axis is elevation. `'z'` and `'y'` match the convention the rest
 * of the app already uses (`io/session.ts`, `terrainAnalysisRunner`, `Viewer`),
 * and `'unknown'` is the honest state when no axis was detected — never silently
 * defaulted to a guess, per roadmap P0 #4. A consumer that needs a real axis
 * treats `'unknown'` the way it treats an unknown unit: refuse or prompt.
 */
export type SpatialUpAxis = 'z' | 'y' | 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// The model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything a consumer needs to decide whether a metric claim is permitted,
 * carried in one place. Assemble one with {@link spatialContextFrom} — consumers
 * must never hand-build this, for the same reason they never hand-build a
 * `ResolvedCrs`: the rules for combining unit, datum, axis and frame belong in a
 * single constructor so they cannot diverge.
 */
export interface SpatialContext {
  // ── Horizontal CRS identity ──────────────────────────────────────────────
  /** Human-readable CRS label (EPSG-derived name, WKT name, or `EPSG:<code>`). */
  readonly crsName: string;
  /** EPSG code when known; absent for local / unknown / WKT-without-authority. */
  readonly epsg?: number;
  /** Coarse CRS shape — `projected` / `geographic` / `local` / `unknown`. */
  readonly kind: CrsKind;
  /** Convenience mirror of `kind === 'geographic'` (lat/lon in degrees). */
  readonly isGeographic: boolean;

  // ── Horizontal linear unit ───────────────────────────────────────────────
  /** Linear unit of the X/Y axes. `'unknown'` fails the metric gate. */
  readonly linearUnit: CrsLinearUnit;
  /** Linear-unit → metres factor. `1` here is a placeholder when the unit is unknown. */
  readonly linearUnitToMetres: number;
  /** The canonical fail-closed predicate: is the linear unit a REAL unit? */
  readonly linearUnitKnown: boolean;

  // ── Vertical unit + datum / reference ────────────────────────────────────
  /** Reference surface a height is measured from (reused from `height.ts`). */
  readonly verticalReference: VerticalReference;
  /** Vertical-datum label (name or `EPSG:<code>`); absent ⇒ datum unknown. */
  readonly verticalDatum?: string;
  /** Vertical-datum EPSG when declared. */
  readonly verticalEpsg?: number;
  /**
   * Vertical-unit → metres factor when the source declared a distinct vertical
   * unit. `undefined` is the HONEST "vertical scale unknown" — never read as
   * metres (a height built from it has no metres value, per `heightInMetres`).
   */
  readonly verticalUnitToMetres?: number;

  // ── Up axis / basis ──────────────────────────────────────────────────────
  /** Which storage axis is elevation; `'unknown'` when undetected. */
  readonly upAxis: SpatialUpAxis;

  // ── Project-frame membership + source→project transform (Float64) ────────
  /** Whether this layer is placed in a shared multi-scan project frame. */
  readonly inProjectFrame: boolean;
  /** The shared project frame, when a member. */
  readonly projectFrame?: ProjectSpatialFrame;
  /** This layer's source-local → project-local transform (Float64), when placed. */
  readonly layerTransform?: LayerSpatialTransform;
  /** Convenience mirror of `layerTransform.sourceToProject` (Float64), when placed. */
  readonly sourceToProject?: readonly [number, number, number];

  // ── Known / unknown status (the CrsValidation ladder verdict) ────────────
  /** The metric-safety ladder verdict for this CRS. */
  readonly metricValidity: CrsValidity;
  /** UI severity of that verdict — `'ok'` is silent, else a badge. */
  readonly metricSeverity: CrsValiditySeverity;

  // ── THE fail-closed gate ─────────────────────────────────────────────────
  /**
   * The single boolean the fail-closed program turns on. `true` only when the
   * linear unit is known AND the ladder permits a metric headline — so a metre /
   * foot / US-survey-foot projected CRS passes, and an unknown-unit CRS, a
   * geographic (degrees) CRS, an unresolved CRS, or a non-finite unit all fail
   * closed. Governs planimetric claims (distance, area, volume, density);
   * vertical claims are gated separately via {@link verticalReference} +
   * {@link verticalUnitToMetres} (an unknown datum does not, by itself, block a
   * horizontal area or point count on a known-unit grid).
   */
  readonly metricClaimsPermitted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructor (the façade)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provenance passed to `resolvedFromCrsInfo`. The ladder verdict and the
 * linear-unit gate are BOTH independent of provenance (they read only `kind`,
 * `linearUnit`, and `linearUnitToMetres`), and this context does not surface the
 * source, so a neutral value is honest here — the façade makes no provenance
 * claim of its own.
 */
const FACADE_SOURCE: CrsSource = 'las-vlr';

/** Optional per-layer placement for {@link spatialContextFrom}. */
export interface SpatialContextPlacement {
  /** Detected up-axis; omit ⇒ `'unknown'` (never guessed to a default). */
  readonly upAxis?: SpatialUpAxis;
  /** This layer's transform into `frame`, from `ProjectSpatialFrame.layerTransform`. */
  readonly layerTransform?: LayerSpatialTransform;
}

/**
 * Build a {@link SpatialContext} from the existing {@link CrsInfo} (the shape
 * `src/io/crs.ts` extracts) plus optional project-frame placement. A `null` /
 * `undefined` CRS fails closed: the context resolves to `unknown`, and
 * `metricClaimsPermitted` is `false`.
 *
 * This is a pure fan-out over already-merged predicates — it introduces no new
 * unit, datum, or validity logic of its own.
 */
export function spatialContextFrom(
  crs: CrsInfo | null | undefined,
  frame?: ProjectSpatialFrame,
  placement: SpatialContextPlacement = {},
): SpatialContext {
  // Bridge CrsInfo → ResolvedCrs via the canonical mapper; a missing CRS is the
  // explicit unknown case, which the ladder classifies as needs-confirmation.
  const resolved = crs ? (resolvedFromCrsInfo(crs, FACADE_SOURCE) ?? unknownCrs()) : unknownCrs();

  const verdict = validateCrsForMeasurement(resolved);
  const linearUnitKnown = isLinearUnitKnown(resolved);

  // THE gate: unit must be real AND the ladder must permit a metric headline.
  // The two catch different failures — the ladder alone passes a projected CRS
  // whose unit is 'unknown' (British foot, say: kind is still 'projected'), and
  // only `isLinearUnitKnown` refuses it; the unit gate alone would pass a
  // geographic CRS if its factor were finite, and only the ladder refuses that.
  const metricClaimsPermitted = linearUnitKnown && verdict.canDisplayMetric;

  const verticalReference = verticalReferenceFromDatum({
    verticalEpsg: crs?.verticalEpsg,
    verticalDatum: crs?.verticalDatum,
  });

  const layerTransform = placement.layerTransform;

  return {
    crsName: resolved.name,
    epsg: resolved.epsg,
    kind: resolved.kind,
    isGeographic: resolved.kind === 'geographic',

    linearUnit: resolved.linearUnit,
    linearUnitToMetres: resolved.linearUnitToMetres,
    linearUnitKnown,

    verticalReference,
    verticalDatum: crs?.verticalDatum,
    verticalEpsg: crs?.verticalEpsg,
    verticalUnitToMetres: crs?.verticalUnitToMetres,

    upAxis: placement.upAxis ?? 'unknown',

    inProjectFrame: frame != null,
    projectFrame: frame,
    layerTransform,
    sourceToProject: layerTransform?.sourceToProject,

    metricValidity: verdict.validity,
    metricSeverity: verdict.severity,

    metricClaimsPermitted,
  };
}
