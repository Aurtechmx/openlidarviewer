/**
 * contourFeatureModel.ts
 *
 * Shared intermediate representation. Every exporter (GeoJSON,
 * SVG, DXF, and the PDF block) consumes THIS, so the format-specific
 * writers stay thin serializers with one source of truth for geometry,
 * elevation, evidence grade, and georeferencing.
 *
 * The honest move that distinguishes these exports: each polyline is
 * split into maximal runs of a single display grade (by SEGMENT grade =
 * the weaker of its two endpoints) AND a single basis (see
 * {@link contourBasis}), so a downstream GIS sees exactly which spans are
 * confident measured ground (solid), measured but sparse ground or
 * interpolated support (dashed), or unsupported (gap) — instead of one
 * authoritative line over mixed evidence. Nothing is silently dropped; gap
 * runs are emitted and labelled so the recipient decides.
 *
 * CRS is mandatory for a usable export: when it is unknown the model
 * still builds but carries a prominent warning, and writers surface it.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { gradeForConfidence, type ContourDisplayGrade } from '../ground/cellConfidence';
import type { TerrainCoverageMode } from '../TerrainContracts';
import type { ContourPolyline, StitchedLevel } from './stitchContours';
import {
  PROV_I,
  PROV_M,
  unionProvBits,
  provenanceSetFromBits,
  type ContourSegmentEvidence,
} from './contourSegmentEvidence';
import type { StyledLevel } from './contourStyle';
import { defaultContourShapeStyle, type ContourShapeStyle } from './contourShapeStyle';
// The vertical-reference classifier the SpatialContext façade wraps. Called
// ONCE here, so the model carries the answer and no writer re-derives it.
import { verticalReferenceFromDatum, type VerticalReference } from '../../geo/height';

/** One exportable contour feature: a single-grade run at one elevation. */
export interface ContourFeature {
  readonly value: number;
  readonly isIndex: boolean;
  /** DISPLAY grade (presentation, not provenance — see {@link ContourDisplayGrade}). */
  readonly grade: ContourDisplayGrade;
  /** Mean confidence (0..100) of the run's vertices. */
  readonly meanConfidence: number;
  /**
   * Source-provenance bitmask aggregated as a UNION over the run's vertices
   * (PROV_M=1, PROV_I=2, mixed=3). This is the real source evidence — measured
   * vs interpolated — carried through from the DTM cells, NOT reconstructed from
   * the display grade. `buildFeatureModel` always sets it; OPTIONAL so a
   * hand-assembled feature that carries no evidence serializes as `unavailable`
   * (fail closed) rather than being forced to invent one. Read the typed shape
   * via {@link featureEvidence}.
   */
  readonly provBits?: number;
  /**
   * What the run stands on (see {@link ContourBasis}), decided per segment by
   * {@link buildFeatureModel}. Read it through {@link contourBasis}, which
   * derives it from `grade` and `provBits` for a feature assembled by hand.
   */
  readonly basis?: ContourBasis;
  /** True only when this feature is a complete closed ring. */
  readonly closed: boolean;
  /** Vertices as [x, y] in CRS coordinates (elevation is `value`). */
  readonly coordinates: Array<[number, number]>;
}

/**
 * The typed source evidence for a feature (WI-2). Provenance is the aggregated
 * union; `presentation-confidence` is the run's mean confidence, carried as its
 * OWN channel (never mixed with support). Provenance and display grade are kept
 * separate on purpose.
 */
export function featureEvidence(f: ContourFeature): ContourSegmentEvidence {
  return {
    provenance: provenanceSetFromBits(f.provBits ?? 0),
    support: { 'presentation-confidence': f.meanConfidence },
  };
}

/**
 * What a contour run stands on: its display grade and its source provenance
 * read together.
 *
 * The grade alone cannot say this. A measured cell's confidence scales with its
 * ground-return count against the scene's median count, so measured ground
 * under canopy grades dashed; read as "interpolated", that put most of a drone
 * strip's measured ground in the interpolated share. The basis keeps the two
 * apart:
 *  - `measured`: solid, on measured cells only.
 *  - `sparse`: below the solid threshold, on measured cells only.
 *  - `interpolated`: not a gap, and on cells that touch interpolated ground.
 *  - `gap`: below the dashed threshold, whatever its support.
 *  - `unavailable`: not a gap, and the run carries no provenance (a feature
 *    assembled by hand). Fails closed: never read as measured.
 */
