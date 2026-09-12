/**
 * The contour export permit, resolved against the REAL claim register.
 *
 * `contourExportPermit.test.ts` supplies `evidenceStatusOf: () => 'validated'`
 * for its normal context. That is correct for testing the permit's own branching
 * but it makes the suite blind to an exporter registered against the wrong
 * claim: every product looks validated regardless of what it actually contains.
 * These assertions deliberately use no stub.
 */
import { describe, it, expect } from 'vitest';
import { SCIENTIFIC_EXPORTERS, exporterRegistration } from '../src/export/exportManifest';
import { governingClaim } from '../src/validation/evidenceComposition';
import { evidenceStatus } from '../src/validation/exportEvidenceNote';

const statusOf = (exporterId: string): string => {
  const reg = exporterRegistration(exporterId);
  expect(reg, `no registration for ${exporterId}`).toBeDefined();
  return evidenceStatus(governingClaim(reg!.claimIds));
};

describe('export permits under the real register', () => {
  it('a generalized contour product is exploratory, not validated', () => {
    // CONTOURS-CARTOGRAPHIC is E2 against a required E4: the GDAL agreement
    // belongs to the analytical line, and generalization moves off it.
    expect(statusOf('contour.geojson.cartographic')).toBe('exploratory');
    expect(statusOf('contour.dxf.cartographic')).toBe('exploratory');
    expect(statusOf('contour.svg.cartographic')).toBe('exploratory');
    expect(statusOf('contour.pdf')).toBe('exploratory');
  });

  it('the deliverable package is exploratory because it carries a DTM', () => {
    // DTM is E4 against a required E5. A package cannot be authorised above the
    // weakest thing inside it, whatever its headline product is.
    expect(statusOf('contour.package')).toBe('exploratory');
    expect(governingClaim(exporterRegistration('contour.package')!.claimIds))
      .toBe('CONTOURS-CARTOGRAPHIC');
  });

  it('the DTM raster and the terrain report agree with each other', () => {
    expect(statusOf('contour.dem')).toBe('exploratory');
    expect(statusOf('contour.report')).toBe('exploratory');
  });

  it('the ANALYTICAL geojson is also exploratory — it inherits the DTM', () => {
    // The register states this as an assumption on CONTOURS itself:
    // "depends on DTM validity". CONTOURS alone meets its E4 bar, but a contour
    // is an iso-line through a grid that has not met its own, so the artifact
    // cannot claim more than the grid.
    expect(evidenceStatus('CONTOURS')).toBe('validated');
    expect(evidenceStatus('DTM')).toBe('exploratory');
    expect(statusOf('contour.geojson.analytical')).toBe('exploratory');
  });

  it('no exporter under the real register resolves to validated today', () => {
    // Stated as a fact about this release rather than a rule: every shipping
    // product depends on the DTM or on a generalized geometry. If a future
    // exporter is genuinely independent of both, this expectation should be
    // revisited deliberately, not deleted to make a build pass.
    const validated = SCIENTIFIC_EXPORTERS
      .filter((e) => evidenceStatus(governingClaim(e.claimIds)) === 'validated')
      .map((e) => e.exporterId);
    expect(validated).toEqual([]);
  });

  it('no exporter is refused outright, so the gate is not a blanket block', () => {
    const refused = SCIENTIFIC_EXPORTERS
      .filter((e) => evidenceStatus(governingClaim(e.claimIds)) === 'refused')
      .map((e) => e.exporterId);
    expect(refused).toEqual([]);
  });
});
