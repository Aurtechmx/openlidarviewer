/**
 * annotationClustering.ts
 *
 * Pure grouping helpers over a set of annotations — the data layer behind the
 * Inspector's annotation summary and the report's grouped notes block. Two
 * independent groupings:
 *
 *   - Category groups — counts per {@link AnnotationType}, in display order, so
 *     a dense scan reads "12 annotations · 5 issues · 4 notes" instead of a
 *     wall of markers.
 *   - Spatial bins — annotations falling in the same fixed-size cell of the
 *     scan's local frame collapse into one cluster with a centroid and a
 *     per-type breakdown, so "23 notes" becomes "3 areas" a reader can reason
 *     about.
 *
 * Pure data: no DOM, no three.js — unit-tested in Node. Operates on the minimal
 * `{ type, localPosition }` shape so it serves both the full {@link Annotation}
 * and the Inspector's denormalised summary.
 */

import type { AnnotationType, Vec3Object } from './types';
import { ANNOTATION_TYPES } from './types';

/** The minimal annotation shape the clustering needs. */
export interface ClusterableAnnotation {
  readonly type: AnnotationType;
  readonly localPosition: Vec3Object;
}

/** A zeroed per-type tally. */
function emptyByType(): Record<AnnotationType, number> {
  return { note: 0, info: 0, warning: 0, issue: 0 };
}

/** Category breakdown for a compact summary line. */
export interface CategoryBreakdown {
  /** Total annotation count. */
  readonly total: number;
  /** Count per category (zero for absent categories). */
  readonly byType: Record<AnnotationType, number>;
  /** Non-zero categories only, in display order — for the summary line. */
  readonly ordered: ReadonlyArray<{ readonly type: AnnotationType; readonly count: number }>;
}

/**
 * Count annotations by category. Accepts anything carrying a `type`, so it
 * serves both the report's full annotations and the panel's summaries.
 */
export function summariseAnnotationCategories(
  items: ReadonlyArray<{ readonly type: AnnotationType }>,
): CategoryBreakdown {
  const byType = emptyByType();
  for (const it of items) byType[it.type]++;
  const ordered = ANNOTATION_TYPES
    .filter((t) => byType[t] > 0)
    .map((t) => ({ type: t, count: byType[t] }));
  return { total: items.length, byType, ordered };
}

/** One spatial cluster of nearby annotations. */
export interface AnnotationCluster {
  /** Mean of the members' local positions. */
  readonly centroid: Vec3Object;
  /** The annotations in this cluster (input order preserved). */
  readonly members: readonly ClusterableAnnotation[];
  /** Per-category counts within the cluster. */
  readonly byType: Record<AnnotationType, number>;
  /** The most common category; ties resolve to ANNOTATION_TYPES order. */
  readonly dominantType: AnnotationType;
}

/** Smallest cell the clustering will use — guards a zero/negative/NaN input. */
const MIN_CELL = 1e-6;

/**
 * Group annotations into fixed-size spatial cells of the local frame. Two
 * annotations land in the same cluster when they fall in the same
 * `cellSize`-edged cube. Clusters are returned largest-first (then by centroid)
 * so the most significant area reads first; the ordering is deterministic.
 */
export function clusterAnnotations(
  annotations: readonly ClusterableAnnotation[],
  cellSize: number,
): AnnotationCluster[] {
  const cell = Number.isFinite(cellSize) && cellSize > MIN_CELL ? cellSize : MIN_CELL;
  const bins = new Map<string, ClusterableAnnotation[]>();
  for (const a of annotations) {
    const i = Math.floor(a.localPosition.x / cell);
    const j = Math.floor(a.localPosition.y / cell);
    const k = Math.floor(a.localPosition.z / cell);
    const key = `${i},${j},${k}`;
    const bucket = bins.get(key);
    if (bucket) bucket.push(a);
    else bins.set(key, [a]);
  }

  const clusters: AnnotationCluster[] = [];
  for (const members of bins.values()) {
    let sx = 0, sy = 0, sz = 0;
    const byType = emptyByType();
    for (const m of members) {
      sx += m.localPosition.x;
      sy += m.localPosition.y;
      sz += m.localPosition.z;
      byType[m.type]++;
    }
    const n = members.length;
    let dominantType: AnnotationType = ANNOTATION_TYPES[0];
    for (const t of ANNOTATION_TYPES) {
      if (byType[t] > byType[dominantType]) dominantType = t;
    }
    clusters.push({
      centroid: { x: sx / n, y: sy / n, z: sz / n },
      members,
      byType,
      dominantType,
    });
  }

  clusters.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    // Deterministic tiebreak so the order never depends on Map iteration.
    if (a.centroid.x !== b.centroid.x) return a.centroid.x - b.centroid.x;
    if (a.centroid.y !== b.centroid.y) return a.centroid.y - b.centroid.y;
    return a.centroid.z - b.centroid.z;
  });
  return clusters;
}

/** Plural-aware category words for the summary line. */
const CATEGORY_PLURAL: Record<AnnotationType, (n: number) => string> = {
  issue: (n) => (n === 1 ? 'issue' : 'issues'),
  warning: (n) => (n === 1 ? 'warning' : 'warnings'),
  info: () => 'info',
  note: (n) => (n === 1 ? 'note' : 'notes'),
};

/**
 * One compact line describing a set of annotations: total, the per-category
 * breakdown, and — when they spread across the scan — how many areas they fall
 * into. Pure and shared by the Inspector panel and the PDF report so the two
 * read identically. Returns '' for an empty set.
 */
export function describeAnnotationGroups(items: readonly ClusterableAnnotation[]): string {
  if (items.length === 0) return '';
  const cats = summariseAnnotationCategories(items);
  const parts = [`${cats.total} annotation${cats.total === 1 ? '' : 's'}`];
  const breakdown = cats.ordered.map((o) => `${o.count} ${CATEGORY_PLURAL[o.type](o.count)}`);
  if (breakdown.length > 1) parts.push(breakdown.join(', '));
  const areas = clusterAnnotations(items, suggestCellSize(items)).length;
  if (areas > 1) parts.push(`${areas} areas`);
  return parts.join(' · ');
}

/**
 * Suggest a spatial cell size from the spread of the annotations themselves —
 * roughly a fifth of the largest horizontal extent, so a site with notes spread
 * across it resolves into a handful of areas rather than one blob or one
 * cluster each. Returns `MIN_CELL` when there is nothing to measure.
 */
export function suggestCellSize(annotations: readonly ClusterableAnnotation[]): number {
  if (annotations.length < 2) return MIN_CELL;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const a of annotations) {
    if (a.localPosition.x < minX) minX = a.localPosition.x;
    if (a.localPosition.x > maxX) maxX = a.localPosition.x;
    if (a.localPosition.y < minY) minY = a.localPosition.y;
    if (a.localPosition.y > maxY) maxY = a.localPosition.y;
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  return extent > MIN_CELL ? extent / 5 : MIN_CELL;
}