export type ContourBasis = 'measured' | 'sparse' | 'interpolated' | 'gap' | 'unavailable';

/**
 * The basis of one run (see {@link ContourBasis}): the one
 * {@link buildFeatureModel} recorded, else read from the run's grade and its
 * provenance union, where any interpolated bit makes it interpolated.
 */
export function contourBasis(f: Pick<ContourFeature, 'grade' | 'provBits' | 'basis'>): ContourBasis {
  if (f.basis !== undefined) return f.basis;
  if (f.grade === 'gap') return 'gap';
  const bits = f.provBits ?? 0;
  if ((bits & PROV_I) !== 0) return 'interpolated';
  if ((bits & PROV_M) === 0) return 'unavailable';
  return f.grade === 'solid' ? 'measured' : 'sparse';
}

/** The four line kinds a map draws and its legend names. */
export type ContourLineKind = Exclude<ContourBasis, 'unavailable'>;

/**
 * The line kind a run is drawn as. A run with no provenance (a model built by
 * hand) is never drawn as sparse measured ground: a solid one keeps the plain
 * contour line its grade earned, anything weaker is drawn as interpolated.
 */
export function contourLineKind(f: Pick<ContourFeature, 'grade' | 'provBits' | 'basis'>): ContourLineKind {
  const basis = contourBasis(f);
  if (basis !== 'unavailable') return basis;
  return f.grade === 'solid' ? 'measured' : 'interpolated';
}

/**
 * Length-weighted shares of a model's contour, by basis. Each is 0..1, or NaN
 * when there is no contour length. Together they make up the non-solid share,
 * less any run that carries no provenance (`unavailable`), which counts in none.
 */
export interface ContourLengthShares {
  /** Runs on any interpolated support. */
  readonly interpolated: number;
  /** Measured-only runs below the solid threshold. */
  readonly sparse: number;
  /** Runs below the dashed threshold. */
  readonly gap: number;
}

/** Non-solid and per-basis shares of a feature list, by drawn length. */
function measureLengthShares(
  features: ReadonlyArray<ContourFeature>,
): ContourLengthShares & { readonly nonSolid: number } {
  let total = 0;
  let nonSolid = 0;
  let interpolated = 0;
  let sparse = 0;
  let gap = 0;
  for (const f of features) {
    const basis = contourBasis(f);
    for (let i = 1; i < f.coordinates.length; i++) {
      const len = segLen(f.coordinates[i - 1], f.coordinates[i]);
      total += len;
      if (f.grade !== 'solid') nonSolid += len;
      if (basis === 'interpolated') interpolated += len;
      else if (basis === 'sparse') sparse += len;
      else if (basis === 'gap') gap += len;
    }
  }
  const share = (len: number): number => (total > 0 ? len / total : Number.NaN);
  return { nonSolid: share(nonSolid), interpolated: share(interpolated), sparse: share(sparse), gap: share(gap) };
}

/**
 * The per-basis length shares every surface prints. A model built by
 * {@link buildFeatureModel} carries them; one assembled by hand is measured
 * from its features here.
 */
export function modelLengthShares(model: ContourFeatureModel): ContourLengthShares {
  const { interpolatedLengthFraction: interpolated, sparseLengthFraction: sparse, gapLengthFraction: gap } = model;
  if (interpolated !== undefined && sparse !== undefined && gap !== undefined) {
    return { interpolated, sparse, gap };
  }
  const m = measureLengthShares(model.features);
  return { interpolated: m.interpolated, sparse: m.sparse, gap: m.gap };
}

/** Bounding box of all feature coordinates. */
export interface ContourBBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Legacy per-contour evidence vocabulary.
 *
 * @deprecated This vocabulary was DERIVED FROM THE DISPLAY GRADE, which conflates
 * presentation with provenance: a solid line is not proof of measured ground.
 * Do not serialize it. Use {@link featureEvidence} + `serializeProvenance` for
 * real source provenance (measured/interpolated/mixed/unavailable). Kept only so
 * an out-of-tree caller still compiles for one release.
 */
export type ContourEvidence =
  | 'measuredBacked'
  | 'interpolatedBacked'
  | 'lowConfidence';

/**
 * @deprecated Maps DISPLAY grade to a provenance-sounding label — exactly the
 * defect this release removes. It fabricates provenance from stroke style. Use
 * {@link featureEvidence} instead; this remains only for one-release
 * compatibility and must not be used in any export path.
 */
