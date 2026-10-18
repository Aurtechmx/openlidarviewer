/**
 * src/geo/SpatialContext.ts
 *
 * ONE explicit description of the frame a dataset's coordinates live in, so a
 * consumer that is about to make a metric claim — a distance in metres, an area
 * in m², a volume in m³, a density in pts/m², an elevation against a datum — can
 * read a single object instead of re-deriving unit, datum, axis and frame from
 * `metadata.crs` five different ways. The inventory tracks 19 consumers; 18 of
 * them used to reach into a `CrsInfo` / `ResolvedCrs` and re-answer the same
 * questions, and the reference plane read the context from the start (see docs/architecture/spatial-context-consumers.md, which
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
import { GEOCENTRIC_REASON, WEB_MERCATOR_REASON, refusesHorizontalGround, validateCrsForMeasurement } from './CrsValidation';
import type { VerticalReference } from './height';
import { HEIGHT_UNIT_GAP_SUFFIX, verticalReferenceFromDatum } from './height';
import type { LayerSpatialTransform, ProjectSpatialFrame } from './ProjectSpatialFrame';
import { UNIT_FACTORS } from '../units/units';

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

/** Whether a vertical unit was declared and can be read; see `SpatialContext.verticalScaleState`. */
export type VerticalScaleState = 'valid' | 'absent' | 'invalid';

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
   * Linear unit TOKEN of the Z axis when the source declared a vertical unit.
   * Read from either input shape; when only a factor survives, the token is
   * the unit that factor is exactly (`'unknown'` for any other factor).
   * `undefined` means no vertical unit was declared — never the horizontal
   * token standing in for it.
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
   * The vertical scale's validity, three ways: `'valid'` (a finite, positive
   * declared factor, {@link verticalScaleKnown}), `'absent'` (no vertical unit
   * declared; a consumer may borrow the horizontal unit under its stated
   * policy) and `'invalid'` (a vertical unit was declared and cannot be read:
   * an angular unit, a zero, negative or non-finite factor). An invalid scale
   * never borrows the horizontal unit: every height and every figure built on
   * one is withheld. Carried separately from any factor used only to draw.
   */
  readonly verticalScaleState: VerticalScaleState;
  /**
   * Whether the vertical REFERENCE SURFACE is known, i.e.
   * `verticalReference !== 'unknown'`. Separate from
   * {@link verticalScaleKnown}: a file can state NAVD88 without stating
   * whether its heights are feet or metres, and can state metres without
   * stating what surface they are measured from. Both must hold before a
   * height is a datum-referenced metre value.
   */
  readonly verticalReferenceKnown: boolean;
  /**
   * Whether the vertical axis points DOWN (a depth-positive-down reference):
   * a known depth code (NAVD88 depth, MSL depth, …) or a WKT vertical AXIS
   * declared DOWN. Elevation workflows treat Z as positive-up height, so they
   * refuse a frame where this holds (see {@link elevationWorkflowRefusal}).
   */
  readonly verticalAxisDown: boolean;
  /**
   * Whether horizontal ground metrics (lengths, areas, grades, volumes) are
   * refused while heights stay available: a geographic (degree) CRS, a Web
   * Mercator grid, or a geocentric frame. The Measure tool's horizontal
   * refusal reads this one flag.
   */
  readonly horizontalMetricRefused: boolean;
  /**
   * Whether VERTICAL metrics (a height, and the grades, profiles and volumes
   * that read Z as positive-up elevation) are refused because the frame has no
   * valid local vertical: a geocentric frame (its Z axis points at the North
   * Pole, not up at the site) or a depth-positive-down reference (every rise
   * reads as a fall). Independent of {@link horizontalMetricRefused}: a
   * geographic or Web Mercator frame refuses lengths yet keeps a height. The
   * live Measure tool and every measurement export read this one flag.
   */
  readonly verticalMetricRefused: boolean;

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
 * Accepting both inputs is what lets all 19 consumers route through this one
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

  // The vertical unit TOKEN, from either shape. A source that kept only the
  // factor gets the unit that factor exactly is, never the horizontal token.
  const verticalScale = crs?.verticalUnitToMetres;
  const verticalScaleKnown =
    verticalScale !== undefined && Number.isFinite(verticalScale) && verticalScale > 0;
  const verticalLinearUnit =
    crs?.verticalLinearUnit ?? (verticalScale !== undefined ? linearUnitForFactor(verticalScale) : undefined);
  // A declared factor that is not a length, or a token of 'unknown' with no
  // factor (a saved session drops a non-finite factor), is invalid, not absent.
  const verticalScaleState: VerticalScaleState = verticalScaleKnown
    ? 'valid'
    : verticalScale !== undefined || verticalLinearUnit === 'unknown' ? 'invalid' : 'absent';

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
    verticalScaleState,
    verticalReferenceKnown: verticalReference !== 'unknown',
    verticalAxisDown: verticalReference === 'depth' || crs?.verticalAxisDown === true,
    horizontalMetricRefused: resolved.kind === 'geographic' || refusesHorizontalGround(verdict.validity),
    verticalMetricRefused: resolved.kind === 'geocentric' || verticalReference === 'depth' || crs?.verticalAxisDown === true,

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

/**
 * The named linear unit whose metres-per-unit is exactly `factor`, or
 * `'unknown'` for any other value (including a non-finite one).
 */
