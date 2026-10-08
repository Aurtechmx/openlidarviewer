/**
 * reportHeightVerticalUnit.test.ts
 *
 * The PDF dataset summary resolves Height from the vertical unit, the same way
 * the on-screen Scan Report does. Width and Depth follow the horizontal unit.
 * A metre CRS with no declared vertical unit prints Height in source units and
 * says why, word for word with the Scan Report. Also covers the "CRS origin"
 * row's wording when no vertical datum is declared.
 */
import { describe, it, expect } from 'vitest';
import { buildDatasetSummary, extentRows, type MetadataInputs } from '../src/report/ReportMetadataSection';
import { footprintMetres } from '../src/report/reportFootprint';
import { footprintToMetadataExtent } from '../src/app/reportExport';
import { scanReportUnitBasis } from '../src/analysis/modules/scanReport';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { crsOriginLine, crsOriginOf } from '../src/science/crsOrigin';
import { exportDigests } from '../src/science/exportDigestRecord';
import type { CrsInfo } from '../src/io/crs';

const US_SURVEY_FOOT = 1200 / 3937;

/** ETRF2000-PL / CS92 as a LAS VLR declares it: metres, no vertical datum or unit. */
const CS92: CrsInfo = {
  source: 'wkt',
  name: 'ETRF2000-PL / CS92',
  epsg: 2180,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
} as CrsInfo;

/** The 2023-12-16 scan's raw extents, in source units. */
const SPAN = { extentX: 1041.9, extentY: 461.7, extentZ: 15.7 };

/** Run one CRS through the PDF path: context → footprint → metadata → rows. */
function pdfRows(crs: CrsInfo | null, span = SPAN): Map<string, string> {
  const ctx = spatialContextFrom(crs);
  const fp = footprintMetres({
    ...span,
    pointCount: 4_257_368,
    linearUnitToMetres: ctx.linearUnitToMetres,
    verticalUnitToMetres: ctx.verticalUnitToMetres,
    linearUnitKnown: ctx.linearUnitKnown,
    zUp: true,
  });
  const inputs: MetadataInputs = {
    fileName: '2023-12-16.las', format: 'LAS', sourcePointCount: 4_257_368,
    ...footprintToMetadataExtent(fp),
    hasRgb: true, hasIntensity: true, hasClassification: true,
  };
  return new Map(buildDatasetSummary(inputs).map((r) => [r.label, r.value]));
}

/** The on-screen Scan Report's Height for the same CRS and span. */
function onScreenHeight(crs: CrsInfo | null, spanZ = SPAN.extentZ): string {
  const b = scanReportUnitBasis(spatialContextFrom(crs));
  return `${(spanZ * b.vmpu).toFixed(1)}${b.heightUnit}`;
}

describe('PDF Height follows the vertical unit', () => {
  it('metre CRS, vertical unit not declared: Height stays in source units', () => {
    const m = pdfRows(CS92);
    expect(m.get('Width')).toBe('1041.9 m');
    expect(m.get('Depth')).toBe('461.7 m');
    expect(m.get('Height')).toBe('15.7 source units (vertical unit not declared)');
    expect(m.get('Height')).toBe(onScreenHeight(CS92));
  });

  it('metre CRS, vertical unit declared in metres: Height in metres', () => {
    const crs = { ...CS92, verticalUnitToMetres: 1 } as CrsInfo;
    const m = pdfRows(crs);
    expect(m.get('Width')).toBe('1041.9 m');
    expect(m.get('Height')).toBe('15.7 m');
    expect(m.get('Height')).toBe(onScreenHeight(crs));
  });

  it('metre CRS, vertical unit declared in US survey feet: Height converted by its own factor', () => {
    const crs = { ...CS92, verticalUnitToMetres: US_SURVEY_FOOT } as CrsInfo;
    const m = pdfRows(crs, { ...SPAN, extentZ: 51.5 });
    expect(m.get('Width')).toBe('1041.9 m');
    expect(m.get('Height')).toBe('15.7 m');
    expect(m.get('Height')).toBe(onScreenHeight(crs, 51.5));
  });

  it('metre CRS, declared vertical unit invalid: Height says so', () => {
    const crs = { ...CS92, verticalUnitToMetres: 0 } as CrsInfo;
    const m = pdfRows(crs);
    expect(m.get('Height')).toBe('15.7 source units (declared vertical unit is invalid)');
    expect(m.get('Height')).toBe(onScreenHeight(crs));
  });

  it('no CRS: every extent in source units', () => {
    const m = pdfRows(null);
    expect(m.get('Width')).toBe('1041.9 (source units)');
    expect(m.get('Depth')).toBe('461.7 (source units)');
    expect(m.get('Height')).toBe('15.7 (source units)');
    expect(m.get('Height')).toBe(onScreenHeight(null));
  });

  it('Height in source units does not join the km scale of Width and Depth', () => {
    const rows = extentRows({
      width: 12_000, depth: 8_000, height: 2.5, unitKnown: true,
      heightUnit: 'vertical-unit-not-declared',
    });
    const v = new Map(rows.map((r) => [r.label, r.value]));
    expect(v.get('Width')).toBe('12.0 km');
    expect(v.get('Depth')).toBe('8.0 km');
    expect(v.get('Height')).toBe('2.5 source units (vertical unit not declared)');
  });
});

describe('CRS origin wording when no vertical datum is declared', () => {
  const cs92Origin = crsOriginOf({ source: 'las-vlr', name: 'ETRF2000-PL / CS92', epsg: 2180 });

  it('says the vertical datum is not declared', () => {
    expect(crsOriginLine(cs92Origin)).toBe('CRS source las-vlr (ETRF2000-PL / CS92, EPSG:2180); vertical datum not declared');
    expect(crsOriginLine(crsOriginOf(null))).toBe('CRS source unknown (unknown, unknown); vertical datum not declared');
  });

  it('keeps the datum and its source when one is declared', () => {
    const o = crsOriginOf({ source: 'las-vlr', name: 'NAD83(2011) / UTM zone 15N', epsg: 6344, verticalEpsg: 5703 });
    expect(crsOriginLine(o)).toBe('CRS source las-vlr (NAD83(2011) / UTM zone 15N, EPSG:6344); vertical datum EPSG:5703 from las-vlr');
  });

  it('leaves the machine-readable record fields unchanged', () => {
    expect(cs92Origin).toEqual({
      source: 'las-vlr', name: 'ETRF2000-PL / CS92', epsg: 'EPSG:2180', verticalDatum: 'unknown', verticalSource: 'unknown',
    });
  });

  it('the PDF CRS origin row uses the same wording', () => {
    const rows = buildDatasetSummary({
      fileName: 'a.las', format: 'LAS', sourcePointCount: 1, width: 1, depth: 1, height: 1, density: 1,
      hasRgb: false, hasIntensity: false, hasClassification: false,
      digests: exportDigests({ sha256: 'ab', note: null }, { source: 'las-vlr', name: 'ETRF2000-PL / CS92', epsg: 2180 }),
    });
    expect(rows).toContainEqual({ label: 'CRS origin', value: 'las-vlr, EPSG:2180; vertical datum not declared' });
  });
});