export function contourEvidence(grade: ContourDisplayGrade): ContourEvidence {
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
  /**
   * Length-weighted fraction of contour that is NOT solid: sparse ground,
   * interpolated and gap together. NaN when there is no contour length.
   *
   * The name predates the basis split and is kept, with this value, because the
   * GeoJSON metadata and existing callers read it. It is not the interpolated
   * share: that is {@link interpolatedLengthFraction}.
   */
  readonly interpolatedFraction: number;
  /**
   * Length-weighted fraction on interpolated support (basis `interpolated`).
   * Set by {@link buildFeatureModel}; read through {@link modelLengthShares},
   * which also measures a model assembled by hand.
   */
  readonly interpolatedLengthFraction?: number;
  /** Length-weighted fraction on measured-only support below solid (basis `sparse`). */
  readonly sparseLengthFraction?: number;
  /** Length-weighted fraction below the dashed threshold (basis `gap`). */
  readonly gapLengthFraction?: number;
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

/** Split one polyline into run features of a single grade and basis. */
function splitPolyline(poly: ContourPolyline, isIndex: boolean): ContourFeature[] {
  const vs = poly.vertices;
  if (vs.length < 2) return [];
  // For a closed ring, append the first vertex so the closing segment
  // participates in run-splitting.
  const path = poly.closed ? [...vs, vs[0]] : vs;
  const segGrade = (i: number): ContourDisplayGrade =>
    gradeForConfidence(Math.min(path[i].confidence, path[i + 1].confidence));
  // A run also breaks where interpolated support starts or stops, so each run
  // has one basis. A segment stands on interpolated ground when BOTH endpoints
  // carry interpolated provenance. A vertex's bits are the union of the cells of
  // the segments that meet there, so both ends of a segment carry its own cell's
  // bits: the test catches every segment whose cell touches interpolated ground.
  // Asking for only one end also caught the measured segment either side of an
  // interpolated stretch, which on a drone strip doubled the interpolated share
  // (about 10% of contour length where 5% stood on interpolated cells). Gap runs
  // are not split this way.
  const segKey = (i: number): string => {
    const g = segGrade(i);
    if (g === 'gap') return g;
    return (path[i].provBits & path[i + 1].provBits & PROV_I) === 0 ? g : `${g}+i`;
  };

  const out: ContourFeature[] = [];
  const emit = (startV: number, endV: number, grade: ContourDisplayGrade, key: string, closed: boolean) => {
    const slice = path.slice(startV, endV + 1);
    if (slice.length < 2) return;
    let confSum = 0;
    // Provenance is aggregated as a UNION over the run's vertices — the feature's
    // real source evidence (measured/interpolated/mixed), independent of `grade`.
    let provBits = 0;
    const coords: Array<[number, number]> = [];
    for (const v of slice) {
      coords.push([v.x, v.y]);
      confSum += v.confidence;
      provBits = unionProvBits(provBits, v.provBits);
    }
    let basis: ContourBasis;
    if (grade === 'gap') basis = 'gap';
    else if (key.endsWith('+i')) basis = 'interpolated';
    else if ((provBits & PROV_M) === 0) basis = 'unavailable';
    else basis = grade === 'solid' ? 'measured' : 'sparse';
    out.push({
      value: poly.value,
      isIndex,
      grade,
      meanConfidence: confSum / slice.length,
      provBits,
      basis,
      closed,
      coordinates: coords,
    });
  };

  let runStart = 0;
  let curGrade = segGrade(0);
  let curKey = segKey(0);
  for (let i = 1; i < path.length - 1; i++) {
    const k = segKey(i);
    if (k !== curKey) {
      emit(runStart, i, curGrade, curKey, false);
      runStart = i;
      curGrade = segGrade(i);
      curKey = k;
    }
  }
  const wholeSingleRun = runStart === 0;
  emit(runStart, path.length - 1, curGrade, curKey, poly.closed && wholeSingleRun);
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

  // bbox + length-weighted shares (non-solid, and per basis).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of features) {
    for (const [x, y] of f.coordinates) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const bbox: ContourBBox | null = features.length > 0 ? { minX, minY, maxX, maxY } : null;
  const shares = measureLengthShares(features);

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
    interpolatedFraction: shares.nonSolid,
    interpolatedLengthFraction: shares.interpolated,
    sparseLengthFraction: shares.sparse,
    gapLengthFraction: shares.gap,
    coverageMode: params.coverageMode ?? 'full',
    warnings,
  };
}
