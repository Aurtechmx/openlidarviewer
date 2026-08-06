/**
 * contourFeatureModel.ts
 *
 * Shared intermediate representation. Every exporter (GeoJSON,
 * SVG, DXF, and the PDF block) consumes THIS, so the format-specific
 * writers stay thin serializers with one source of truth for geometry,
 * elevation, evidence grade, and georeferencing.
 *
 * The honest move that distinguishes these exports: each polyline is
 * split into maximal runs of a single evidence grade (by SEGMENT grade =
 * the weaker of its two endpoints), so a downstream GIS sees exactly
 * which spans are confident (solid), interpolated (dashed), or
 * unsupported (gap) — instead of one authoritative line over mixed
 * evidence. Nothing is silently dropped; gap runs are emitted and
 * labelled so the recipient decides.
 *
 * CRS is mandatory for a usable export: when it is unknown the model
 * still builds but carries a prominent warning, and writers surface it.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { gradeForConfidence, type EvidenceGrade } from '../ground/cellConfidence';
import type { TerrainCoverageMode } from '../TerrainContracts';
import type { ContourPolyline, StitchedLevel } from './stitchContours';
import type { StyledLevel } from './contourStyle';
import { defaultContourShapeStyle, type ContourShapeStyle } from './contourShapeStyle';
// The vertical-reference classifier the SpatialContext façade wraps. Called
// ONCE here, so the model carries the answer and no writer re-derives it.
import { verticalReferenceFromDatum, type VerticalReference } from '../../geo/height';

/** One exportable contour feature: a single-grade run at one elevation. */
export interface ContourFeature {
  readonly value: number;
  readonly isIndex: boolean;
  readonly grade: EvidenceGrade;
  /** Mean confidence (0..100) of the run's vertices. */
  readonly meanConfidence: number;
  /** True only when this feature is a complete closed ring. */
  readonly closed: boolean;
  /** Vertices as [x, y] in CRS coordinates (elevation is `value`). */
  readonly coordinates: Array<[number, number]>;
}

/** Bounding box of all feature coordinates. */
export interface ContourBBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Per-contour evidence vocabulary surfaced in exports. Each single-grade
 * run maps cleanly: a confident (solid) run is backed by measured ground,
 * a dashed run by interpolation, and a gap run is too low-confidence to
 * trust. (`mixed` / `edgeClipped` are reserved for richer models; the
 * single-grade-run model emits only these three so the label never
 * overstates what one feature actually contains.)
 */
export type ContourEvidence =
  | 'measuredBacked'
  | 'interpolatedBacked'
  | 'lowConfidence';

/** Map an evidence grade to the exported contour-evidence vocabulary. */
export function contourEvidence(grade: EvidenceGrade): ContourEvidence {
  if (grade === 'solid') return 'measuredBacked';
  if (grade === 'dashed') return 'interpolatedBacked';
  return 'lowConfidence';
}

/** The full export model. */
export interface ContourFeatureModel {
  readonly features: ContourFeature[];
  readonly crs: string | null;
  readonly verticalDatum: string | null;
  /**
   * Metres per unit of the SOURCE vertical axis. Feature `value`s are in that
   * axis's own units, never metres, so a writer that wants to name the unit
   * reads this instead of assuming — the RFC 7946 writer stamped a constant
   * 'metre' and shipped US-survey-foot elevations under it. Null/absent means
   * the factor was never resolved, and the honest label is then "unknown",
   * not "metre".
   */
  readonly verticalUnitToMetres?: number | null;
  /**
   * The vertical REFERENCE SURFACE the elevations sit on, classified once when
   * the model is built and read by every writer.
   *
   * This is the field that removes the export layer's duplicate datum
   * allow-lists. The RFC 7946 GeoJSON writer used to keep its own two-entry
   * list of "is this WGS 84 ellipsoidal height", the KML writer its own set of
   * metric orthometric codes, and the measure tool a third call to the
   * classifier — three answers to one question about one scan. The model now
   * carries the answer the {@link SpatialContext} would give (`verticalReference`
   * is exactly `verticalReferenceFromDatum` over the declared datum), so a
   * writer reads it instead of deciding for itself. Read it through
   * {@link modelVerticalReference}, which also classifies a model assembled by
   * hand (older callers, fixtures) rather than through {@link buildFeatureModel}.
   */
  readonly verticalReference?: VerticalReference;
  /**
   * Spacing of the levels this model's features were built from — the emitted
   * interval, not necessarily the one that was asked for (see
   * {@link requestedIntervalM}).
   */
  readonly intervalM: number;
  /** The interval originally requested, when it differs from what was emitted. */
  readonly requestedIntervalM?: number | null;
  /** The contour shape style this model's geometry was produced with. */
  readonly contourStyle: ContourShapeStyle;
  readonly bbox: ContourBBox | null;
  /** Length-weighted fraction of contour that is dashed or gap. */
  readonly interpolatedFraction: number;
  /** Coverage provenance the contours inherit from the DTM. */
  readonly coverageMode: TerrainCoverageMode;
  readonly warnings: string[];
}

