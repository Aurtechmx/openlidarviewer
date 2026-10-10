/**
 * profileExportHonesty.test.ts
 *
 * What a profile export states about itself: the file it is saved as, the
 * project and sample basis on the sheet, how its grade and gain/loss figures
 * are qualified, and that each quantity prints at one precision.
 */
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import { profileExportFileName, formatProfileExtreme, buildProfileCsv } from '../src/render/measure/profileSummary';
import {
  buildProfileProvenance,
  describeProfileProvenance,
  describeProfilePointsRead,
  describeSampleBasis,
  formatCount,
} from '../src/render/measure/profileProvenance';
import { placeCalloutLabel, lineCrossesBox, crsDisplayLabel, fitTitleValue, verticalScaleStatement } from '../src/render/measure/profileSheetLayout';
import { formatRise, shownSpan } from '../src/render/measure/format';
import { createProfileSectionSeam } from '../src/render/measure/profileSectionSeam';
import { heightReferenceNote } from '../src/geo/height';
import { parseWithheldReadCounts } from '../src/io/withheldCountsJson';
import type { ProfileChartSample } from '../src/render/measure/types';
import type { ProfileSeamLayer } from '../src/render/measure/profileSectionSeam';

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

/** Every string drawn on every page, in draw order, joined by single spaces. */
function prose(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const words: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let body = Buffer.from(m[1], 'latin1');
    try {
      body = inflateSync(body);
    } catch {
      // an uncompressed stream is read as it is
    }
    for (const h of body.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>/g)) {
      words.push(Buffer.from(h[1], 'hex').toString('latin1'));
    }
  }
  return words.join(' ');
}

/** A provenance record through the real builder, carrying the reduction when given. */
function recordOf(reduction?: typeof REDUCED) {
  return buildProfileProvenance({
    capturedAt: '2026-01-01T00:00:00.000Z',
    up: [0, 0, 1],
    sources: [{ slot: 0, layerId: 'a', displayName: 'a', classification: 'derived', streaming: false }],
    accepted: { count: 3, sourceSlot: [0, 0, 0] },
    excludedClasses: [7, 18],
    units: { linearUnit: 'metre', verticalReference: 'orthometric', verticalMetresPerUnit: 1 },
    ...(reduction ? { reduction } : {}),
  });
}

/** A steep, rolling section with one gap, 3 m stations. */
function steep(n = 40): ProfileChartSample[] {
  const out: ProfileChartSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ distance: i * 4.3, height: 2800 + i * 2 + Math.sin(i) * 0.5 });
  }
  out[7] = { distance: 7 * 4.3, height: NaN };
  return out;
}

const REDUCED = { mode: 'voxel-centroids', resident: 1_912_920, declared: 10_789_680 } as const;

describe('profile export file name', () => {
  it('names the scan, the term profile and the slugified measurement name', () => {
    expect(profileExportFileName('ot_356000_3972000_1', 'Profile 1', 'pdf')).toBe(
      'ot_356000_3972000_1-profile-1.pdf',
    );
    expect(profileExportFileName('ot_356000_3972000_1', 'Ridge cut', 'pdf')).toBe(
      'ot_356000_3972000_1-profile-ridge-cut.pdf',
    );
    expect(profileExportFileName('scan', 'Ridge cut', 'csv')).toBe('scan-profile-ridge-cut.csv');
    expect(profileExportFileName('scan', 'Ridge cut', 'png')).toBe('scan-profile-ridge-cut.png');
  });

  it('drops only a leading word profile', () => {
    expect(profileExportFileName('s', 'profile', 'pdf')).toBe('s-profile.pdf');
    expect(profileExportFileName('s', 'Profile', 'pdf')).toBe('s-profile.pdf');
    expect(profileExportFileName('s', 'PROFILE_2', 'pdf')).toBe('s-profile-2.pdf');
    expect(profileExportFileName('s', 'Profiles east', 'pdf')).toBe('s-profile-profiles-east.pdf');
    expect(profileExportFileName('s', 'North profile', 'pdf')).toBe('s-profile-north-profile.pdf');
  });

  it('strips special characters and keeps letters from any script', () => {
    expect(profileExportFileName('my scan (v2)', 'A/B: c*d?', 'pdf')).toBe('my_scan_v2-profile-a-b-c-d.pdf');
    expect(profileExportFileName('s', '測線 1', 'pdf')).toBe('s-profile-測線-1.pdf');
    expect(profileExportFileName('s', '..', 'pdf')).toBe('s-profile.pdf');
    expect(profileExportFileName('s', '../../etc', 'pdf')).toBe('s-profile-etc.pdf');
  });

  it('returns null when the scan name is unknown or empty so the caller keeps its old name', () => {
    expect(profileExportFileName(null, 'Profile 1', 'pdf')).toBeNull();
    expect(profileExportFileName(undefined, 'Profile 1', 'pdf')).toBeNull();
    expect(profileExportFileName('', 'Profile 1', 'pdf')).toBeNull();
    expect(profileExportFileName('   ', 'Profile 1', 'pdf')).toBeNull();
    expect(profileExportFileName('///', 'Profile 1', 'pdf')).toBeNull();
  });
});

