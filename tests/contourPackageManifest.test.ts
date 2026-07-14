/**
 * contourPackageManifest.test.ts
 *
 * The complete-deliverable-package model (spec §21): honest omissions (no empty
 * placeholders), the §21.1 vector attributes, the README (§21.2 + §29 checksum
 * wording), the exploratory caveat, and the blocked-never-packaged rule.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContourPackageManifest,
  contourFeatureAttributes,
  packageStem,
  type PackageInput,
  type FeatureAttributeContext,
} from '../src/terrain/contourStudio/contourPackageManifest';
import type { ContourFeature } from '../src/terrain/contour/contourFeatureModel';
import type { ScientificExportDecision } from '../src/export/exportManifest';

const validated: ScientificExportDecision = { status: 'validated', badge: 'Internal validation', caveats: [] };
const exploratory: ScientificExportDecision = { status: 'exploratory', badge: 'Exploratory', watermark: 'EXPLORATORY', caveats: [] };
const blocked: ScientificExportDecision = { status: 'blocked', reasons: ['no surface'] };

const allAvailable = {
  pdf: true, analyticalGeojson: true, cartographicGeojson: true, cartographicDxf: true,
  dtm: true, hillshade: true, support: true, uncertainty: true,
  validationJson: true, provenanceJson: true, studioJson: true,
};

function input(decision: ScientificExportDecision, over: Partial<PackageInput> = {}): PackageInput {
  return {
    projectName: 'Site A / North',
    decision,
    available: allAvailable,
    provenance: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', horizontalUnit: 'metre', verticalUnit: 'metre', software: 'OpenLiDARViewer', softwareVersion: '0.5.9' },
    citation: 'Cite OpenLiDARViewer v0.5.9 (CITATION.cff).',
    ...over,
  };
}

describe('packageStem', () => {
  it('sanitizes to a zip-safe stem', () => {
    expect(packageStem('Site A / North')).toBe('Site_A_North');
    expect(packageStem('   ')).toBe('contour-deliverable');
  });
});

describe('buildContourPackageManifest', () => {
  it('includes all products + README + SHA256SUMS when everything is available', () => {
    const m = buildContourPackageManifest(input(validated));
    const included = m.entries.filter((e) => e.status === 'included').map((e) => e.role);
    expect(included).toContain('contour-map-pdf');
    expect(included).toContain('contours-analytical-geojson');
    expect(included).toContain('readme');
    expect(included).toContain('checksums');
    expect(m.entries.every((e) => e.status === 'included')).toBe(true);
    expect(m.zipName).toBe('Site_A_North_Contour_Deliverable.zip');
  });

  it('names the multipage PDF an honest report — never a rendered map sheet', () => {
    const m = buildContourPackageManifest(input(validated));
    const pdf = m.entries.find((e) => e.role === 'contour-map-pdf')!;
    expect(pdf.status).toBe('included');
    // The in-ZIP PDF is a TEXT technical report (summary + support + validation
    // + provenance). Only the standalone map-sheet PDF renders an actual map,
    // so this filename must not oversell itself as one.
    expect(pdf.filename).toMatch(/Contour_Report\.pdf$/);
    expect(pdf.filename).not.toMatch(/map/i);
  });

  it('omits an unavailable product with a reason — never an empty file', () => {
    const m = buildContourPackageManifest(
      input(validated, { available: { ...allAvailable, uncertainty: false }, omissionReasons: { 'uncertainty-raster': 'Uncertainty was not computed for this scan.' } }),
    );
    const unc = m.entries.find((e) => e.role === 'uncertainty-raster')!;
    expect(unc.status).toBe('omitted');
    expect(unc.reason).toMatch(/not computed/i);
    // The README explains the omission.
    expect(m.readme).toMatch(/omitted: Uncertainty was not computed/i);
  });

  it('README carries the checksum-not-authorship wording (§29) and citation', () => {
    const m = buildContourPackageManifest(input(validated));
    expect(m.readme).toMatch(/does not prove authorship/i);
    expect(m.readme).toMatch(/SHA256SUMS/);
    expect(m.readme).toContain('Cite OpenLiDARViewer v0.5.9');
  });

  it('an exploratory package is flagged in the README', () => {
    const m = buildContourPackageManifest(input(exploratory));
    expect(m.exploratory).toBe(true);
    expect(m.readme).toMatch(/EXPLORATORY DELIVERABLE/);
  });

  it('a blocked decision never produces a package', () => {
    expect(() => buildContourPackageManifest(input(blocked))).toThrow(/blocked/i);
  });
});

describe('contourFeatureAttributes (§21.1)', () => {
  function feature(over: Partial<ContourFeature> = {}): ContourFeature {
    return { value: 12.5, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [1, 0]], ...over } as ContourFeature;
  }
  const ctx: FeatureAttributeContext = {
    featureId: 7, indexOrder: 2, geometryRole: 'analytical-isoline', evidenceLevel: 'E3',
    validationMode: 'Spatial internal', methodId: 'olv.contour.analytical', methodVersion: '1',
    sourceHash: 'deadbeef', softwareVersion: '0.5.9', gitCommit: 'abc123', elevationUnit: 'm',
  };

  it('emits the full attribute set with honest support fractions', () => {
    const a = contourFeatureAttributes(feature({ grade: 'solid' }), ctx);
    expect(a.feature_id).toBe(7);
    expect(a.elevation).toBe(12.5);
    expect(a.elevation_unit).toBe('m');
    expect(a.contour_type).toBe('index');
    expect(a.geometry_role).toBe('analytical-isoline');
    expect(a.support_class).toBe('measured');
    expect(a.measured_fraction).toBe(1);
    expect(a.interpolated_fraction).toBe(0);
    expect(a.method_id).toBe('olv.contour.analytical');
    expect(a.source_hash).toBe('deadbeef');
  });

  it('interpolated support + no uncertainty → interpolated fraction 1, null sigmas, not-assessed', () => {
    const a = contourFeatureAttributes(feature({ grade: 'dashed' }), ctx);
    expect(a.support_class).toBe('interpolated');
    expect(a.interpolated_fraction).toBe(1);
    expect(a.vertical_sigma_m).toBeNull();
    expect(a.horizontal_p95_m).toBeNull();
    expect(a.uncertainty_condition).toBe('not-assessed');
  });

  it('unknown elevation unit is reported as "unknown", never fabricated', () => {
    const a = contourFeatureAttributes(feature(), { ...ctx, elevationUnit: '' });
    expect(a.elevation_unit).toBe('unknown');
  });
});
