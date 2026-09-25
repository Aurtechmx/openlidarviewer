import { describe, test, expect } from 'vitest';
import {
  findingsReportFile,
  integrityReportFile,
  measurementsToFindings,
  measurementsToReportManifest,
} from '../src/export/measurementReport';
import { verifyReportManifest } from '../src/render/measure/reportManifest';
import type { Measurement } from '../src/render/measure/types';
import type { Vec3 } from '../src/render/measure/types';

const up: Vec3 = [0, 0, 1];

function distance(id: string, len: number, name = ''): Measurement {
  return { id, kind: 'distance', name, points: [[0, 0, 0], [len, 0, 0]] };
}

/** A pure vertical measurement — rise only, so the vertical factor is isolated. */
function height(id: string, rise: number): Measurement {
  return { id, kind: 'height', name: '', points: [[0, 0, 0], [0, 0, rise]] };
}

/** A volume measurement, to pin the linear²·vertical cubic factor. */
function volume(id: string, net: number): Measurement {
  return {
    id, kind: 'volume', name: '',
    points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]],
    volume: { cut: 0, fill: net, net, footprintArea: 100 },
  } as unknown as Measurement;
}

describe('measurementReport', () => {
  test('a distance becomes a length finding in metres', () => {
    const f = measurementsToFindings([distance('m1', 3)], up, 1);
    expect(f).toHaveLength(1);
    expect(f[0].value).toBeCloseTo(3, 6);
    expect(f[0].unit).toBe('m');
    expect(f[0].label).toBe('distance 1');
  });

  test('a US-foot scan converts length to metres', () => {
    const f = measurementsToFindings([distance('m1', 10)], up, 0.3048);
    expect(f[0].value).toBeCloseTo(3.048, 4);
  });

  test('a named measurement keeps its label', () => {
    expect(measurementsToFindings([distance('m1', 2, 'Fence run')], up, 1)[0].label).toBe(
      'Fence run',
    );
  });

  test('builds a signed manifest that verifies and stamps provenance', () => {
    const manifest = measurementsToReportManifest([distance('m1', 5)], up, 1, {
      datasetId: 'site-a',
      crsName: 'EPSG:6433',
      generatedAt: '2026-06-27T00:00:00Z',
      classificationEpoch: 1,
    });
    expect(verifyReportManifest(manifest)).toBe(true);
    expect(manifest.classificationEpoch).toBe(1);
    expect(manifest.findings[0].unit).toBe('m');
    // Tampering a finding after the digest is stamped must break verification.
    expect(verifyReportManifest({ ...manifest, findings: [{ ...manifest.findings[0], value: 0 }] })).toBe(
      false,
    );
  });

  test('an incomplete measurement contributes no finding', () => {
    const incomplete: Measurement = { id: 'x', kind: 'distance', name: '', points: [[0, 0, 0]] };
    expect(measurementsToFindings([incomplete], up, 1)).toHaveLength(0);
  });
});


/**
 * A compound CRS — metre eastings over US-survey-foot heights — is where a
 * single scale factor stops being enough. The CSV, GeoJSON and KML exports all
 * take a separate vertical factor; the integrity report did not, so the SIGNED,
 * tamper-evident deliverable disagreed with the CSV of the same session about
 * the same measurement. Volume compounds it: the report scaled by linear³
 * rather than linear²·vertical.
 */
