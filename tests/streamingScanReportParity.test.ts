/**
 * streamingScanReportParity.test.ts
 *
 * The streaming Scan Report and the static one describe the same file. When
 * they use different words for the same LAS field, or claim a unit one of them
 * has not established, a reader cannot tell which report to believe.
 *
 * Four drifts are pinned here. The streaming octree spacing stamped a literal
 * " m" on a figure that is in the SOURCE CRS's linear units, so a state-plane
 * feet COPC read ~3.28x too large labelled as metres. The LAS
 * `system_identifier` was still called "Capture Sensor" after the static report
 * stopped calling it that, the field naming hardware, software, a producing
 * process or an organisation. The LAS File Creation Day/Year is "File created",
 * never "Captured": it is when the file was written, not when the survey was
 * flown. And the Float32 in-memory quantization was disclosed on the static
 * side only, although the streaming decoder writes the same Float32 positions
 * against a render origin.
 *
 * The rows are composed here exactly as `runStreamingModules` composes them in
 * `src/main.ts` — basis, extent, structure, provenance — because that shell
 * function cannot be imported. Between them these four producers emit every row
 * the streaming report has, so a claim made over all of them is a claim about
 * the whole report whatever order the shell puts them in.
 */

import {
  streamingProvenanceRows,
  streamingReportBasisRow,
  streamingStructureRows,
  type StreamingStructureSource,
} from '../src/app/streamingScanReport';
import { streamingExtentRows } from '../src/analysis/streamingExtentRows';
import { scanReport } from '../src/analysis/modules/scanReport';
import { PointCloud } from '../src/model/PointCloud';
import { spatialContextFrom, type SpatialContext } from '../src/geo/SpatialContext';
import type { AnalysisRow } from '../src/analysis/ModuleApi';
import type { CloudMetadata } from '../src/model/PointCloud';
import type { CrsInfo } from '../src/io/crs';

/** A resolved frame built from a minimal CRS override, as the shell resolves one. */
function ctx(o: Partial<CrsInfo>): SpatialContext {
  return spatialContextFrom({
    source: 'epsg',
    name: 'EPSG:32610',
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    ...o,
  } as CrsInfo);
}

const METRE = ctx({ linearUnit: 'metre', linearUnitToMetres: 1 });
const FOOT = ctx({ linearUnit: 'foot', linearUnitToMetres: 0.3048, name: 'EPSG:2231' });
const UNRESOLVED = ctx({ linearUnit: 'unknown', linearUnitToMetres: 1, name: 'local' });

// One geometry, expressed twice: absolute source corners for the streaming
// header, and the same corners as a local residual plus the origin the loader
// subtracted for the static cloud. The two frames are deliberately identical so
// the precision figures are comparable rather than merely similar.
const ORIGIN: [number, number, number] = [1000, 2000, 30];
const MIN: [number, number, number] = [1000, 2000, 30];
const MAX: [number, number, number] = [2000, 3000, 130];
const SOURCE_POINTS = 1_000_000;

type ReportCloud = StreamingStructureSource & {
  readonly metadata?: {
    readonly header?: { min: readonly [number, number, number]; max: readonly [number, number, number] };
    readonly info?: { spacing?: number };
    readonly captureSensor?: string;
    readonly sourceSoftware?: string;
    readonly captureDate?: string;
  };
};

function streamingCloud(over: Partial<ReportCloud> = {}): ReportCloud {
  return {
    renderOrigin: ORIGIN,
    metadata: { header: { min: MIN, max: MAX }, info: { spacing: 2.5 } },
    maxDepth: () => 5,
    octree: { nodes: () => [1, 2, 3] },
    ...over,
  };
}

/** The whole streaming report, assembled the way the shell assembles it. */
function streamingRowsFor(cloud: ReportCloud, frame: SpatialContext): AnalysisRow[] {
  const rows: AnalysisRow[] = [streamingReportBasisRow()];
  const header = cloud.metadata?.header;
  if (header) {
    const ext = streamingExtentRows(header, frame, SOURCE_POINTS);
    if (!ext.unitConfirmed) {
      rows.push({
        label: 'Units',
        value: 'unconfirmed — source CRS declares no linear unit; extents shown in source units',
        status: 'warn',
      });
    }
    for (const r of ext.rows) rows.push({ label: r.label, value: r.value, status: 'info' });
  }
  rows.push(...streamingStructureRows(cloud, frame));
  rows.push(...streamingProvenanceRows(cloud.metadata));
  return rows;
}

function staticCloud(metadata?: CloudMetadata): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 1000, 1000, 100]),
    origin: ORIGIN,
    sourceFormat: 'laz',
    name: 'parity.laz',
    ...(metadata ? { metadata } : {}),
  });
}

const valueOf = (rows: readonly AnalysisRow[], label: string): string | undefined =>
  rows.find((r) => r.label === label)?.value;

