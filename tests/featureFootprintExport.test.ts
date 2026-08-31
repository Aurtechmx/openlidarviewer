/**
 * featureFootprintExport.test.ts — the "Export accepted (GeoJSON)" wiring.
 *
 * Pins that the export helper ships ONLY reviewer-accepted footprints, records
 * the CRS + registered method, and returns null when nothing is accepted — the
 * anti-goal being an unreviewed or rejected candidate leaving as a deliverable.
 */

import { describe, it, expect } from 'vitest';
import { acceptedFootprintGeoJson } from '../src/ui/featureCandidatesMount';
import { CandidateReviewStore } from '../src/features/candidateReview';
import type { BuildingCandidate } from '../src/features/FeatureExtractionService';

function building(id: string): BuildingCandidate {
  return {
    kind: 'building',
    id,
    confidence: 'derived',
    areaSource: 42,
    areaM2: 42,
    cellCount: 10,
    ring: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    centroid: [0.5, 0.5],
    bounds: [0, 0, 1, 1],
  };
}

describe('acceptedFootprintGeoJson', () => {
  it('exports only accepted candidates, never unreviewed or rejected', () => {
    const buildings = [building('a'), building('b'), building('c')];
    const review = new CandidateReviewStore();
    review.accept('a');
    review.reject('b');
    // 'c' left unreviewed.
    const gj = acceptedFootprintGeoJson(buildings, review, 'EPSG:32612');
    expect(gj).not.toBeNull();
    expect(gj!.features).toHaveLength(1);
    // The one feature is the accepted one (feature-level id per RFC 7946).
    expect(gj!.features[0].id).toBe('a');
  });

  it('returns null when nothing is accepted (no empty file)', () => {
    const buildings = [building('a'), building('b')];
    const review = new CandidateReviewStore();
    review.reject('a'); // reject one, leave one unreviewed
    expect(acceptedFootprintGeoJson(buildings, review, 'EPSG:32612')).toBeNull();
  });

  it('records the CRS and stamps the registered method; labels features derived', () => {
    const review = new CandidateReviewStore();
    review.accept('a');
    const gj = acceptedFootprintGeoJson([building('a')], review, 'EPSG:3301')!;
    expect(gj.metadata.crs).toBe('EPSG:3301');
    // The method tag is the registered building-footprint method.
    expect(JSON.stringify(gj)).toContain('olv.feature.building-footprint@1');
    // The exporter's own honest labelling travels (derived candidate).
    const props = gj.features[0].properties as Record<string, unknown>;
    expect(props.source).toBe('derived');
  });

  it('carries a null CRS through for a non-georeferenced scan', () => {
    const review = new CandidateReviewStore();
    review.accept('a');
    const gj = acceptedFootprintGeoJson([building('a')], review, null)!;
    expect(gj.metadata.crs).toBeNull();
  });
});