describe('measurementReport — compound CRS vertical factor', () => {
  const METRE = 1;
  const US_FOOT = 1200 / 3937;

  test('a height uses the VERTICAL factor, not the horizontal one', () => {
    const f = measurementsToFindings([height('h1', 100)], up, METRE, US_FOOT);
    // 100 native vertical units of US survey foot = 30.48006 m, rounded to the
    // 3 dp the metrics carry. The point is that it is NOT 100 — the horizontal
    // factor of 1 would have left it unscaled.
    expect(f[0].value).toBeCloseTo(30.48, 2);
  });

  test('a single-unit CRS is unchanged when no vertical factor is given', () => {
    // The default must keep every existing metric CRS byte-identical.
    expect(measurementsToFindings([height('h1', 100)], up, METRE)[0].value).toBeCloseTo(100, 6);
  });

  test('a volume scales by linear squared times vertical, not linear cubed', () => {
    const f = measurementsToFindings([volume('v1', 1000)], up, METRE, US_FOOT);
    // 1000 native (m²·ft) = 1000 × 1 × 1 × 0.3048006 = 304.80 m³.
    expect(Math.abs(f[0].value)).toBeCloseTo(304.8006, 3);
  });

  test('the manifest carries the same vertical-scaled value as the findings', () => {
    const manifest = measurementsToReportManifest([height('h1', 100)], up, METRE, {
      datasetId: 'd', generatedAt: '2026-01-01T00:00:00Z', classificationEpoch: 0,
    }, US_FOOT);
    expect(manifest.findings[0].value).toBeCloseTo(30.48, 2);
  });
});


// The caveat that qualifies every figure was computed onto the returned
// object's `evidence` field, and the only caller downloads `text`. So an
// unknown-unit scan's integrity report went out labelling source units as
// metres with nothing to the contrary anywhere in the document, while the
// CSV and GeoJSON for the SAME scan renamed their columns and carried the
// note. Moving it into the manifest also puts it under the digest.
describe('a report carries its own qualifications', () => {
  const args = (unitsVerified: boolean, crs: string | undefined) =>
    [[distance('m1', 5)], up, 1, 1, 'site-a', crs, '2026-06-27T00:00:00Z', 1, '0.7.0', unitsVerified] as const;

  test('an unverified unit scale is stated inside the downloaded file', () => {
    const f = integrityReportFile(...args(false, 'EPSG:6433'));
    const m = JSON.parse(f.text);
    expect(m.notes.join(' ')).toMatch(/units unverified/i);
    expect(m.notes.join(' ')).toMatch(/nominal/i);
    // And it is sealed, not decoration.
    expect(verifyReportManifest(m)).toBe(true);
  });

  test('a verified scale with a named CRS adds nothing', () => {
    const m = JSON.parse(integrityReportFile(...args(true, 'EPSG:6433')).text);
    expect(m.notes ?? []).toEqual([]);
  });

  test('an unresolved CRS says so rather than omitting the key', () => {
    const m = JSON.parse(integrityReportFile(...args(true, undefined)).text);
    expect(m.notes.join(' ')).toMatch(/no coordinate reference system/i);
  });

  test('stripping a note breaks the digest', () => {
    const m = JSON.parse(integrityReportFile(...args(false, undefined)).text);
    expect(verifyReportManifest({ ...m, notes: [] })).toBe(false);
  });

  test('the curated findings ledger carries them too', () => {
    const findings = measurementsToFindings([distance('m1', 5)], up, 1, 1);
    const m = JSON.parse(
      findingsReportFile(findings, 'site-a', undefined, '2026-06-27T00:00:00Z', 1, '0.7.0', false).text,
    );
    expect(m.notes.join(' ')).toMatch(/units unverified/i);
    expect(m.notes.join(' ')).toMatch(/no coordinate reference system/i);
  });
});

// Every other finding value is rounded to 3 dp by `measurementMetrics`; the
// volume branch multiplied the raw net by the cubic factor and pushed the
// full float, so one figure in the document implied ~1e-14 m³ resolution
// beside distances at 1 mm — on a number whose own caveat says the
// integration assumes uniform coverage.
describe('a volume finding is reported at the same precision as the rest', () => {
  test('is rounded to three decimals like every sibling', () => {
    // 1/3 m³ scaled by a foot factor: a value with no short decimal form.
    const f = measurementsToFindings([volume('v1', 1 / 3)], up, 0.3048, 0.3048);
    const v = f.find((x) => x.unit === 'm³');
    expect(v).toBeDefined();
    expect(String(v!.value)).toMatch(/^-?\d+(\.\d{1,3})?$/);
  });

  test('keeps the value it is rounding from', () => {
    const f = measurementsToFindings([volume('v1', 1 / 3)], up, 0.3048, 0.3048);
    const expected = (1 / 3) * 0.3048 * 0.3048 * 0.3048;
    expect(f.find((x) => x.unit === 'm³')!.value).toBeCloseTo(expected, 3);
  });
});

