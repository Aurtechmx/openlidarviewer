/**
 * mapSheetStates.ts: one map sheet input per state the contour sheet can be
 * in, shared by the language test and its English digests.
 */
import { analyseContours } from '../../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../../src/terrain/TerrainContracts';
import { buildExportProvenance, type ExportProvenance } from '../../src/terrain/export/exportProvenance';
import type { AnalysedBasis } from '../../src/terrain/export/analysedBasis';
import type { MapSheetInput, MapSheetPurpose } from '../../src/render/measure/mapSheetPdf';
import type { SheetMeasurement } from '../../src/export/sheetKit/sheetMeasurement';
import type { Annotation } from '../../src/render/annotate/types';
import { contourExportIntentFromState } from '../../src/terrain/contourStudio/contourExportIntent';
import { purposeDefaults } from '../../src/terrain/contourStudio/contourStudioPurpose';
import { baseContourStudioState, type ContourStudioPurpose } from '../../src/terrain/contourStudio/contourStudioState';

/** The sheet facts Contour Studio hands a purpose's map sheet. */
export const contourStudioExportIntent = (purpose: ContourStudioPurpose): MapSheetPurpose =>
  contourExportIntentFromState({ ...baseContourStudioState(), purpose, ...purposeDefaults(purpose) }).deliverable;

const WHEN = new Date('2026-11-20T12:00:00Z');

/** A tilted, ridged site with an irregular edge, a hole without ground and a filled gap. */
function scene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 90; x += 0.8) {
    for (let y = 0; y <= 60; y += 0.8) {
      const ex = (x - 45) / 44, ey = (y - 30) / 28;
      if (ex * ex + ey * ey > 1) continue;
      if (((x - 60) / 7) ** 2 + ((y - 34) / 5) ** 2 < 1) continue;
      if (x > 18 && x < 24 && y > 20 && y < 22.5) continue;
      pts.push({ x, y, z: 100 + 0.4 * x + 6 * Math.sin(x / 11) * Math.cos(y / 13) });
    }
  }
  return pts;
}

const r = analyseContours(scene(), { cellSizeM: 1, crs: 'EPSG:32612', verticalDatum: 'EPSG:5703' } as never);
const d = r.dtm;
const coverage = Uint8Array.from(d.coverage);
for (let row = 0; row < d.rows; row++) {
  for (let col = 0; col < d.cols; col++) {
    const x = d.originH1 + (col + 0.5) * d.cellSizeM, y = d.originH2 + (row + 0.5) * d.cellSizeM;
    if (((x - 60) / 6) ** 2 + ((y - 34) / 4) ** 2 < 1) coverage[row * d.cols + col] = 0;
  }
}
const relief = { cols: d.cols, rows: d.rows, cellSize: d.cellSizeM, originX: d.originH1, originY: d.originH2, z: d.z, coverage };

const basis = (over: Partial<AnalysedBasis> = {}): AnalysedBasis =>
  ({ analysedPointCount: 284517, declaredPointCount: 15680312, coverage: 'full', loadStride: null, ...over });
const prov = (over: Partial<ExportProvenance> = {}, b: AnalysedBasis | null = null, units: number | null = 1): ExportProvenance => ({
  ...buildExportProvenance(r, { generatedAt: WHEN, verticalUnitToMetres: units, analysedBasis: b, basename: 'site', softwareVersion: '0.7.2', metricVersion: 'v0.4.1' }),
  build: 'v0.7.2 (abc1234)', ...over,
});
const acc = (over: object = {}) => ({ rmseZM: 0.034, nvaM: 0.067, vvaM: 1.123, usgsDensityReferenceFloor: 'QL2', ...over });

const PTS: SheetMeasurement['points'] = [[10, 10, 0], [40, 10, 0], [40, 40, 0], [10, 40, 0]];
const m = (over: Partial<SheetMeasurement>): SheetMeasurement =>
  ({ name: 'Distance 1', kind: 'distance', value: '44.00 m', grade: 'green', support: 'Supported — close to measured points', points: PTS, closed: false, notes: [], ...over });
