/**
 * volumeReducedCloudExclusion.test.ts: a volume measured on a reduced cloud
 * keeps ASPRS noise (7, 18) and Withheld points out where the labels are the
 * original records' own, and says plainly when they are not. A voxel centroid
 * carries the first member's class and no flags, so a volume over centroids
 * records that noise and Withheld exclusion was unavailable, with the reduction
 * mode and the resident and declared counts.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { installFakeDom } from './support/measurePanelDom';

import { PointCloud } from '../src/model/PointCloud';
import { voxelDownsample, downsampleToBudget } from '../src/process/voxelDownsample';
import { gatherVolumeBuffers, samplePolygonVolume } from '../src/render/measure/polygonVolumeSample';
import { computeLassoVolume, type LassoVolumeHost } from '../src/render/measure/lassoVolumeCompute';
import { cloudReduction } from '../src/render/measure/volumeReduction';
import { reducedSampleCaveat, reducedSampleClause } from '../src/render/measure/types';
import { withheldClause } from '../src/render/measure/stockpileResult';
import { measurementsToCsv, measurementsToGeoJSON } from '../src/export/measurementExport';
import { integrityReportFile, measurementsToFindings } from '../src/export/measurementReport';
import { buildKml } from '../src/export/kmlExport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { parseSession, serializeSession } from '../src/io/session';
import { encodeExtendedClassificationFlags } from '../src/lasSemantics';
import type { Measurement, Vec3 } from '../src/render/measure/types';

beforeAll(() => {
  installFakeDom({ ns: true });
});

const UP: Vec3 = [0, 0, 1];
const POLY: Vec3[] = [[0, 0, 0], [8, 0, 0], [8, 8, 0], [0, 8, 0]];
const WITHHELD = encodeExtendedClassificationFlags({ withheld: true });

/** 400 points on a 20 x 20 grid over 8 x 8: 300 at height 1, 100 of class 7 at height 100. */
function reproduction(): { positions: Float32Array; classification: Uint8Array } {
  const positions = new Float32Array(400 * 3);
  const classification = new Uint8Array(400).fill(2);
  for (let i = 0; i < 400; i++) {
    const x = 0.2 + (i % 20) * 0.4;
    const y = 0.2 + Math.floor(i / 20) * 0.4;
    const noisy = i % 4 === 0;
    positions.set([x, y, noisy ? 100 : 1], i * 3);
    if (noisy) classification[i] = 7;
  }
  return { positions, classification };
}

const strided = (g: ReturnType<typeof reproduction>) => ({
  cloud: { positions: g.positions, classification: g.classification, pointCount: 400, declaredPointCount: 10_000 },
});
const voxel = (g: ReturnType<typeof reproduction>) => ({
  cloud: {
    positions: g.positions, classification: g.classification, pointCount: 400, declaredPointCount: 10_000,
    pointReduction: 'voxel-centroids' as const,
  },
});
const whole = (g: ReturnType<typeof reproduction>) => ({
  cloud: { positions: g.positions, classification: g.classification, pointCount: 400, declaredPointCount: 400 },
});

function polygonRecord(src: { cloud: Parameters<typeof cloudReduction>[0] & { positions: Float32Array; classification: Uint8Array } }[]) {
  const out = gatherVolumeBuffers(src, () => [], (c) => cloudReduction(c));
  return samplePolygonVolume(out.buffers, out.total, POLY, 0, UP, out.reductions);
}