// a switched lasso record's finding is built from the grid figure, keeps
// the point-sample number as a labelled cross-check, and states the grid's
// known limitations rather than the point-sample-only caveat.
function gridVolume(id: string, over: Record<string, unknown> = {}): Measurement {
  return {
    id, kind: 'volume', name: '',
    points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]],
    volume: {
      fill: 100, cut: 5, net: 95, referenceZ: 0, footprintArea: 50,
      pointsInPolygon: 800, densityNative: 16, confidence: 'medium',
      method: 'olv.volume.stockpile-area-grid@3', gridAuthority: 'measured', gridAuthorityReason: '',
      crossCheck: { fill: 120, cut: 30, net: 90, method: 'olv.volume.stockpile@1' },
      ...over,
    },
  } as unknown as Measurement;
}

describe('a grid-canonical volume finding', () => {
  test('the headline is the grid net, not the point-sample net', () => {
    const f = measurementsToFindings([gridVolume('v1')], up, 1);
    expect(f).toHaveLength(1);
    expect(f[0].value).toBeCloseTo(95, 6);
  });

  test('names the point-sample cross-check as a labelled figure, not the headline', () => {
    const f = measurementsToFindings([gridVolume('v1')], up, 1);
    expect(f[0].caveats!.join(' ')).toMatch(/Point-sample cross-check.*cut 30\.00 m³ \/ fill 120\.00 m³/);
  });

  test('states the grid\'s known limitations (the step, clustered-sparse, and the real-data disagreement)', () => {
    const f = measurementsToFindings([gridVolume('v1')], up, 1);
    const text = f[0].caveats!.join(' ');
    expect(text).toMatch(/15%/);
    expect(text).toMatch(/PREVIEW/);
    expect(text).toMatch(/3\.6%/);
    expect(text).toMatch(/8\.6%/);
  });

  test('a preview record labels the finding PREVIEW with its reason', () => {
    const f = measurementsToFindings(
      [gridVolume('v1', { gridAuthority: 'preview', gridAuthorityReason: 'display sample' })],
      up, 1,
    );
    expect(f[0].caveats!.join(' ')).toMatch(/PREVIEW: display sample/);
  });

  test('a withheld record reports the cross-check net under a label that says the grid was withheld', () => {
    const withheld = gridVolume('v1', {
      fill: undefined, cut: undefined, net: undefined,
      gridAuthority: 'withheld', gridAuthorityReason: 'insufficient observations',
    });
    const f = measurementsToFindings([withheld], up, 1);
    expect(f).toHaveLength(1);
    expect(f[0].label).toMatch(/point-sample cross-check — grid volume withheld/);
    expect(f[0].value).toBeCloseTo(90, 6); // the cross-check's net, not a fabricated grid figure
    expect(f[0].caveats!.join(' ')).toMatch(/withheld \(insufficient observations/);
  });

  test('a withheld record with no cross-check contributes no finding at all', () => {
    const withheld = gridVolume('v1', {
      fill: undefined, cut: undefined, net: undefined, crossCheck: undefined,
      gridAuthority: 'withheld', gridAuthorityReason: 'insufficient observations',
    });
    expect(measurementsToFindings([withheld], up, 1)).toHaveLength(0);
  });

  test('an un-switched volume record is unaffected — no gridAuthority, no cross-check caveat', () => {
    const f = measurementsToFindings([volume('v1', 116)], up, 1);
    expect(f[0].caveats!.join(' ')).not.toMatch(/cross-check|PREVIEW|withheld/);
  });
});