export const MEASUREMENTS: SheetMeasurement[] = [
  m({ name: 'Cut and fill, north', kind: 'area', value: '1,234.50 m²', closed: true }),
  m({ name: 'Volume 2', kind: 'volume', value: '1,234.5 m² · +3.25 m³ fill · −2.10 m³ cut · net 1.15 m³ fill · 31% interpolated (low confidence) · 4% outside scan, left out · PREVIEW (footprint gaps) · 12 noise points (classes 7, 18) excluded', grade: 'yellow', support: null, closed: true, notes: ["Base level 101.20 m (median of the outline's vertex heights)", 'Sampled from the streamed points loaded so far; may change as more load.'] }),
  m({ name: 'Road', value: '44.000 m · 042° grid', grade: 'red', support: 'Unverified — the points sit on layers with different up axes' }),
  m({ name: 'Loose', value: '10.737 (unit unverified) · 042° (local axes)', grade: null, support: null, notes: ['Unit unverified: the scan has no resolved linear unit.', "Base level 12.5 (unit unverified), local (median of the outline's vertex heights)"] }),
  m({ name: 'EPSG:4326', kind: 'area', value: 'not available: horizontal CRS units are not ground distances (geographic degrees, Web Mercator grid or geocentric frame)', grade: 'red', support: 'Unverified — degrees are not distances (geographic CRS)' }),
];
const ann = (id: string, type: string, title: string, note = '', x = 20, y = 20): Annotation =>
  ({ id, title, note, type, localPosition: { x, y, z: 0 }, createdAt: 0, updatedAt: 0 }) as Annotation;
export const ANNOTATIONS: Annotation[] = [
  ann('a', 'issue', 'Scour at outlet 1.5', 'Depth 2.5 m, 1,200 stones'), ann('b', 'warning', 'Soft ground'), ann('c', 'note', 'Fence', 'Culvert 12 '.repeat(14), 70, 40), ann('d', 'info', 'Gate', '', 5000, 5000),
];

export function mapInput(over: Partial<MapSheetInput> = {}): MapSheetInput {
  return {
    model: r.model, labels: r.labels, worldOrigin: { x: 412000, y: 4501000, z: 0 },
    crs: 'WGS 84 / UTM zone 12N', verticalDatum: 'NAVD88', linearUnit: 'metre', readiness: 'previewOnly', title: 'Elevation - Grid 1.5',
    generatedAt: WHEN, relief, sheet: 'letter', orientation: 'landscape', style: 'light', ...over,
  };
}

const allKinds = { ...r.model, features: r.model.features.map((f, i) => ({ ...f, provBits: undefined, ...([{ grade: 'solid', basis: 'measured' }, { grade: 'dashed', basis: 'measured' }, { grade: 'dashed', basis: 'interpolated' }, { grade: 'gap', basis: 'interpolated' }][i % 4]) })) } as never;
const none = { ...r.model, features: [], bbox: null } as never;
const custom: MapSheetPurpose = { label: 'Custom', statement: contourStudioExportIntent('custom').statement, analytical: true, cartographic: true, cartographicSmoothing: true, generalizeToleranceCells: 0.5, indexEvery: 5, labelsIndexOnly: false, hillshade: true, hypsometricTint: true, allowExploratory: true, completePackage: true, appendixRequired: true };

