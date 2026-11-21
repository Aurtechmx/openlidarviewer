/**
 * sheetMeasurements.test.ts: measurements and annotations on the styled map
 * sheet, and the support grade in the measurement exports.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFPage } from 'pdf-lib';
import { buildMapSheetPdf, type MapSheetInput } from '../src/render/measure/mapSheetPdf';
import { buildContourSheetPdf, measurementLetter } from '../src/render/measure/mapSheetStyled';
import { measurementsOptionState } from '../src/render/measure/mapSheetExportOptions';
import { supportWord, type SheetMeasurement } from '../src/export/sheetKit/sheetMeasurement';
import { sheetMeasurements } from '../src/app/sheetMeasurements';
import { measurementsToCsv, measurementsToGeoJSON, type MeasurementExportContext } from '../src/export/measurementExport';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import type { Annotation } from '../src/render/annotate/types';
import { IDENTITY_LONLAT } from './helpers/geoJsonLonLat';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));

const model: ContourFeatureModel = {
  features: [
    { value: 100, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [50, 10], [100, 0]] },
    { value: 110, isIndex: false, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 30], [50, 40], [100, 30]] },
  ],
  crs: 'WGS 84 / UTM zone 11N', verticalDatum: 'NAVD88', intervalM: 10, contourStyle: 'smooth',
  bbox: { minX: 0, minY: 0, maxX: 100, maxY: 60 }, interpolatedFraction: 0, coverageMode: 'full', warnings: [],
};

const MS: SheetMeasurement[] = [
  { name: 'Area A', kind: 'area', value: '0.12 ha', grade: 'green', support: 'Supported — close to measured points', points: [[10, 10, 0], [40, 10, 0], [40, 40, 0], [10, 40, 0]], closed: true, notes: [] },
  { name: 'Pile', kind: 'volume', value: 'Cut 12 m³', grade: 'yellow', support: null, points: [[60, 10, 0], [80, 10, 0], [80, 30, 0]], closed: true, notes: ['Base level 101.20 m (median of the outline’s vertex heights)'] },
  { name: 'Road', kind: 'distance', value: '44.0 m', grade: 'red', support: 'Unverified — the points sit on layers with different up axes', points: [[5, 50, 0], [95, 55, 0]], closed: false, notes: [] },
];
const ANN: Annotation[] = [
  { id: 'a', title: 'Outlet', note: 'Scour', type: 'issue', localPosition: { x: 20, y: 20, z: 0 }, createdAt: 0, updatedAt: 0 } as Annotation,
  { id: 'b', title: 'Fence', type: 'note', localPosition: { x: 70, y: 40, z: 0 }, createdAt: 0, updatedAt: 0 } as Annotation,
];

function input(over: Partial<MapSheetInput> = {}): MapSheetInput {
  return { model, labels: [], crs: 'X', linearUnit: 'metre', generatedAt: new Date('2026-01-01T00:00:00Z'), sheet: 'letter', orientation: 'landscape', ...over };
}

async function texts(inp: MapSheetInput): Promise<string[]> {
  const out: string[] = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: object) { out.push(t); return orig.call(this, t, o as never); });
  await buildContourSheetPdf(inp, { loadFont });
  return out;
}
afterEach(() => { vi.restoreAllMocks(); });

describe('measurements on the styled map sheet', () => {
  it('letters each measurement on the map and lists its figure and support grade', async () => {
    const t = await texts(input({ style: 'light', measurements: MS }));
    for (const want of ['MEASUREMENTS (3)', 'Area A', '0.12 ha', 'Support: Supported — close to measured points', 'Support: Caution', 'Road', 'Measurement, lettered as listed']) {
      expect(t, want).toContain(want);
    }
    expect(t.some((s) => s.startsWith('Base level 101.20 m'))).toBe(true);
    for (const letter of ['A', 'B', 'C']) expect(t.filter((s) => s === letter).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('groups annotations by type, issues first', async () => {
    const t = await texts(input({ style: 'dark', includeAnnotations: true, annotations: ANN }));
    const issues = t.indexOf('Issues (1)'), notes = t.indexOf('Notes (1)');
    expect(issues).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(issues);
    expect(t).toContain('1. Outlet: Scour');
    expect(t).toContain('2. Fence');
  }, 60_000);

  it('Classic leaves measurements off, byte for byte', async () => {
    const plain = await buildMapSheetPdf(input());
    expect(Buffer.from(await buildContourSheetPdf(input({ measurements: MS }))).equals(Buffer.from(plain))).toBe(true);
  });

  it('letters run A to Z, then AA', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(measurementLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
    expect(supportWord('yellow')).toBe('Caution');
    expect(supportWord(null)).toBe('Not graded');
  });

  it('the dialog option is off and disabled with no measurements', () => {
    expect(measurementsOptionState(0).disabled).toBe(true);
    expect(measurementsOptionState(2)).toMatchObject({ disabled: false, label: 'Include measurements' });
  });
});

describe('sheetMeasurements', () => {
  const m = (id: string, owner?: string): Measurement => ({ id, kind: 'distance', name: id, points: [[0, 0, 0], [1, 0, 0]], ...(owner ? { owner: { layerId: owner, frame: 'source-local' } } : {}) } as Measurement);
  const viewer = (ms: Measurement[]) => ({
    measure: {
      getMeasurements: () => ms,
      getSummaries: () => ms.map((x) => ({ id: x.id, name: x.name, kind: x.kind, value: '1.00 m', trust: { grade: 'green', caption: 'Supported' } })),
    },
  }) as never;

  it('offers unowned work and work on the analysed scan only', () => {
    const out = sheetMeasurements(viewer([m('free'), m('mine', 'L1'), m('other', 'L2')]), 'L1');
    expect(out.map((x) => x.name)).toEqual(['free', 'mine']);
    expect(out[0]).toMatchObject({ value: '1.00 m', grade: 'green', support: 'Supported', closed: false });
  });
});

describe('support grade in exports', () => {
  const UP: Vec3 = [0, 0, 1];
  const CTX: MeasurementExportContext = { toOutput: (p) => [p[0], p[1], p[2]], lonLat: IDENTITY_LONLAT, up: UP, unitToMetres: 1, crsName: 'EPSG:32612' };
  const D: Measurement = { id: 'd', kind: 'distance', name: 'D', points: [[0, 0, 0], [3, 4, 0]] };
  const E: Measurement = { id: 'e', kind: 'distance', name: 'E', points: [[0, 0, 0], [1, 0, 0]] };
  const supportOf = (x: Measurement) => (x.id === 'd' ? { grade: 'red', caption: 'Unverified — degrees are not distances (geographic CRS)' } : null);

  it('adds support columns to the CSV only when grades are given', () => {
    const lines = measurementsToCsv([D, E], { ...CTX, supportOf }).split('\n');
    const head = lines[0]!.split(',');
    expect(head.slice(-2)).toEqual(['support_grade', 'support']);
    expect(lines[1]).toContain('red,Unverified — degrees are not distances (geographic CRS)');
    expect(lines[2]!.endsWith('not graded,')).toBe(true);
    expect(measurementsToCsv([D], CTX).split('\n')[0]).not.toContain('support');
  });

  it('adds support properties to each GeoJSON feature', () => {
    const gj = JSON.parse(measurementsToGeoJSON([D, E], { ...CTX, supportOf })) as { features: Array<{ properties: Record<string, unknown> }> };
    expect(gj.features[0]!.properties).toMatchObject({ support_grade: 'red' });
    expect(gj.features[1]!.properties).toMatchObject({ support_grade: 'not graded', support: '' });
    const plain = JSON.parse(measurementsToGeoJSON([D], CTX)) as { features: Array<{ properties: Record<string, unknown> }> };
    expect(plain.features[0]!.properties).not.toHaveProperty('support_grade');
  });
});
