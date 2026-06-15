import { describe, it, expect } from 'vitest';
import {
  summariseAnnotationCategories,
  clusterAnnotations,
  suggestCellSize,
  describeAnnotationGroups,
  type ClusterableAnnotation,
} from '../src/render/annotate/annotationClustering';
import type { AnnotationType } from '../src/render/annotate/types';

function a(type: AnnotationType, x: number, y: number, z = 0): ClusterableAnnotation {
  return { type, localPosition: { x, y, z } };
}

describe('summariseAnnotationCategories', () => {
  it('counts per category and lists non-empty categories in display order', () => {
    const items = [a('issue', 0, 0), a('note', 0, 0), a('issue', 0, 0), a('warning', 0, 0)];
    const s = summariseAnnotationCategories(items);
    expect(s.total).toBe(4);
    expect(s.byType).toEqual({ note: 1, info: 0, warning: 1, issue: 2 });
    // Display order is note, info, warning, issue — info is dropped (zero).
    expect(s.ordered).toEqual([
      { type: 'note', count: 1 },
      { type: 'warning', count: 1 },
      { type: 'issue', count: 2 },
    ]);
  });

  it('handles an empty set', () => {
    const s = summariseAnnotationCategories([]);
    expect(s.total).toBe(0);
    expect(s.ordered).toEqual([]);
  });
});

describe('clusterAnnotations', () => {
  it('groups annotations in the same cell and separates distant ones', () => {
    const items = [
      a('note', 1, 1),
      a('issue', 2, 2), // same 10-cell as (1,1)
      a('note', 105, 105), // far cell
    ];
    const clusters = clusterAnnotations(items, 10);
    expect(clusters).toHaveLength(2);
    // Largest first.
    expect(clusters[0].members).toHaveLength(2);
    expect(clusters[1].members).toHaveLength(1);
  });

  it('computes a centroid and a per-type breakdown with a dominant type', () => {
    const clusters = clusterAnnotations([a('issue', 0, 0), a('issue', 2, 0), a('note', 4, 0)], 10);
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    expect(c.centroid).toEqual({ x: 2, y: 0, z: 0 });
    expect(c.byType.issue).toBe(2);
    expect(c.byType.note).toBe(1);
    expect(c.dominantType).toBe('issue');
  });

  it('is deterministic regardless of input order (centroid tiebreak)', () => {
    const f = [a('note', 1, 1), a('note', 50, 50)];
    const r = [a('note', 50, 50), a('note', 1, 1)];
    expect(clusterAnnotations(f, 10).map((c) => c.centroid)).toEqual(
      clusterAnnotations(r, 10).map((c) => c.centroid),
    );
  });

  it('guards a non-positive cell size without throwing', () => {
    const out = clusterAnnotations([a('note', 0, 0), a('note', 1000, 1000)], 0);
    // With the min cell, the two distant points are separate clusters.
    expect(out.length).toBe(2);
  });
});

describe('describeAnnotationGroups', () => {
  it('returns an empty string for no annotations', () => {
    expect(describeAnnotationGroups([])).toBe('');
  });

  it('gives total + breakdown + areas for a spread-out, mixed set', () => {
    const items = [a('issue', 0, 0), a('issue', 1, 1), a('note', 200, 200)];
    const line = describeAnnotationGroups(items);
    expect(line).toContain('3 annotations');
    expect(line).toContain('2 issues');
    expect(line).toContain('1 note');
    expect(line).toContain('2 areas');
  });

  it('omits the breakdown and areas for one category in one place', () => {
    // Coincident points → a single area; single category → no breakdown clause.
    const line = describeAnnotationGroups([a('note', 0, 0), a('note', 0, 0)]);
    expect(line).toBe('2 annotations');
  });

  it('uses singular nouns for a single annotation', () => {
    expect(describeAnnotationGroups([a('issue', 0, 0)])).toBe('1 annotation');
  });
});

describe('suggestCellSize', () => {
  it('derives a fifth of the largest horizontal extent', () => {
    expect(suggestCellSize([a('note', 0, 0), a('note', 100, 20)])).toBeCloseTo(20, 6);
  });

  it('returns the minimum for fewer than two annotations', () => {
    expect(suggestCellSize([])).toBeLessThan(1e-3);
    expect(suggestCellSize([a('note', 5, 5)])).toBeLessThan(1e-3);
  });
});
