/**
 * stockpileResultParity.test.ts — one lasso result, the same numbers on every
 * surface.
 *
 * The lasso result is built once (`lassoStockpileResult`). The toast clause is
 * formatted from it, Save stores it, and the session file, the CSV, the
 * GeoJSON, the findings report, the evidence stamp and the chain totals read
 * the stored record. Each case below builds the result the way the app does
 * and checks every surface against it: a measured grid, a preview grid, a
 * withheld grid, a result whose input held Withheld points, and a record
 * saved before the grid became the lasso figure.
 */
import { describe, it, expect } from 'vitest';
import { lassoStockpileResult } from '../src/render/measure/stockpilePresenter';
import { STOCKPILE_RESULT_SCHEMA } from '../src/render/measure/stockpileResult';
import { deriveVolumeRecord } from '../src/render/measure/measureDerivations';
import { volumeFromLassoWithFootprint } from '../src/render/measure/lassoVolume';
import { computeLassoVolume } from '../src/render/measure/lassoVolumeCompute';
import { POINT_SAMPLE_VOLUME_METHOD } from '../src/render/measure/volume';
import { measurementsToCsv, measurementsToGeoJSON } from '../src/export/measurementExport';
import { measurementsToFindings } from '../src/export/measurementReport';
import { valueForDimension } from '../src/render/measure/measurementChains';
import { parseSession, serializeSession } from '../src/io/session';
import { PointCloud } from '../src/model/PointCloud';
import { encodeExtendedClassificationFlags } from '../src/lasSemantics';
import type { StockpileBandInputs } from '../src/render/measure/stockpileBandInputs';
import type { Measurement, Vec3, VolumeRecord } from '../src/render/measure/types';

const UP: Vec3 = [0, 0, 1];
const RECT: Vec3[] = [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]];

function prism(h: number, stepX: number, stepY: number, xFrom = 0, xTo = 20): number[] {
  const out: number[] = [];
  for (let x = xFrom + stepX / 2; x < xTo; x += stepX) {
    for (let y = stepY / 2; y < 10; y += stepY) out.push(x, y, h);
  }
  return out;
}

/** The point-sample record and stockpile inputs the lasso path hands over. */
function lassoOf(positions: Float32Array, options: StockpileBandInputs['options'] = {}, lin = 1) {
  const n = positions.length / 3;
  const lo = volumeFromLassoWithFootprint({
    positions,
    selected: Array.from({ length: n }, (_, i) => i),
    referencePercentile: 0.05,
    up: UP,
  });
  const ps = deriveVolumeRecord(lo.result, lo.referenceZ, POINT_SAMPLE_VOLUME_METHOD);
  const inputs: StockpileBandInputs = {
    polygon: RECT,
    positions,
    lin,
    options,
    withheld: { source: n, excluded: 0, analysed: n },
  };
  return { ps, inputs };
}

const ctx = {
  toOutput: (p: readonly number[]) => [p[0], p[1], p[2]] as [number, number, number],
  up: UP,
  unitToMetres: 1,
  verticalUnitToMetres: 1,
  crsName: 'EPSG:26913',
  geographic: false,
  unitsVerified: true,
} as never;

const asMeasurement = (volume: VolumeRecord): Measurement => ({
  id: 'lasso1', kind: 'volume', name: 'Lasso volume', points: RECT, closed: true, volume,
} as Measurement);

function roundTrip(volume: VolumeRecord): VolumeRecord {
  const s = {
    upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], annotations: [],
    measurements: [asMeasurement(volume)],
  } as unknown as Parameters<typeof serializeSession>[0];
  return (parseSession(serializeSession(s)).measurements[0] as { volume: VolumeRecord }).volume;
}

/** One CSV row as a column → cell map. */
function csvRow(volume: VolumeRecord): Record<string, string> {
  const [head, row] = measurementsToCsv([asMeasurement(volume)], ctx).split('\n');
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of row) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return Object.fromEntries(head.split(',').map((k, i) => [k, cells[i]]));
}

const geo = (volume: VolumeRecord) =>
  JSON.parse(measurementsToGeoJSON([asMeasurement(volume)], ctx)).features[0].properties;

/** Every number the toast clause prints for `label`, in m³. */
const toastFigure = (headline: string, label: string): number[] =>
  [...headline.matchAll(new RegExp(`${label} (-?[\\d.]+) m³`, 'g'))].map((m) => Number(m[1]));