describe('cloudReduction', () => {
  it('reports nothing for a whole cloud and for a count within 5%', () => {
    expect(cloudReduction({ pointCount: 400, declaredPointCount: 400 })).toBeUndefined();
    expect(cloudReduction({ pointCount: 390, declaredPointCount: 400 })).toBeUndefined();
    expect(cloudReduction({ pointCount: 400 })).toBeUndefined();
  });

  it('reports a stride as strided records and a voxel cloud as centroids', () => {
    expect(cloudReduction({ pointCount: 400, declaredPointCount: 10_000 })).toEqual({
      mode: 'strided-records', resident: 400, declared: 10_000,
    });
    expect(cloudReduction({ pointCount: 400, declaredPointCount: 10_000, pointReduction: 'voxel-centroids' })).toEqual({
      mode: 'voxel-centroids', resident: 400, declared: 10_000,
    });
    // A voxel reduction counts whatever the declared count says.
    expect(cloudReduction({ pointCount: 400, pointReduction: 'voxel-centroids', decodedPointCount: 900 })?.declared).toBe(900);
  });

  it('a voxel pass marks its output; a cloud inside the budget is returned untouched', () => {
    const positions = Float32Array.from([0, 0, 0, 0.1, 0, 0, 5, 5, 0]);
    const cloud = new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 'a.las' });
    expect(voxelDownsample(cloud, 1).pointReduction).toBe('voxel-centroids');
    expect(downsampleToBudget(cloud, 10)).toBe(cloud);
    expect(downsampleToBudget(cloud, 10).pointReduction).toBeUndefined();
  });

  it('a voxel centroid keeps only the first member class, so a mostly-noise voxel reads as ground', () => {
    const positions = Float32Array.from([0, 0, 1, 0.1, 0.1, 9, 0.2, 0.2, 9, 0.3, 0.3, 9]);
    const classification = Uint8Array.from([2, 7, 7, 18]);
    const cloud = new PointCloud({ positions, classification, origin: [0, 0, 0], sourceFormat: 'las', name: 'm.las' });
    const out = voxelDownsample(cloud, 10);
    expect(out.pointCount).toBe(1);
    expect(Array.from(out.classification ?? [])).toEqual([2]);
    expect(out.classificationFlags).toBeUndefined();
    expect(cloudReduction(out)?.mode).toBe('voxel-centroids');
    // Volume over that centroid cannot claim a noise count.
    const rec = polygonRecord([{ cloud: { ...out, positions: out.positions, classification: out.classification! } as never }]);
    expect(rec.withheld?.exclusionUnavailable).toBe('reduced-sample');
    expect(rec.withheld?.noiseExcluded).toBeUndefined();
  });
});

describe('polygon volume on a reduced cloud', () => {
  const g = reproduction();

  it('a whole cloud and a stride of original records both exclude the noise', () => {
    for (const src of [whole(g), strided(g)]) {
      const rec = polygonRecord([src as never]);
      expect(rec.fill).toBeCloseTo(64, 6);
      expect(rec.withheld?.noiseExcluded).toBe(100);
      expect(rec.withheld?.exclusionUnavailable).toBeUndefined();
    }
  });

  it('a whole cloud records no reduction at all', () => {
    const rec = polygonRecord([whole(g) as never]);
    expect(rec.withheld?.reduction).toBeUndefined();
    expect(Object.keys(rec.withheld ?? {})).not.toContain('exclusionUnavailable');
  });

  it('a stride records its mode and counts without calling the exclusion unavailable', () => {
    const rec = polygonRecord([strided(g) as never]);
    expect(rec.withheld?.reduction).toEqual({ mode: 'strided-records', resident: 400, declared: 10_000 });
  });

  it('voxel centroids do not return the unfiltered figure as if it were filtered', () => {
    const rec = polygonRecord([voxel(g) as never]);
    const filtered = polygonRecord([strided(g) as never]);
    // The labels cannot be used, so the figure is the unfiltered 1648 (25.75x) ...
    expect(rec.fill).toBeCloseTo(1648, 4);
    expect((rec.fill as number) / (filtered.fill as number)).toBeCloseTo(25.75, 6);
    // ... and the record says so, with no exclusion count and no invented zero.
    expect(rec.withheld?.exclusionUnavailable).toBe('reduced-sample');
    expect(rec.withheld?.excluded).toBe('unknown');
    expect('noiseExcluded' in (rec.withheld ?? {})).toBe(false);
    expect(rec.withheld?.reduction).toEqual({ mode: 'voxel-centroids', resident: 400, declared: 10_000 });
  });

  it('a mixed walk filters the original source, marks the voxel one, and sums the reductions', () => {
    const rec = polygonRecord([strided(g) as never, voxel(g) as never]);
    expect(rec.withheld?.noiseExcluded).toBe(100);
    expect(rec.withheld?.exclusionUnavailable).toBe('reduced-sample');
    expect(rec.withheld?.excluded).toBe('unknown');
    expect(rec.withheld?.reduction).toEqual({ mode: 'voxel-centroids', resident: 800, declared: 20_000 });
  });
});