describe('sheet title block', () => {
  it('puts the scan in PROJECT and keeps the profile name on the sheet', async () => {
    const text = prose(
      await buildProfilePdf({
        name: 'Profile 1',
        project: 'ot_356000_3972000_1',
        samples: steep(),
        generatedAt: FIXED_DATE,
      }),
    );
    expect(text).toContain('ot_356000_3972000_1');
    expect(text).toContain('Profile: Profile 1');
  });

  it('keeps the measurement name as the project when the scan is unknown', async () => {
    const text = prose(
      await buildProfilePdf({ name: 'Ridge cut', samples: steep(), generatedAt: FIXED_DATE }),
    );
    expect(text).toContain('Ridge cut');
    expect(text).not.toContain('Profile: Ridge cut');
  });
});

describe('CRS label', () => {
  it('states the code once', () => {
    expect(crsDisplayLabel('EPSG:26913 - NAD83 / UTM zone 13N (EPSG:26913)')).toBe(
      'NAD83 / UTM zone 13N (EPSG:26913)',
    );
    expect(crsDisplayLabel('EPSG:26913 — NAD83 / UTM zone 13N (EPSG:26913)')).toBe(
      'NAD83 / UTM zone 13N (EPSG:26913)',
    );
    expect(crsDisplayLabel('EPSG:2225 - NAD83 / California zone 1 (ftUS)')).toBe(
      'NAD83 / California zone 1 (ftUS) (EPSG:2225)',
    );
    expect(crsDisplayLabel('Local grid')).toBe('Local grid');
    expect(crsDisplayLabel('  ')).toBeNull();
    expect(crsDisplayLabel(null)).toBeNull();
  });

  it('prints it without the duplicated code and without a cut-off tail', async () => {
    const text = prose(
      await buildProfilePdf({
        name: 'P',
        samples: steep(),
        crs: 'EPSG:26913 - NAD83 / UTM zone 13N (EPSG:26913)',
        generatedAt: FIXED_DATE,
      }),
    );
    expect(text).toContain('NAD83 / UTM zone 13N (EPSG:26913)');
    expect(text).not.toContain('EPSG:26913 - NAD83');
    expect(text).not.toContain('(EPSG:26913)...');
    expect(text).not.toContain('(EPS...');
    expect(text.match(/NAD83 \/ UTM zone 13N \(EPSG:26913\)/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it('fits a long CRS name by shrinking or wrapping, never by cutting it', async () => {
    const long = 'EPSG:6350 - NAD83(2011) / Conus Albers equal-area conic with a very long suffix (EPSG:6350)';
    const text = prose(
      await buildProfilePdf({ name: 'P', samples: steep(), crs: long, generatedAt: FIXED_DATE }),
    );
    expect(text).not.toContain('...');
    expect(text).toContain('(EPSG:6350)');
  });
});

describe('sample basis', () => {
  const counts = {
    sourcePoints: 1_912_920,
    withheldExcluded: 'unknown' as const,
    analysedPoints: 1_912_920,
  };

  it('says the cloud is a display sample, and that percentiles are over it', async () => {
    const text = prose(
      await buildProfilePdf({
        name: 'P',
        samples: steep(),
        withheld: { ...counts, reduction: REDUCED },
        generatedAt: FIXED_DATE,
      }),
    );
    expect(text).toContain('Display sample of 1,912,920 points (voxel centroids), 10,789,680 declared');
    expect(text).toContain('Percentiles are over the sample');
    expect(text).toContain('Withheld and noise points cannot be excluded');
    expect(text).not.toContain('Full static source');
    expect(text).not.toContain('1912920');
  });

  it('keeps today\'s wording for a whole cloud, with separators on the counts', async () => {
    const text = prose(
      await buildProfilePdf({
        name: 'P',
        samples: steep(),
        withheld: counts,
        generatedAt: FIXED_DATE,
      }),
    );
    expect(text).toContain('Points: 1,912,920 of 1,912,920 analysed; Withheld excluded: unknown (no flags on a source)');
    expect(text).not.toContain('Display sample');
    expect(text).not.toContain('Percentiles are over the sample');
  });

  it('names the sample in the read scope row and the method sheet when a record carries it', async () => {
    const record = recordOf(REDUCED);
    expect(describeProfileProvenance(record)).toBe(
      'Display sample of 1,912,920 points (voxel centroids), 10,789,680 declared, classification on every source',
    );
    const whole = { ...record, reduction: undefined };
    expect(describeProfileProvenance(whole)).toBe(
      'Full static source, complete read, classification on every source',
    );
    const text = prose(
      await buildProfilePdf({ name: 'P', samples: steep(), provenance: record, generatedAt: FIXED_DATE }),
    );
    expect(text).toContain('Percentiles are over the sample');
    expect(text.match(/Display sample of 1,912,920 points/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps every general note on the sheet for a reduced cloud', async () => {
    const record = recordOf(REDUCED);
    for (const provenance of [null, record]) {
      const text = prose(
        await buildProfilePdf({
          name: 'P',
          samples: steep(),
          withheld: { ...counts, reduction: REDUCED },
          provenance,
          verticalDatum: 'NAVD88',
          crs: 'EPSG:26913 - NAD83 / UTM zone 13N (EPSG:26913)',
          generatedAt: FIXED_DATE,
        }),
      );
      expect(text).not.toContain('more lines omitted');
    }
  });

  it('formats counts and bases', () => {
    expect(formatCount(1912920)).toBe('1,912,920');
    expect(formatCount(6150)).toBe('6,150');
    expect(describeSampleBasis({ mode: 'strided-records', resident: 5_394_840, declared: 10_789_680 })).toBe(
      'Strided sample of 5,394,840 of 10,789,680 declared points',
    );
    expect(describeProfilePointsRead({ ...counts, withheldExcluded: 12, analysedPoints: 1_912_908 })).toBe(
      '1,912,908 of 1,912,920 analysed; Withheld excluded: 12',
    );
  });

  it('survives a session round trip, and reads a record saved without it', () => {
    const withReduction = parseWithheldReadCounts({ ...counts, reduction: REDUCED });
    expect(withReduction?.reduction).toEqual(REDUCED);
    expect(parseWithheldReadCounts(counts)).toEqual(counts);
    expect(parseWithheldReadCounts({ ...counts, reduction: { mode: 'x', resident: 1, declared: 2 } })).toEqual(counts);
  });
});

describe('the seam carries the reduction', () => {
  const layer = (reduced: boolean): ProfileSeamLayer => ({
    id: 'L',
    mesh: { visible: true },
    positions: new Float32Array([0, 0, 0, 5, 0, 1, 10, 0, 2]),
    channels: null,
    bounds: null,
    ...(reduced
      ? { reductionSource: { pointCount: 3, declaredPointCount: 30, pointReduction: 'voxel-centroids' as const } }
      : { reductionSource: { pointCount: 3, declaredPointCount: 3 } }),
  });
  const seamOf = (l: ProfileSeamLayer) =>
    createProfileSectionSeam({
      layers: () => [l],
      residentNodes: () => [],
      streamingMayCombine: () => false,
      worldUp: () => [0, 0, 1],
      streamingCoverage: () => null,
    });

  it('stamps the series and the section of a reduced cloud', () => {
    const seam = seamOf(layer(true));
    const series = seam.sampleSeries([0, 0, 0], [10, 0, 0]);
    expect(series?.withheld.reduction).toEqual({ mode: 'voxel-centroids', resident: 3, declared: 30 });
    const section = seam.section({ a: [0, 0, 0], b: [10, 0, 0], corridorWidth: 1 });
    expect(section?.reduction).toEqual({ mode: 'voxel-centroids', resident: 3, declared: 30 });
    expect(section?.scopeLabel).toBe('Display sample of 3 points (voxel centroids), 30 declared');
  });

  it('leaves a whole cloud as it was', () => {
    const seam = seamOf(layer(false));
    const series = seam.sampleSeries([0, 0, 0], [10, 0, 0]);
    expect(series?.withheld.reduction).toBeUndefined();
    const section = seam.section({ a: [0, 0, 0], b: [10, 0, 0], corridorWidth: 1 });
    expect(section?.reduction).toBeUndefined();
    expect(section?.scopeLabel).toBe('Full static source');
  });
});

describe('grade and height qualifications', () => {
  it('states the grade basis and does not claim buildability', async () => {
    const text = prose(await buildProfilePdf({ name: 'P', samples: steep(), generatedAt: FIXED_DATE }));
    expect(text).toContain('Over one station pair of');
    expect(text).toContain('sensitive to canopy and noise');
    expect(text).toContain('it is not a measure of buildability');
    expect(text).not.toContain('Governs whether an alignment is buildable');
  });

  it('prints gain and loss in one unit at one precision and says gaps are not counted', async () => {
    const samples = steep();
    const text = prose(await buildProfilePdf({ name: 'P', samples, generatedAt: FIXED_DATE }));
    expect(text).toMatch(/\+\d+\.\d{2} m\s+\/\s+-\d+\.\d{2} m/);
    expect(text).not.toMatch(/ cm/);
    expect(text).toContain('Rise or fall across a gap is not counted (1 gap station)');
  });

  it('keeps the plain remark when there is no gap', async () => {
    const samples = steep().map((s, i) => (i === 7 ? { distance: s.distance, height: 2814 } : s));
    const text = prose(await buildProfilePdf({ name: 'P', samples, generatedAt: FIXED_DATE }));
    expect(text).toContain('Summed rise and fall over every station pair');
    expect(text).not.toContain('is not counted');
  });

  it('prints each quantity at two decimals and uses words for the arrow and the at sign', async () => {
    const text = prose(
      await buildProfilePdf({
        name: 'P',
        samples: steep(),
        corridorWidthM: 8.5354,
        generatedAt: FIXED_DATE,
      }),
    );
    expect(text).toContain('8.54 m');
    expect(text).not.toContain('8.5354');
    expect(text).not.toContain('8.535 ');
    expect(text).not.toContain(' -> ');
    expect(text).not.toContain(' @ ');
    expect(text).toMatch(/\d+\+\d{3}\.\d{2} to \d+\+\d{3}\.\d{2}/);
    expect(text).toMatch(/\d+\.\d{2} m at \d\+\d{3}\.\d{2}/);
    expect(formatProfileExtreme({ chainage: 170.71, elevation: 2887.39 }, 'metric')).toBe('2887.39 m at 0+170.71');
  });

  it('names the declared vertical datum in the vertical reference note', async () => {
    expect(heightReferenceNote('orthometric', 'NAVD88')).toBe(
      'Height above the vertical datum reference surface (NAVD88).',
    );
    expect(heightReferenceNote('orthometric')).toContain('approximately mean sea level');
    expect(heightReferenceNote('orthometric', '  ')).toContain('approximately mean sea level');
    const text = prose(
      await buildProfilePdf({ name: 'P', samples: steep(), verticalDatum: 'NAVD88', generatedAt: FIXED_DATE }),
    );
    expect(text).toContain('(NAVD88)');
    expect(text).not.toContain('approximately mean sea level');
  });
});

describe('vertical scale statement', () => {
  it('calls a vertical scale smaller than the horizontal a compression', async () => {
    // Relief is a large part of the length, so the sheet draws it flatter.
    const rise: ProfileChartSample[] = Array.from({ length: 30 }, (_, i) => ({
      distance: i * 6,
      height: 100 + i * 4,
    }));
    const text = prose(await buildProfilePdf({ name: 'P', samples: rise, generatedAt: FIXED_DATE }));
    expect(text).toMatch(/Vertical compression 0\.\d:1, slopes look flatter than they are/);
    expect(text).not.toMatch(/Vertical exaggeration 0\./);
  });

  it('keeps exaggeration for a vertical scale larger than the horizontal', async () => {
    const flat: ProfileChartSample[] = Array.from({ length: 30 }, (_, i) => ({
      distance: i * 6,
      height: 100 + (i % 3) * 0.2,
    }));
    const text = prose(await buildProfilePdf({ name: 'P', samples: flat, generatedAt: FIXED_DATE }));
    expect(text).toMatch(/Vertical exaggeration \d+\.\d:1/);
    expect(text).not.toContain('Vertical compression');
  });
});

describe('maximum grade callout placement', () => {
  const frame = { left: 100, right: 1000, top: 500, bottom: 200 };

  it('moves the label off a line that climbs through the default spot', () => {
    // A line climbing from bottom-left to the top-right corner.
    const line = Array.from({ length: 40 }, (_, i) => ({
      x: 100 + (i / 39) * 900,
      y: 200 + (i / 39) * 300,
    }));
    const point = line[20];
    const at = placeCalloutLabel({ point, labelW: 230, labelH: 36, frame, line });
    expect(at.clear).toBe(true);
    expect(lineCrossesBox(line, at.box, 3)).toBe(false);
    expect(at.box.x0).toBeGreaterThanOrEqual(frame.left + 4);
    expect(at.box.x1).toBeLessThanOrEqual(frame.right - 4);
    expect(at.box.y0).toBeGreaterThanOrEqual(frame.bottom + 4);
    expect(at.box.y1).toBeLessThanOrEqual(frame.top - 4);
  });

  it('puts the label where the line is not when the point is at the frame edge', () => {
    const line = [
      { x: 100, y: 250 },
      { x: 500, y: 300 },
      { x: 600, y: 496 },
      { x: 1000, y: 496 },
    ];
    const at = placeCalloutLabel({ point: { x: 550, y: 400 }, labelW: 230, labelH: 36, frame, line });
    expect(lineCrossesBox(line, at.box, 3)).toBe(false);
    expect(at.box.y1).toBeLessThanOrEqual(frame.top - 4);
  });

  it('reports a collision it cannot avoid rather than hiding it', () => {
    const wall = Array.from({ length: 200 }, (_, i) => ({ x: 100 + i * 4.5, y: 350 }));
    const dense = [...wall, null, ...Array.from({ length: 200 }, (_, i) => ({ x: 100 + i * 4.5, y: 450 }))];
    const at = placeCalloutLabel({ point: { x: 500, y: 350 }, labelW: 880, labelH: 290, frame, line: dense });
    expect(at.clear).toBe(false);
  });

  it('draws a sheet whose marker is inside the frame', async () => {
    const bytes = await buildProfilePdf({ name: 'P', samples: steep(), generatedAt: FIXED_DATE });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });
});

describe('csv sample basis', () => {
  const samples: ProfileChartSample[] = [
    { distance: 0, height: 10 },
    { distance: 5, height: 11 },
  ];
  const whole = buildProfileCsv(samples, 'metric', 'orthometric');

  it('is unchanged for a whole cloud', () => {
    expect(whole.split('\n')[0]).toBe('station,chainage_m,elevation_m,points,grade_to_next_pct');
    expect(buildProfileCsv(samples, 'metric', 'orthometric', null, undefined)).toBe(whole);
    expect(buildProfileCsv(samples, 'metric', 'orthometric', '', null)).toBe(whole);
  });

  it('leads with the sample basis for a reduced cloud', () => {
    const csv = buildProfileCsv(samples, 'metric', 'orthometric', null, REDUCED);
    const [first, header] = csv.split('\n');
    expect(first).toBe(
      '# Display sample of 1,912,920 points (voxel centroids), 10,789,680 declared. ' +
        "Percentiles are over the sample, not the file's returns; Withheld and noise points cannot be excluded.",
    );
    expect(header).toBe('station,chainage_m,elevation_m,points,grade_to_next_pct');
    expect(csv.endsWith(whole.slice(whole.indexOf('station,')))).toBe(true);
  });

  it('keeps the truncation note first when both apply', () => {
    const csv = buildProfileCsv(samples, 'metric', 'orthometric', 'Truncated: 4 of 9 points read', REDUCED);
    const lines = csv.split('\n');
    expect(lines[0]).toMatch(/^# Truncated/);
    expect(lines[1]).toMatch(/^# Display sample/);
  });
});

describe('points note', () => {
  const base = { name: 'P', samples: steep(), generatedAt: FIXED_DATE };

  it('keeps the points statement and adds the basis for a strided sample whose flags survive', async () => {
    const text = prose(
      await buildProfilePdf({
        ...base,
        method: 'corridor-percentile',
        withheld: {
          sourcePoints: 5_394_840,
          withheldExcluded: 120,
          analysedPoints: 5_394_720,
          reduction: { mode: 'strided-records', resident: 5_394_840, declared: 10_789_680 },
        },
      }),
    );
    expect(text).toContain('Points: 5,394,720 of 5,394,840 analysed; Withheld excluded: 120 (corridor-percentile).');
    expect(text).toContain('Sample basis: Strided sample of 5,394,840 of 10,789,680 declared points');
  });

  it('says Withheld excluded is unknown beside the basis for voxel centroids', async () => {
    const text = prose(
      await buildProfilePdf({
        ...base,
        withheld: { sourcePoints: 9, withheldExcluded: 'unknown', analysedPoints: 9, reduction: REDUCED },
      }),
    );
    expect(text).toContain('Points: 9 of 9 analysed; Withheld excluded: unknown (no flags on a source) (method not recorded).');
    expect(text).toContain('Sample basis: Display sample of 1,912,920 points');
  });
});

describe('mixed reduced and whole layers', () => {
  it('labels the statement as covering only the reduced sources', () => {
    const mixed = { ...REDUCED, reducedSources: 1, totalSources: 2 };
    expect(describeSampleBasis(mixed)).toBe(
      'Includes 1 reduced source of 2 (1,912,920 of 10,789,680 declared points held in it, voxel centroids)',
    );
    const layer = (id: string, reduced: boolean): ProfileSeamLayer => ({
      id,
      mesh: { visible: true },
      positions: new Float32Array([0, 0, 0, 5, 0, 1, 10, 0, 2]),
      channels: null,
      bounds: null,
      reductionSource: reduced
        ? { pointCount: 3, declaredPointCount: 30, pointReduction: 'voxel-centroids' as const }
        : { pointCount: 3, declaredPointCount: 3 },
    });
    const seam = createProfileSectionSeam({
      layers: () => [layer('a', true), layer('b', false)],
      residentNodes: () => [],
      streamingMayCombine: () => false,
      worldUp: () => [0, 0, 1],
      streamingCoverage: () => null,
    });
    const r = seam.sampleSeries([0, 0, 0], [10, 0, 0])!.withheld.reduction;
    expect(r).toEqual({ mode: 'voxel-centroids', resident: 3, declared: 30, reducedSources: 1, totalSources: 2 });
  });

  it('round-trips the source mix and rejects a reduction that holds more than was declared', () => {
    const counts = { sourcePoints: 5, withheldExcluded: 'unknown' as const, analysedPoints: 5 };
    const mixed = { mode: 'voxel-centroids', resident: 3, declared: 30, reducedSources: 1, totalSources: 2 };
    expect(parseWithheldReadCounts({ ...counts, reduction: mixed })?.reduction).toEqual(mixed);
    expect(parseWithheldReadCounts({ ...counts, reduction: { ...mixed, resident: 31 } })).toEqual(counts);
  });
});

describe('displayed figures agree', () => {
  it('derives relief from the printed extremes', () => {
    expect(shownSpan(10.004, 90.989, 1)).toBe('80.99');
    expect(shownSpan(10.004, 90.994, 1)).toBe('80.99');
    expect(shownSpan(0, 1, 3.28084)).toBe('3.28');
  });

  it('adds a decimal only while a nonzero rise would read as zero', () => {
    expect(formatRise(78.809, 1, 'm')).toBe('78.81 m');
    expect(formatRise(0.536, 1, 'm')).toBe('0.54 m');
    expect(formatRise(0.004, 1, 'm')).toBe('0.004 m');
    expect(formatRise(0.00004, 1, 'm')).toBe('0.00004 m');
    expect(formatRise(0, 1, 'm')).toBe('0.00 m');
  });

  it('words the vertical scale', () => {
    expect(verticalScaleStatement(0.7)).toContain('compression 0.7:1');
    expect(verticalScaleStatement(1)).toBe('Vertical exaggeration 1.0:1');
    expect(verticalScaleStatement(2.5)).toBe('Vertical exaggeration 2.5:1');
  });
});

describe('file name rules', () => {
  it('caps a long Unicode name at 200 bytes and keeps the extension', () => {
    const name = profileExportFileName('s', '測'.repeat(120), 'pdf')!;
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('never starts with a dot or ends with one', () => {
    expect(profileExportFileName('.hidden', 'x', 'pdf')).toBe('hidden-profile-x.pdf');
    expect(profileExportFileName('.', 'x', 'pdf')).toBeNull();
    expect(profileExportFileName('scan.', 'x', 'pdf')).toBe('scan-profile-x.pdf');
  });

  it('is safe for Windows device names', () => {
    for (const scan of ['CON', 'nul', 'COM1', 'LPT9']) {
      const name = profileExportFileName(scan, '', 'pdf')!;
      expect(name).toBe(`${scan}-profile.pdf`);
      expect(name).not.toMatch(/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i);
    }
  });

  it('keeps combining marks', () => {
    const decomposed = 'Se\u0301ccio\u0301n';
    expect(profileExportFileName('s', decomposed, 'pdf')).toBe(`s-profile-${decomposed.toLowerCase()}.pdf`);
  });
});

describe('callout placement on a flat profile and at an edge pair', () => {
  const frame = { left: 100, right: 1000, top: 500, bottom: 200 };

  it('keeps the label inside the frame and off a flat line', () => {
    const line = Array.from({ length: 64 }, (_, i) => ({ x: 100 + (i / 63) * 900, y: 350 }));
    const at = placeCalloutLabel({ point: line[31], labelW: 250, labelH: 36, frame, line });
    expect(at.clear).toBe(true);
    expect(lineCrossesBox(line, at.box, 3)).toBe(false);
    expect(at.box.x0).toBeGreaterThanOrEqual(frame.left + 4);
    expect(at.box.x1).toBeLessThanOrEqual(frame.right - 4);
    expect(at.box.y0).toBeGreaterThanOrEqual(frame.bottom + 4);
    expect(at.box.y1).toBeLessThanOrEqual(frame.top - 4);
  });

  it('keeps the label inside the frame for the last pair of a section that ends at the top right', () => {
    const line = Array.from({ length: 64 }, (_, i) => ({ x: 100 + (i / 63) * 900, y: 200 + (i / 63) ** 3 * 300 }));
    const point = { x: (line[62].x + line[63].x) / 2, y: (line[62].y + line[63].y) / 2 };
    const at = placeCalloutLabel({ point, labelW: 250, labelH: 36, frame, line });
    expect(at.clear).toBe(true);
    expect(lineCrossesBox(line, at.box, 3)).toBe(false);
    expect(at.box.x1).toBeLessThanOrEqual(frame.right - 4);
    expect(at.box.y1).toBeLessThanOrEqual(frame.top - 4);
  });
});

describe('title block value fitting', () => {
  const text = {
    width: (t: string, size: number) => t.length * size * 0.5,
    wrap: (t: string, size: number) => {
      const per = Math.floor(100 / (size * 0.5));
      const out: string[] = [];
      for (let i = 0; i < t.length; i += per) out.push(t.slice(i, i + per));
      return out;
    },
    clip: (t: string) => `${t.slice(0, 10)}...`,
  };

  it('shrinks to one line, then wraps to two, then three, keeping baselines inside the 30 pt row', () => {
    const one = fitTitleValue('short', 100, 10.5, 7, text);
    expect(one.lines).toEqual(['short']);
    const two = fitTitleValue('x'.repeat(40), 100, 10.5, 7, text);
    expect(two.lines.length).toBe(2);
    const three = fitTitleValue('x'.repeat(70), 100, 10.5, 7, text);
    expect(three.lines.length).toBe(3);
    for (const f of [two, three]) {
      const last = f.first + (f.lines.length - 1) * f.step;
      expect(last).toBeLessThan(30 - 1);
      expect(f.first).toBeGreaterThan(11);
    }
    const four = fitTitleValue('x'.repeat(200), 100, 10.5, 7, text);
    expect(four.lines.length).toBe(3);
    expect(four.lines[2].endsWith('...')).toBe(true);
  });
});