/** Assert every surface carries the result's fill/cut/net and nothing else. */
function expectParity(record: VolumeRecord, headline: string): void {
  const saved = roundTrip(record);
  expect(saved).toEqual(record);
  const row = csvRow(saved);
  const props = geo(saved);
  const [finding] = measurementsToFindings([asMeasurement(saved)], UP, 1);
  const m = asMeasurement(saved);
  if (record.net !== undefined) {
    for (const [k, v] of [['fill', record.fill!], ['cut', record.cut!], ['net', record.net]] as const) {
      expect(toastFigure(headline, k)[0]).toBeCloseTo(v, 2);
      expect(Number(row[`${k}_m3`])).toBeCloseTo(v, 3);
      expect(props[`${k}_m3`]).toBeCloseTo(v, 3);
    }
    expect(finding.value).toBeCloseTo(record.net, 3);
    expect(valueForDimension(m, 'volume-net')).toBe(record.net);
    expect(valueForDimension(m, 'volume-fill')).toBe(record.fill);
  } else {
    expect(headline).toMatch(/^Volume withheld/);
    for (const k of ['fill', 'cut', 'net']) {
      expect(row[`${k}_m3`]).toBe('');
      expect(props[`${k}_m3`]).toBeUndefined();
    }
    expect(finding.label).toMatch(/grid volume withheld/);
    expect(valueForDimension(m, 'volume-net')).toBeNull();
  }
  const cc = record.crossCheck;
  if (cc) {
    // The toast's cross-check figures follow the grid's, so the last match is it.
    expect(toastFigure(headline, 'net').at(-1)).toBeCloseTo(cc.net, 2);
    expect(Number(row.pointsample_net_m3)).toBeCloseTo(cc.net, 3);
    expect(props.pointsample_net_m3).toBeCloseTo(cc.net, 3);
    expect(finding.caveats?.join(' ')).toContain(`fill ${cc.fill.toFixed(2)} m³`);
  }
  expect(row.grid_authority).toBe(record.gridAuthority ?? '');
  expect(props.grid_authority).toBe(record.gridAuthority);
  const w = record.withheld;
  if (w) {
    expect(row.source_points).toBe(String(w.source));
    expect(row.withheld_excluded).toBe(String(w.excluded));
    expect(row.analysed_points).toBe(String(w.analysed));
    expect(props.withheld_excluded).toBe(w.excluded);
    expect(finding.caveats?.join(' ')).toContain(`${w.analysed} of ${w.source} selected points analysed`);
  }
  const stampsGrid = record.gridAuthority !== undefined && record.gridAuthority !== 'withheld';
  const note = JSON.parse(measurementsToGeoJSON([asMeasurement(saved)], ctx)).evidence as string;
  expect(note).toContain(stampsGrid ? 'VOL-STOCKPILE' : 'VOL-POINT-SAMPLE');
  expect(note).not.toContain(stampsGrid ? 'VOL-POINT-SAMPLE' : 'VOL-STOCKPILE');
}