describe('streaming octree spacing carries the unit it earned', () => {
  test('metre CRS: the source figure is metres and says so', () => {
    expect(valueOf(streamingStructureRows(streamingCloud(), METRE), 'Octree root spacing'))
      .toBe('2.50 m');
  });

  test('foot CRS: 2.5 source units is 0.76 m, never "2.50 m"', () => {
    const v = valueOf(streamingStructureRows(streamingCloud(), FOOT), 'Octree root spacing');
    expect(v).not.toBe('2.50 m');
    expect(v).toBe('0.76 m');
  });

  test('unresolved unit: the figure stays in source units', () => {
    expect(valueOf(streamingStructureRows(streamingCloud(), UNRESOLVED), 'Octree root spacing'))
      .toBe('2.50 (source units)');
  });
});

test('unresolved unit: no metric label is fabricated anywhere in the report', () => {
  const rows = streamingRowsFor(streamingCloud(), UNRESOLVED);
  expect(rows.length).toBeGreaterThan(5);
  for (const r of rows) {
    expect(r.value).not.toMatch(/\d\s*(?:mm|cm|km|m)\b/);
    expect(r.value).not.toMatch(/pts\/m²/);
  }
});

describe('provenance labels match the static report word for word', () => {
  const declared = {
    captureSensor: 'Quantum Spatial',
    sourceSoftware: 'PDAL 2.6.0',
    captureDate: 'Jan 12, 2021',
  };
  const streamingRows = streamingProvenanceRows(declared);
  const staticRows = scanReport.run(staticCloud(declared), undefined, { spatialContext: METRE }).rows;

  test('LAS system_identifier is "System identifier" on both sides', () => {
    expect(valueOf(staticRows, 'System identifier')).toBe('Quantum Spatial');
    expect(valueOf(streamingRows, 'System identifier')).toBe('Quantum Spatial');
    expect(streamingRows.find((r) => r.label === 'Capture Sensor')).toBeUndefined();
  });

  test('the header creation date is "File created" on both sides, never "Captured"', () => {
    expect(valueOf(staticRows, 'File created')).toBe('Jan 12, 2021');
    expect(valueOf(streamingRows, 'File created')).toBe('Jan 12, 2021');
    expect(streamingRows.find((r) => r.label === 'Captured')).toBeUndefined();
    expect(staticRows.find((r) => r.label === 'Captured')).toBeUndefined();
  });
});

describe('in-memory precision is one measurement, reported twice', () => {
  const streamingRows = streamingStructureRows(streamingCloud(), METRE);
  const staticRows = scanReport.run(staticCloud(), undefined, { spatialContext: METRE }).rows;

  test('the same frame and bounds produce the same canonical figures', () => {
    expect(valueOf(streamingRows, 'In-memory resolution'))
      .toBe(valueOf(staticRows, 'In-memory resolution'));
    expect(valueOf(streamingRows, 'Quantization basis'))
      .toBe(valueOf(staticRows, 'Quantization basis'));
  });

  test('the row describes the representation, not the survey', () => {
    const v = valueOf(streamingRows, 'In-memory resolution') ?? '';
    expect(v).toContain('worst case');
    expect(v).toContain('mean over the reach');
    expect(v).not.toMatch(/accuracy/i);
  });

  test('a source with no render origin gets no precision row rather than a guess', () => {
    const rows = streamingStructureRows(streamingCloud({ renderOrigin: undefined }), METRE);
    expect(rows.find((r) => r.label === 'In-memory resolution')).toBeUndefined();
    expect(rows.find((r) => r.label === 'Quantization basis')).toBeUndefined();
  });

  test('the octree ROOT CUBE is not what the reach is taken from', () => {
    // A cube 10x the data extent must not change the figure: the tight header
    // box is read first, and the cube is only the unreadable-box fallback.
    const wide = streamingCloud({ localBounds: () => [-5000, -5000, -5000, 5000, 5000, 5000] });
    expect(valueOf(streamingStructureRows(wide, METRE), 'In-memory resolution'))
      .toBe(valueOf(streamingRows, 'In-memory resolution'));
  });
});

test('equivalent geometry reports equivalent metric units on both sides', () => {
  const streamingRows = streamingRowsFor(streamingCloud(), METRE);
  const staticRows = scanReport.run(staticCloud(), undefined, { spatialContext: METRE }).rows;
  for (const label of ['Width', 'Depth', 'Height']) {
    expect(valueOf(streamingRows, label)).toBe(valueOf(staticRows, label));
  }
  expect(valueOf(streamingRows, 'Density')).toMatch(/ pts\/m²$/);
  expect(valueOf(staticRows, 'Density')).toMatch(/ pts\/m²$/);
});

test('the report states whether its figures are declared or resident', () => {
  const basis = streamingReportBasisRow();
  expect(basis.label).toBe('Report basis');
  expect(basis.value).toContain('hierarchy index');
  expect(basis.value).toContain('resident');
});
