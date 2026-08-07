/**
 * src/geo/SpatialContext.ts
 *
 * ONE explicit description of the frame a dataset's coordinates live in, so a
 * consumer that is about to make a metric claim — a distance in metres, an area
 * in m², a volume in m³, a density in pts/m², an elevation against a datum — can
 * read a single object instead of re-deriving unit, datum, axis and frame from
 * `metadata.crs` five different ways. The inventory tracks 13 consumers that
 * each used to reach into a `CrsInfo` / `ResolvedCrs` and re-answer the same
 * questions (see docs/architecture/spatial-context-consumers.md, which
 * `scripts/lint-spatial-context.mjs` holds to the tree); the divergence between
 * those answers is exactly the class of defect the coordinate-integrity roadmap
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
 * WHERE THE CONTEXT IS BUILT. Once, at an application boundary, then passed
 * down: `CrsService.context()` for the active scan, and `spatialContextFrom`
 * over a cloud's own `metadata.crs` where several scans are in play at the same
 * time (epoch comparison). A leaf that calls `spatialContextFrom` while its
 * caller already holds a context has re-opened the divergence this closes, and
 * `scripts/lint-spatial-context.mjs` fails the build when a migrated consumer
 * goes back to deriving unit, datum or axis for itself.
 *
 * `docs/architecture/spatial-context-consumers.md` is the inventory of which
 * consumers read this today and which have not moved yet; that lint keeps the
 * document and the tree in agreement.
 */