describe('one lasso result on every surface', () => {
  it('a measured grid', () => {
    const { ps, inputs } = lassoOf(Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]));
    const out = lassoStockpileResult(ps, inputs, 1);
    expect(out.record.gridAuthority).toBe('measured');
    expect(out.record.resultSchema).toBe(STOCKPILE_RESULT_SCHEMA);
    expect(out.record.method).toBe('olv.volume.stockpile-area-grid@3');
    expect(out.record.crossCheck).toEqual({ fill: ps.fill, cut: ps.cut, net: ps.net, method: ps.method });
    expect(out.headline).toContain('(area-weighted grid)');
    expectParity(out.record, out.headline);
    // The band's volume is the same evaluation as the stored fill.
    const band = /Stockpile: ([\d,]+) m³/.exec(out.suffix)?.[1];
    expect(Number(band!.replaceAll(',', ''))).toBe(Math.round(out.record.fill!));
  });

  it('a preview grid', () => {
    const { ps, inputs } = lassoOf(
      Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]),
      { walkSampled: true },
    );
    const out = lassoStockpileResult(ps, inputs, 1);
    expect(out.record.gridAuthority).toBe('preview');
    expect(out.headline).toContain('PREVIEW: display sample');
    expectParity(out.record, out.headline);
  });

  it('a withheld grid stores and shows no grid figure anywhere', () => {
    const { ps, inputs } = lassoOf(Float32Array.from(prism(3, 0.5, 0.5, 0, 9)));
    const out = lassoStockpileResult(ps, inputs, 1);
    expect(out.record.gridAuthority).toBe('withheld');
    expect(out.record.fill).toBeUndefined();
    expect(out.record.crossCheck?.net).toBe(ps.net);
    expectParity(out.record, out.headline);
  });

  it('a lasso over Withheld points carries the counts the walk recorded', () => {
    const pts = [...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)];
    const n = pts.length / 3;
    const flags = new Uint8Array(n);
    const W = encodeExtendedClassificationFlags({ withheld: true });
    let withheld = 0;
    for (let i = 0; i < n; i += 13) { flags[i] = W; pts[i * 3 + 2] = 50; withheld++; }
    // Duplicate layers sit at the same x,y; the projector keeps only x,y.
    const cloud = new PointCloud({
      positions: Float32Array.from(pts), origin: [0, 0, 0], sourceFormat: 'las', name: 'p.las', classificationFlags: flags,
    });
    const walk = computeLassoVolume({
      host: {
        project: (x, y) => ({ x, y }), integrable: [['p', { cloud }]], streamingParts: [],
        wasReduced: () => false, visibilityFor: () => null, worldUp: UP,
      },
      lasso: [{ x: -1, y: -1 }, { x: 21, y: -1 }, { x: 21, y: 11 }, { x: -1, y: 11 }],
      referencePercentile: 0.05,
    })!;
    expect(walk.withheld).toEqual({ source: n, excluded: withheld, analysed: n - withheld });
    const ps = deriveVolumeRecord(walk.result, walk.referenceZ, POINT_SAMPLE_VOLUME_METHOD);
    const out = lassoStockpileResult(ps, {
      polygon: RECT, positions: walk.selectedPositions, lin: 1, options: {}, withheld: walk.withheld,
    }, 1);
    expect(out.record.withheld).toEqual(walk.withheld);
    expect(out.headline).toContain(`${withheld} Withheld points excluded`);
    expectParity(out.record, out.headline);
  });

  it('flags unavailable reads unknown on every surface, never 0', () => {
    const { ps, inputs } = lassoOf(Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]));
    const n = inputs.positions.length / 3;
    const out = lassoStockpileResult(ps, { ...inputs, withheld: { source: n, excluded: 'unknown', analysed: n } }, 1);
    expect(out.headline).toContain('Withheld flags unavailable');
    expectParity(out.record, out.headline);
    expect(csvRow(roundTrip(out.record)).withheld_excluded).toBe('unknown');
  });

  it('a record saved before the grid became the lasso figure is read as saved', () => {
    const old: VolumeRecord = {
      fill: 120, cut: 30, net: 90, referenceZ: 0, footprintArea: 50,
      pointsInPolygon: 800, densityNative: 16, confidence: 'medium', method: 'olv.volume.stockpile@1', // method-literal-ok: a record stored at an earlier version
    };
    const back = roundTrip(old);
    expect(back).toEqual(old);
    expect(back.resultSchema).toBeUndefined();
    expect(back.gridAuthority).toBeUndefined();
    const row = csvRow(back);
    expect([row.fill_m3, row.cut_m3, row.net_m3]).toEqual(['120', '30', '90']);
    expect(row.grid_authority).toBe('');
    expect(row.withheld_excluded).toBe('');
    expect(JSON.parse(measurementsToGeoJSON([asMeasurement(back)], ctx)).evidence).toContain('VOL-POINT-SAMPLE');
    expect(measurementsToFindings([asMeasurement(back)], UP, 1)[0].value).toBe(90);
  });

  it('a grid record stored at an earlier method version keeps its tag', () => {
    const { ps, inputs } = lassoOf(Float32Array.from([...prism(3, 0.5, 0.5), ...prism(0, 0.5, 0.5)]));
    const rec = { ...lassoStockpileResult(ps, inputs, 1).record, method: 'olv.volume.stockpile-area-grid@2' }; // method-literal-ok: a record stored at an earlier version
    const { withheld: _drop, resultSchema: _s, ...v2 } = rec;
    const back = roundTrip(v2);
    expect(back).toEqual(v2);
    expect(back.method).toBe('olv.volume.stockpile-area-grid@2'); // method-literal-ok: a record stored at an earlier version
    expect(back.withheld).toBeUndefined();
  });
});