/**
 * The world-frame origin the loader subtracted from the cloud on load
 * (Float32 recentring). The terrain pipeline — and therefore this model —
 * runs in that LOCAL frame; adding the origin back converts coordinates to
 * the real CRS frame the model's `crs` field names. `z` shifts contour
 * elevation values too; callers that only track a horizontal origin may
 * omit it (elevations then stay in the local vertical frame).
 */
export interface ContourWorldOrigin {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

/**
 * Return a copy of the model with every coordinate (and elevation value)
 * shifted from the local (recentred) frame into the world frame. This is
 * the same registration step the DEM package applies via `xll = ox +
 * dtm.originH1` — without it an export carries small local coordinates
 * stamped with a real EPSG code, which a GIS then places at the CRS
 * origin (v0.4.3 bug). A zero origin returns the model unchanged.
 */
export function shiftFeatureModelToWorld(
  model: ContourFeatureModel,
  origin: ContourWorldOrigin,
): ContourFeatureModel {
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z ?? 0;
  if (ox === 0 && oy === 0 && oz === 0) return model;
  const features = model.features.map((f) => ({
    ...f,
    value: f.value + oz,
    coordinates: f.coordinates.map(([x, y]) => [x + ox, y + oy] as [number, number]),
  }));
  const bbox: ContourBBox | null = model.bbox
    ? {
        minX: model.bbox.minX + ox,
        minY: model.bbox.minY + oy,
        maxX: model.bbox.maxX + ox,
        maxY: model.bbox.maxY + oy,
      }
    : null;
  return { ...model, features, bbox };
}

/**
 * The vertical reference surface a model's elevations sit on — the ONE answer
 * every writer reads.
 *
 * A model built by {@link buildFeatureModel} already carries it; one assembled
 * by hand is classified here, with the same `verticalReferenceFromDatum` the
 * {@link SpatialContext} façade uses. There is exactly one classifier either
 * way, so no writer can reach a different verdict about the same datum.
 */
export function modelVerticalReference(model: ContourFeatureModel): VerticalReference {
  return (
    model.verticalReference
    ?? verticalReferenceFromDatum({ verticalDatum: model.verticalDatum ?? undefined })
  );
}

/** Options for {@link buildFeatureModel}. */
export interface FeatureModelParams {
  readonly crs: string | null;
  readonly verticalDatum?: string | null;
  /** Metres per unit of the source vertical axis; null when unresolved. */
  readonly verticalUnitToMetres?: number | null;
  /**
   * The vertical reference surface, when the caller already holds a
   * {@link SpatialContext} and can hand its `verticalReference` straight over.
   * Omitted, the model classifies the declared datum itself with the same
   * function the context uses, so the two can never disagree.
   */
  readonly verticalReference?: VerticalReference;
  readonly intervalM: number;
  /** The interval originally requested, before any level thinning. */
  readonly requestedIntervalM?: number | null;
  /** Coverage provenance from the analysis (default 'full'). */
  readonly coverageMode?: TerrainCoverageMode;
  /** Shape style the geometry was produced with (default 'smooth'). */
  readonly contourStyle?: ContourShapeStyle;
}

function segLen(a: [number, number], b: [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Split one polyline into single-grade run features. */
function splitPolyline(poly: ContourPolyline, isIndex: boolean): ContourFeature[] {
  const vs = poly.vertices;
  if (vs.length < 2) return [];
  // For a closed ring, append the first vertex so the closing segment
  // participates in run-splitting.
  const path = poly.closed ? [...vs, vs[0]] : vs;
  const segGrade = (i: number): EvidenceGrade =>
    gradeForConfidence(Math.min(path[i].confidence, path[i + 1].confidence));

  const out: ContourFeature[] = [];
  const emit = (startV: number, endV: number, grade: EvidenceGrade, closed: boolean) => {
    const slice = path.slice(startV, endV + 1);
    if (slice.length < 2) return;
    let confSum = 0;
    const coords: Array<[number, number]> = [];
    for (const v of slice) {
      coords.push([v.x, v.y]);
      confSum += v.confidence;
    }
    out.push({
      value: poly.value,
      isIndex,
      grade,
      meanConfidence: confSum / slice.length,
      closed,
      coordinates: coords,
    });
  };

  let runStart = 0;
  let curGrade = segGrade(0);
  for (let i = 1; i < path.length - 1; i++) {
    const g = segGrade(i);
    if (g !== curGrade) {
      emit(runStart, i, curGrade, false);
      runStart = i;
      curGrade = g;
    }
  }
  const wholeSingleRun = runStart === 0;
  emit(runStart, path.length - 1, curGrade, poly.closed && wholeSingleRun);
  return out;
}

/**
 * Build the export model from stitched + styled contour levels.
 * Deterministic. Levels are matched to their style by elevation value.
 */
export function buildFeatureModel(
  stitched: ReadonlyArray<StitchedLevel>,
  styled: ReadonlyArray<StyledLevel>,
  params: FeatureModelParams,
): ContourFeatureModel {
  const warnings: string[] = [];
  const indexByValue = new Map<number, boolean>();
  for (const s of styled) indexByValue.set(s.value, s.isIndex);

  const features: ContourFeature[] = [];
  for (const level of stitched) {
    const isIndex = indexByValue.get(level.value) ?? false;
    for (const poly of level.polylines) {
      for (const f of splitPolyline(poly, isIndex)) features.push(f);
    }
  }

  // bbox + length-weighted interpolated fraction.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let totalLen = 0;
  let interpLen = 0;
  for (const f of features) {
    for (let i = 0; i < f.coordinates.length; i++) {
      const [x, y] = f.coordinates[i];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (i > 0) {
        const len = segLen(f.coordinates[i - 1], f.coordinates[i]);
        totalLen += len;
        if (f.grade !== 'solid') interpLen += len;
      }
    }
  }
  const bbox: ContourBBox | null = features.length > 0 ? { minX, minY, maxX, maxY } : null;
  const interpolatedFraction = totalLen > 0 ? interpLen / totalLen : Number.NaN;

  if (params.crs == null) {
    warnings.push('CRS unknown — this export is not georeferenced and may be unusable downstream');
  }
  if (params.verticalDatum == null) {
    warnings.push('Vertical datum unknown — contour elevations are not tied to a known datum');
  }

  return {
    features,
    crs: params.crs,
    verticalDatum: params.verticalDatum ?? null,
    verticalUnitToMetres: params.verticalUnitToMetres ?? null,
    verticalReference:
      params.verticalReference
      ?? verticalReferenceFromDatum({ verticalDatum: params.verticalDatum ?? undefined }),
    intervalM: params.intervalM,
    requestedIntervalM: params.requestedIntervalM ?? null,
    contourStyle: params.contourStyle ?? defaultContourShapeStyle,
    bbox,
    interpolatedFraction,
    coverageMode: params.coverageMode ?? 'full',
    warnings,
  };
}