import type { CrsInfo, CrsLinearUnit } from '../io/crs';
import type { CrsKind, CrsSource, ResolvedCrs } from './CoordinateTypes';
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
  /**
   * Linear unit TOKEN of the Z axis when the source declared one distinct from
   * the horizontal unit. Only a raw {@link CrsInfo} carries this; a
   * {@link ResolvedCrs} does not model it, so a context built from one reports
   * `undefined` — the honest "not stated here", never the horizontal token
   * standing in for it.
   */
  readonly verticalLinearUnit?: CrsLinearUnit;
  /**
   * Whether the VERTICAL scale is a real measurement: a finite, positive
   * metres-per-vertical-unit factor. The vertical counterpart to
   * {@link linearUnitKnown}, and deliberately independent of it — a consumer
   * must be able to refuse a height claim while still permitting a horizontal
   * one, and vice versa. An absent factor is `false`, never a defaulted 1.
   */
  readonly verticalScaleKnown: boolean;
  /**
   * Whether the vertical REFERENCE SURFACE is known, i.e.
   * `verticalReference !== 'unknown'`. Separate from
   * {@link verticalScaleKnown}: a file can state NAVD88 without stating
   * whether its heights are feet or metres, and can state metres without
   * stating what surface they are measured from. Both must hold before a
   * height is a datum-referenced metre value.
   */
  readonly verticalReferenceKnown: boolean;

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
 * Build a {@link SpatialContext} from either the raw {@link CrsInfo} (the shape
 * `src/io/crs.ts` extracts) or an already-resolved {@link ResolvedCrs} (the shape
 * most consumers hold, e.g. the inspector's coordinate context), plus optional
 * project-frame placement. A `null` / `undefined` CRS fails closed: the context
 * resolves to `unknown`, and `metricClaimsPermitted` is `false`.
 *
 * Accepting both inputs is what lets all 13 consumers route through this one
 * façade without hand-building anything: a `CrsInfo` is bridged through the
 * canonical `resolvedFromCrsInfo` mapper, while a `ResolvedCrs` — which already
 * carries the resolved `kind` (including `local` / `unknown`, which a `CrsInfo`
 * cannot express) — is used directly rather than round-tripped and re-derived.
 *
 * This is a pure fan-out over already-merged predicates — it introduces no new
 * unit, datum, or validity logic of its own.
 */
export function spatialContextFrom(
  crs: CrsInfo | ResolvedCrs | null | undefined,
  frame?: ProjectSpatialFrame,
  placement: SpatialContextPlacement = {},
): SpatialContext {
  // A missing CRS is the explicit unknown case, which the ladder classifies as
  // needs-confirmation. A ResolvedCrs (identified by its `kind` discriminant,
  // which CrsInfo lacks) is already resolved and is used as-is; a CrsInfo is
  // bridged CrsInfo → ResolvedCrs via the canonical mapper.
  let resolved: ResolvedCrs;
  if (crs == null) {
    resolved = unknownCrs();
  } else if ('kind' in crs) {
    resolved = crs;
  } else {
    resolved = resolvedFromCrsInfo(crs, FACADE_SOURCE) ?? unknownCrs();
  }

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

  // The vertical unit TOKEN exists only on the raw CrsInfo shape. Reading it
  // off a ResolvedCrs would need a field that type does not have, so the
  // discriminant that told the two apart above tells them apart here too, and
  // a ResolvedCrs-built context reports `undefined` rather than borrowing the
  // horizontal token.
  const verticalLinearUnit =
    crs != null && !('kind' in crs) ? crs.verticalLinearUnit : undefined;
  const verticalScale = crs?.verticalUnitToMetres;
  const verticalScaleKnown =
    verticalScale !== undefined && Number.isFinite(verticalScale) && verticalScale > 0;

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
    verticalLinearUnit,
    verticalScaleKnown,
    verticalReferenceKnown: verticalReference !== 'unknown',

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

// ─────────────────────────────────────────────────────────────────────────────
// Vertical scale — the three policies, named once
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a consumer treats a MISSING vertical unit. The three answers already
 * exist in the tree, hand-written as `??` chains that look alike and are not,
 * which is how two surfaces end up reporting the same height differently.
 *
 * `'none'` — no fallback. The vertical scale is whatever the source declared
 *     for the Z axis, or nothing. The strictest, and correct wherever the
 *     output states a metre value for a height (RFC 7946 ordinates, KML
 *     absolute altitude): a horizontal unit is not evidence about Z.
 *
 * `'horizontal-when-known'` — fall back to the horizontal factor only when
 *     that factor is itself a real declared unit. The fail-closed form of the
 *     GeoTIFF convention, and correct for a LABEL that names the unit.
 *
 * `'horizontal'` — fall back to the horizontal factor unconditionally, which
 *     for an unknown CRS is the inert placeholder 1. The GeoTIFF convention as
 *     written, and correct only where a factor is needed to keep a GEOMETRY
 *     self-consistent (grid spacing, cell floors) rather than to make a claim.
 */
export type VerticalScaleFallback = 'none' | 'horizontal-when-known' | 'horizontal';

/**
 * Metres per unit of the Z axis under an explicitly chosen fallback policy.
 * `undefined` means the vertical scale is genuinely unknown, and a caller that
 * receives it must withhold the metre value rather than treat the magnitude as
 * metres (the same contract as `heightInMetres`).
 *
 * Every consumer that used to write its own `verticalUnitToMetres ?? …` chain
 * reads this instead, so the policy it applies is stated in the call rather
 * than inferred from the shape of an expression.
 */
export function verticalMetresPerUnit(
  ctx: SpatialContext,
  fallback: VerticalScaleFallback,
): number | undefined {
  // A DECLARED vertical unit ends the question either way. When it is
  // degenerate (zero, negative, non-finite) the source is corrupt, and
  // borrowing the horizontal factor would answer a question the file already
  // answered wrongly — so that case fails closed rather than falling through.
  if (ctx.verticalUnitToMetres !== undefined) {
    return ctx.verticalScaleKnown ? ctx.verticalUnitToMetres : undefined;
  }
  if (fallback === 'none') return undefined;
  if (fallback === 'horizontal-when-known' && !ctx.linearUnitKnown) return undefined;
  const h = ctx.linearUnitToMetres;
  return Number.isFinite(h) && h > 0 ? h : undefined;
}
