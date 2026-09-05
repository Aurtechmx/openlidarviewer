/**
 * featureFootprintExport.test.ts — the "Export accepted (GeoJSON)" wiring.
 *
 * Pins that the export helper ships ONLY reviewer-accepted footprints, records
 * the CRS + registered method, and returns null when nothing is accepted — the
 * anti-goal being an unreviewed or rejected candidate leaving as a deliverable.
 */

/** Identity converter: the reprojection is exercised in lonLatMapper's own tests. */
const IDENTITY_LL = (p: readonly [number, number, number]): [number, number, number] => [p[0], p[1], p[2]];
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
    const gj = acceptedFootprintGeoJson(buildings, review, 'EPSG:32612', IDENTITY_LL);
    expect(gj).not.toBeNull();
    expect(gj!.features).toHaveLength(1);
    // The one feature is the accepted one (feature-level id per RFC 7946).
    expect(gj!.features[0].id).toBe('a');
  });

  it('returns null when nothing is accepted (no empty file)', () => {
    const buildings = [building('a'), building('b')];
    const review = new CandidateReviewStore();
    review.reject('a'); // reject one, leave one unreviewed
    expect(acceptedFootprintGeoJson(buildings, review, 'EPSG:32612', IDENTITY_LL)).toBeNull();
  });

  it('records the CRS and stamps the registered method; labels features derived', () => {
    const review = new CandidateReviewStore();
    review.accept('a');
    const gj = acceptedFootprintGeoJson([building('a')], review, 'EPSG:3301', IDENTITY_LL)!;
    expect(gj.metadata.extractedFromCrs).toBe('EPSG:3301');
    // The method tag is the registered building-footprint method.
    expect(JSON.stringify(gj)).toContain('olv.feature.building-footprint@1');
    // The exporter's own honest labelling travels (derived candidate).
    const props = gj.features[0].properties as Record<string, unknown>;
    expect(props.source).toBe('derived');
  });

  it('refuses entirely when the frame cannot be converted to lon/lat', () => {
    // Previously this exported with a null CRS, writing the extraction's
    // RENDER-LOCAL coordinates into a format whose positions are defined as
    // WGS 84. A reader placed the building near the projection origin, which
    // for a UTM scan is hundreds of kilometres from the site. No converter now
    // means no file.
    const review = new CandidateReviewStore();
    review.accept('a');
    expect(acceptedFootprintGeoJson([building('a')], review, null, null)).toBeNull();
  });

  it('omits the extraction CRS rather than inventing one, when it is unknown', () => {
    const review = new CandidateReviewStore();
    review.accept('a');
    const gj = acceptedFootprintGeoJson([building('a')], review, null, IDENTITY_LL)!;
    expect(gj.metadata.extractedFromCrs).toBeUndefined();
    // RFC 7946 removed the `crs` member; a reader must never have to ask which
    // frame a position is in.
    expect(Object.keys(gj.metadata)).not.toContain('crs');
  });
});
