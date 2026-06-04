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
  readonly intervalM: number;
  readonly bbox: ContourBBox | null;
  /** Length-weighted fraction of contour that is dashed or gap. */
  readonly interpolatedFraction: number;
  /** Coverage provenance the contours inherit from the DTM. */
  readonly coverageMode: TerrainCoverageMode;
  readonly warnings: string[];
}

/** Options for {@link buildFeatureModel}. */
export interface FeatureModelParams {
  readonly crs: string | null;
  readonly verticalDatum?: string | null;
  readonly intervalM: number;
  /** Coverage provenance from the analysis (default 'full'). */
  readonly coverageMode?: TerrainCoverageMode;
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
    intervalM: params.intervalM,
    bbox,
    interpolatedFraction,
    coverageMode: params.coverageMode ?? 'full',
    warnings,
  };
}