/** Every state. Values override `mapInput`. */
export const MAP_STATES: Record<string, Partial<MapSheetInput>> = {
  plain: {},
  untitled: { title: undefined },
  dark: { style: 'dark' },
  provenance: { provenance: prov() },
  ready: { provenance: prov({ exportReadiness: 'Ready', accuracy: acc() } as never, basis({ analysedPointCount: 15680312 })) },
  blocked: { provenance: prov({ exportReadiness: 'Blocked', accuracy: null } as never) },
  withheld: { provenance: prov({ accuracy: null, analysedBasisLine: 'unknown' }) },
  sample: { provenance: prov({ accuracy: acc({ usgsDensityReferenceFloor: 'none', accuracyOnSample: true }) } as never, basis({ coverage: 'sampled', loadStride: 55 })) },
  sampleReduced: { provenance: prov({}, basis({ coverage: 'sampled', residentPointCount: 2276133 })) },
  resident: { provenance: prov({}, basis({ coverage: 'resident-only' })) },
  residentSub: { provenance: prov({}, basis({ coverage: 'resident-only', residentPointCount: 2276133 })) },
  truncated: { provenance: prov({}, basis({ coverage: 'partial', declaredPointCount: null })) },
  subsample: { provenance: prov({}, basis()) },
  georefUnknown: { provenance: prov({ crsKnown: false, horizontalCrs: 'not georeferenced', datumKnown: false, verticalDatum: 'unknown', contourStyleLabel: 'unknown', contourStyle: null } as never), linearUnit: 'unknown' },
  geographic: { crs: null, verticalDatum: null, linearUnit: 'unknown', worldOrigin: null },
  datumUnknown: { provenance: prov({ datumKnown: false, verticalDatum: 'unknown' } as never, null, null) },
  trueNorth: { trueNorth: { convergenceDeg: -1.29 } },
  trueNorthEast: { trueNorth: { convergenceDeg: 1.29 }, orientation: 'portrait' },
  feet: { linearUnit: 'us-survey-foot', provenance: prov({}, null, 0.3048) },
  units: { linearUnit: 'unknown' },
  noRelief: { relief: null },
  allKinds: { model: allKinds },
  noContours: { model: none, relief: null },
  measured: { measurements: MEASUREMENTS, includeAnnotations: true, annotations: ANNOTATIONS, notes: 'Depth and height notes 1.5', preparedBy: 'A. Person and Sons' },
  measuredPortrait: { measurements: MEASUREMENTS, includeAnnotations: true, annotations: ANNOTATIONS, orientation: 'portrait', sheet: 'a4', provenance: prov({}, basis({ coverage: 'resident-only', residentPointCount: 2276133 })) },
  many: { measurements: Array.from({ length: 8 }, () => MEASUREMENTS).flat(), includeAnnotations: true, annotations: Array.from({ length: 9 }, () => ANNOTATIONS).flat(), orientation: 'portrait', provenance: prov() },
  oneMore: { measurements: MEASUREMENTS.slice(0, 1), includeAnnotations: true, annotations: ANNOTATIONS.slice(3) },
  engineering: { purpose: contourStudioExportIntent('engineering-plan'), provenance: prov() },
  survey: { purpose: contourStudioExportIntent('survey-review'), provenance: prov(), readiness: 'ready' },
  research: { purpose: contourStudioExportIntent('terrain-research'), provenance: prov(), style: 'dark' },
  presentation: { purpose: contourStudioExportIntent('presentation-map'), provenance: prov(), relief: null },
  custom: { purpose: custom, provenance: prov() },
  customPlain: { purpose: { ...custom, analytical: false, cartographic: false, cartographicSmoothing: false, allowExploratory: false, completePackage: false }, model: { ...r.model, contourStyle: 'crisp' } as never, readiness: 'ready' },
  cartographicOnly: { purpose: { ...custom, analytical: false, generalizeToleranceCells: 0 }, model: { ...r.model, contourStyle: 'crisp' } as never },
  crisp: { model: { ...r.model, contourStyle: 'crisp' } as never },
  styles: { model: { ...r.model, contourStyle: 'semi-geometric' } as never },
  generalized: { provenance: prov({ contourStyle: 'generalized', contourStyleLabel: 'Generalized' } as never) },
  a3: { sheet: 'a3', provenance: prov({}, basis({ coverage: 'sampled', loadStride: 55 })) },
  a3Portrait: { sheet: 'a3', orientation: 'portrait', provenance: prov() },
  a4Portrait: { sheet: 'a4', orientation: 'portrait', provenance: prov({ accuracy: acc() } as never) },
};