export function linearUnitForFactor(factor: number): CrsLinearUnit {
  if (factor === 1) return 'metre';
  if (Math.abs(factor - UNIT_FACTORS.M_PER_FT) < 1e-12) return 'foot';
  if (Math.abs(factor - UNIT_FACTORS.M_PER_US_FT) < 1e-12) return 'us-survey-foot';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Elevation workflows — the shared frame refusal
// ─────────────────────────────────────────────────────────────────────────────

/** Refusal for a depth-positive-down vertical reference. */
export const DEPTH_AXIS_REFUSAL =
  'Depth-positive-down vertical reference; elevation workflows refuse it until normalisation is supported.';

/**
 * Why horizontal ground metrics (extents in metres, densities in pts/m²) are
 * refused on a frame that names a metre unit, or `null`: a geocentric frame
 * has no ground plane, and a Web Mercator grid's metres grow with latitude.
 * A geographic frame is refused by its unknown linear unit instead.
 */
export function horizontalGroundRefusal(ctx: SpatialContext): string | null {
  if (ctx.kind === 'geocentric') return GEOCENTRIC_REASON;
  if (ctx.metricValidity === 'grid-only') return WEB_MERCATOR_REASON;
  return null;
}

/**
 * Whether horizontal spans may be printed as ground metres and densities as
 * pts/m²: the linear unit is real AND the frame is a ground plane. A Web
 * Mercator grid or a geocentric frame declares metres yet fails the second
 * half (its reason is {@link horizontalGroundRefusal}). Keys off
 * `linearUnitKnown`, not `metricClaimsPermitted`, so the extent reports keep
 * their documented behaviour on every other frame.
 */
export function groundMetresPermitted(ctx: SpatialContext): boolean {
  return ctx.linearUnitKnown && !ctx.horizontalMetricRefused;
}

/**
 * Whether a height span may be converted with the frame's units: the linear
 * unit is real and the frame has a local vertical. A Web Mercator grid keeps
 * its heights; a geocentric frame's Z span is not a height.
 */
export function heightUnitsPermitted(ctx: SpatialContext): boolean {
  return ctx.linearUnitKnown && !ctx.verticalMetricRefused;
}

/**
 * Why an elevation workflow (terrain analysis, contours, DEM export, flow,
 * access, epoch comparison) must refuse this frame, or `null` when it may run.
 *
 * Those workflows read Z as a positive-up height on a ground plane. A depth
 * axis inverts every rise into a fall (a surface going from 10 m to 9 m depth
 * rose by 1 m, and was reported as a 1 m loss); a geocentric frame has no
 * ground plane and no elevation axis; a Web Mercator grid has no ground-metre
 * scale for slopes, areas and volumes. Each is refused rather than computed.
 */
export function elevationWorkflowRefusal(ctx: SpatialContext): string | null {
  if (ctx.kind === 'geocentric') return GEOCENTRIC_REASON;
  if (ctx.verticalAxisDown) return DEPTH_AXIS_REFUSAL;
  if (ctx.metricValidity === 'grid-only') return WEB_MERCATOR_REASON;
  return null;
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
  if (ctx.verticalUnitToMetres !== undefined || ctx.verticalScaleState === 'invalid') {
    return ctx.verticalScaleKnown ? ctx.verticalUnitToMetres : undefined;
  }
  if (fallback === 'none') return undefined;
  if (fallback === 'horizontal-when-known' && !ctx.linearUnitKnown) return undefined;
  const h = ctx.linearUnitToMetres;
  return Number.isFinite(h) && h > 0 ? h : undefined;
}

/**
 * Why a volume cannot be stated in metres in this frame, or null when it can.
 * The CRS verdict's reason first (a geographic or unknown frame); then a
 * vertical unit the source declares but that cannot be read, which no
 * horizontal factor may stand in for.
 */
export function volumeClaimRefusal(ctx: SpatialContext, verdict: { readonly canDisplayMetric: boolean; readonly reason: string; readonly suggestion: string }): string | null {
  if (!verdict.canDisplayMetric) return `${verdict.reason} ${verdict.suggestion}`;
  if (ctx.verticalScaleState === 'invalid') return 'Height unit could not be interpreted; metric height unavailable, so no volume is stated. Correct the vertical unit of the source CRS.';
  return null;
}

/**
 * The unit caveat a volume readout carries. A volume multiplies two horizontal
 * factors by a vertical one; when the file declares no vertical unit the
 * vertical factor is borrowed from the horizontal unit, and the readout says
 * so. `validity` is the CRS verdict's validity, where `safe-explicit-local`
 * means the units themselves are assumed metres.
 */
export function volumeUnitCaveat(ctx: SpatialContext, validity: string): string {
  if (validity === 'safe-explicit-local') return ' · units assumed metres';
  return ctx.verticalUnitToMetres === undefined && ctx.verticalScaleState !== 'invalid' ? ' · heights assumed in the horizontal unit (vertical unit not declared)' : '';
}

/**
 * How an extent report converts and labels a height. Metres only when the
 * horizontal unit is known and a valid vertical unit is declared; a declared
 * but degenerate vertical unit (zero, negative, non-finite) and an undeclared
 * one each keep the height in source units with their own label. The static
 * scan report and the streamed extent rows both read this, so they agree.
 */
export function heightScale(ctx: SpatialContext, horizontalKnown: boolean): { readonly factor: number; readonly suffix: string } {
  if (!horizontalKnown) return { factor: 1, suffix: ' (source units)' };
  const v = verticalMetresPerUnit(ctx, 'none');
  if (v !== undefined) return { factor: v, suffix: ' m' };
  return ctx.verticalUnitToMetres === undefined
    ? { factor: 1, suffix: HEIGHT_UNIT_GAP_SUFFIX['vertical-unit-not-declared'] }
    : { factor: 1, suffix: HEIGHT_UNIT_GAP_SUFFIX['vertical-unit-invalid'] };
}