describe('lasso volume on a reduced cloud', () => {
  const g = reproduction();
  const lasso = [{ x: -1, y: -1 }, { x: 9, y: -1 }, { x: 9, y: 9 }, { x: -1, y: 9 }];
  const flags = new Uint8Array(400);
  for (let i = 1; i < 400; i += 40) flags[i] = WITHHELD;

  function cloud(declared: number, reduction?: 'voxel-centroids') {
    return new PointCloud({
      positions: g.positions, classification: g.classification, classificationFlags: flags,
      origin: [0, 0, 0], sourceFormat: 'las', name: 'r.las',
      declaredPointCount: declared, pointReduction: reduction,
    });
  }
  const host = (clouds: PointCloud[]): LassoVolumeHost => ({
    project: (x, y) => ({ x, y }),
    integrable: clouds.map((c, i) => [`c${i}`, { cloud: c }] as const),
    streamingParts: [],
    wasReduced: (c) => cloudReduction(c) !== undefined,
    reductionOf: (c) => cloudReduction(c),
    visibilityFor: () => null,
    worldUp: [0, 0, 1],
  });
  const run = (clouds: PointCloud[]) =>
    computeLassoVolume({ host: host(clouds), lasso, referencePercentile: 0.05 })!;

  it('keeps noise and Withheld out of a strided cloud and notes the stride', () => {
    const out = run([cloud(10_000)]);
    expect(out.withheld.noiseExcluded).toBeGreaterThan(0);
    expect(typeof out.withheld.excluded).toBe('number');
    expect(out.withheld.exclusionUnavailable).toBeUndefined();
    expect(out.withheld.reduction).toEqual({ mode: 'strided-records', resident: 400, declared: 10_000 });
    for (let i = 2; i < out.selectedPositions.length; i += 3) expect(out.selectedPositions[i]).toBeLessThan(100);
  });

  it('marks a voxel cloud unavailable and states no exclusion count', () => {
    const out = run([cloud(10_000, 'voxel-centroids')]);
    expect(out.withheld.exclusionUnavailable).toBe('reduced-sample');
    expect(out.withheld.excluded).toBe('unknown');
    expect('noiseExcluded' in out.withheld).toBe(false);
    expect(out.withheld.reduction?.mode).toBe('voxel-centroids');
    expect(out.anySourceReduced).toBe(true);
  });

  it('a whole cloud adds no reduction fields', () => {
    const out = run([cloud(400)]);
    expect(Object.keys(out.withheld).sort()).toEqual(['analysed', 'excluded', 'noiseExcluded', 'source']);
  });

  it('a mixed walk keeps the original source filtered and marks the whole figure', () => {
    const out = run([cloud(400), cloud(10_000, 'voxel-centroids')]);
    expect(out.withheld.noiseExcluded).toBeGreaterThan(0);
    expect(out.withheld.exclusionUnavailable).toBe('reduced-sample');
    expect(out.withheld.excluded).toBe('unknown');
  });
});

describe('the caveat reaches every surface', () => {
  const g = reproduction();
  const voxelRecord = polygonRecord([voxel(g) as never]);
  const stridedRecord = polygonRecord([strided(g) as never]);

  const mk = (id: string, volume: Measurement['volume']): Measurement => ({
    id, kind: 'volume', name: `vol ${id}`, points: [[0, 0, 0], [8, 0, 0], [8, 8, 0], [0, 8, 0]], volume,
  });
  const reduced = mk('v', voxelRecord);
  const plain = mk('p', polygonRecord([whole(g) as never]));
  const ctx = { toOutput: (p: readonly [number, number, number]) => [p[0], p[1], p[2]] as [number, number, number], up: UP, unitToMetres: 1, crsName: 'EPSG:32612' };

  it('the caveat text names the sample, the counts and the missing filter', () => {
    const text = reducedSampleCaveat(voxelRecord.withheld) ?? '';
    expect(text).toContain('reduced sample');
    expect(text).toContain('400 resident of 10,000 declared');
    expect(text).toContain('without noise-class');
    expect(reducedSampleCaveat(stridedRecord.withheld)).toBeNull();
    expect(reducedSampleClause(stridedRecord.withheld)).toBe('');
  });

  it('the toast clause says exclusion was unavailable', () => {
    expect(withheldClause(voxelRecord.withheld)).toContain('noise and Withheld exclusion unavailable');
    expect(withheldClause(voxelRecord.withheld)).not.toContain('0 ');
  });

  it('the panel headline carries the clause', async () => {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const m = new MeasureController({
      onExit: () => {}, getPickRay: () => null, getPointAt: () => null,
    } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    m.setContext({ worldUp: UP, origin: [0, 0, 0] });
    const headline = (x: Measurement) => (m as unknown as { _headlineText(x: unknown): string })._headlineText(x);
    expect(headline(reduced)).toContain('noise and Withheld exclusion unavailable (reduced sample)');
    expect(headline(plain)).not.toContain('unavailable');
  });

  it('survives a session save and restore, field for field', () => {
    const text = serializeSession({
      upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [],
      measurements: [reduced, mk('s', stridedRecord), plain], annotations: [], software: '0.7.0',
    } as never);
    const back = parseSession(text).measurements;
    expect(back[0].volume?.withheld).toEqual(voxelRecord.withheld);
    expect(back[0].volume?.withheld?.exclusionUnavailable).toBe('reduced-sample');
    expect(back[1].volume?.withheld?.reduction?.mode).toBe('strided-records');
    expect(back[1].volume?.withheld?.exclusionUnavailable).toBeUndefined();
    expect(back[2].volume?.withheld?.reduction).toBeUndefined();
  });

  it('a damaged saved record cannot export a noise count beside a voxel mode', () => {
    const damaged = mk('d', {
      ...voxelRecord,
      withheld: { source: 10, excluded: 0, analysed: 10, noiseExcluded: 0, reduction: voxelRecord.withheld!.reduction },
    } as never);
    const text = serializeSession({
      upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], measurements: [damaged], annotations: [], software: '0.7.0',
    } as never);
    const back = parseSession(text).measurements[0];
    expect(back.volume?.withheld?.exclusionUnavailable).toBe('reduced-sample');
    const csv = measurementsToCsv([back], ctx as never).split('\n');
    expect(csv[1].split(',')[csv[0].split(',').indexOf('noise_excluded')]).toBe('unavailable');
  });

  it('a negative or non-finite reduction count drops the reduction on restore', () => {
    for (const bad of [-1, Number.POSITIVE_INFINITY]) {
      const m = mk('b', { ...voxelRecord, withheld: { source: 1, excluded: 'unknown', analysed: 1, reduction: { mode: 'voxel-centroids', resident: bad, declared: 5 } } } as never);
      const text = serializeSession({
        upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], measurements: [m], annotations: [], software: '0.7.0',
      } as never);
      expect(parseSession(text).measurements[0]?.volume?.withheld?.reduction).toBeUndefined();
    }
  });

  it('a reduced cloud that puts no point inside the polygon adds no caveat', () => {
    const far: Vec3[] = [[100, 100, 0], [108, 100, 0], [108, 108, 0], [100, 108, 0]];
    const out = gatherVolumeBuffers([voxel(g) as never, whole(g) as never], () => [], (c) => cloudReduction(c as never));
    const rec = samplePolygonVolume(out.buffers, out.total, POLY, 0, UP, out.reductions);
    expect(rec.withheld?.reduction?.resident).toBe(400);
    const none = samplePolygonVolume(out.buffers.slice(0, 1), 1200, far, 0, UP, out.reductions.slice(0, 1));
    expect(none.withheld?.reduction).toBeUndefined();
  });

  it('CSV adds the columns only when a volume was reduced, and never writes a zero for unavailable', () => {
    const header = (csv: string) => csv.split('\n')[0].split(',');
    const withReduced = measurementsToCsv([reduced, plain], ctx as never).split('\n');
    const cols = header(withReduced.join('\n'));
    const cell = (row: string, col: string) => row.split(',')[cols.indexOf(col)];
    expect(cols.slice(-5)).toEqual(['noise_excluded', 'reduction_mode', 'resident_points', 'declared_points', 'reduction_caveat']);
    expect(cell(withReduced[1], 'noise_excluded')).toBe('unavailable');
    expect(cell(withReduced[1], 'reduction_mode')).toBe('voxel-centroids');
    expect(cell(withReduced[1], 'resident_points')).toBe('400');
    expect(cell(withReduced[1], 'declared_points')).toBe('10000');
    expect(cell(withReduced[1], 'withheld_excluded')).toBe('unavailable');
    expect(withReduced[1]).toContain('reduced sample');
    expect(cell(withReduced[2], 'reduction_mode')).toBe('');
    // No reduced volume: the header is the one it always was.
    expect(header(measurementsToCsv([plain], ctx as never))).not.toContain('reduction_mode');
  });

  it('a stride writes its noise count as a number', () => {
    const csv = measurementsToCsv([mk('s', stridedRecord)], ctx as never).split('\n');
    const cols = csv[0].split(',');
    expect(csv[1].split(',')[cols.indexOf('noise_excluded')]).toBe('100');
    expect(csv[1].split(',')[cols.indexOf('reduction_mode')]).toBe('strided-records');
  });

  it('GeoJSON carries the same fields on a reduced volume and none on a whole one', () => {
    const fc = JSON.parse(measurementsToGeoJSON([reduced, plain], ctx as never));
    const [a, b] = fc.features.map((f: { properties: Record<string, unknown> }) => f.properties);
    expect(a.noise_excluded).toBe('unavailable');
    expect(a.reduction_mode).toBe('voxel-centroids');
    expect(a.resident_points).toBe(400);
    expect(a.declared_points).toBe(10_000);
    expect(String(a.reduction_caveat)).toContain('reduced sample');
    expect(b.reduction_mode).toBeUndefined();
    expect(b.noise_excluded).toBeUndefined();
  });

  it('KML describes the reduced volume with the caveat', () => {
    const kml = buildKml({
      annotations: [], viewpoints: [], measurements: [reduced, plain], crsName: 'EPSG:32612', unitLabel: 'm',
      up: UP, unitToMetres: 1, toLonLat: (p) => [p[0] / 1e5, p[1] / 1e5, p[2]], notSurveyGradeNote: 'Not survey grade.',
    });
    expect(kml.split('<Placemark>')[1]).toContain('reduced sample of voxel centroids');
    expect(kml.split('<Placemark>')[2]).not.toContain('reduced sample');
  });

  it('the integrity report finding carries the caveat', () => {
    const f = measurementsToFindings([reduced, plain], UP, 1);
    expect(f[0]?.caveats?.join(' ')).toContain('reduced sample of voxel centroids');
    expect(f[1]?.caveats?.join(' ')).not.toContain('reduced sample');
    const file = integrityReportFile([reduced], UP, 1, 1, 'd', 'EPSG:32612', '2026-01-01T00:00:00Z', 1);
    expect(file.text).toContain('reduced sample of voxel centroids');
    const plainFile = integrityReportFile([plain], UP, 1, 1, 'd', 'EPSG:32612', '2026-01-01T00:00:00Z', 1);
    expect(plainFile.text).not.toContain('reduced sample');
  });

  it('the PDF measurement row carries the caveat as a note', () => {
    const rows = buildMeasurementRows([reduced, plain], 'metric');
    expect(rows[0]?.note).toContain('reduced sample of voxel centroids');
    expect(rows[0]?.note).toContain('without noise-class');
    expect(rows[1]?.note).toBeUndefined();
    expect(rows[1] && 'note' in rows[1]).toBe(false);
  });
});
