/**
 * Scan Report / Health Check / Layer Health rows must state the BASIS of a
 * figure that is a constant of the sampler, a header field, or a nominal
 * average — never present it as a measurement of the file.
 */
import { describe, expect, test } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { scanReport } from '../src/analysis/modules/scanReport';
import { healthCheck } from '../src/analysis/modules/healthCheck';
import { buildLayerHealth, type LayerHealthInput } from '../src/app/layerHealth';
import type { AnalysisRow } from '../src/analysis/ModuleApi';
import { scopeFrom } from '../src/render/class/classScope';

function rowByLabel(rows: readonly AnalysisRow[], label: string): AnalysisRow {
  const r = rows.find((x) => x.label === label);
  if (!r) throw new Error(`row "${label}" missing`);
  return r;
}

const POS = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 1]);

/** Strided AND voxel-reduced: header 40 → stride decode 12 → 4 centroids. */
function voxelCloud(extra: Partial<ConstructorParameters<typeof PointCloud>[0]> = {}): PointCloud {
  return new PointCloud({
    positions: POS, origin: [0, 0, 0], sourceFormat: 'laz', name: 'voxel',
    declaredPointCount: 40, decodedPointCount: 12, loadStride: 4, ...extra,
  });
}
/** Strided only: header 40 → 4 records decoded, nothing averaged. */
function stridedCloud(): PointCloud {
  return new PointCloud({
    positions: POS, origin: [0, 0, 0], sourceFormat: 'laz', name: 'strided',
    declaredPointCount: 40, decodedPointCount: 4, loadStride: 10,
  });
}
function fullCloud(): PointCloud {
  return new PointCloud({ positions: POS, origin: [0, 0, 0], sourceFormat: 'laz', name: 'full' });
}

describe('Health Check — duplicate / outlier rows name their sample', () => {
  test('(1) voxel centroids: Duplicate Points is info with the basis, not a pass on the file', () => {
    const row = rowByLabel(healthCheck.run(voxelCloud()).rows, 'Duplicate Points');
    expect(row.status).toBe('info');
    expect(row.value).toContain('None');
    expect(row.value).toContain('4-point display sample');
    expect(row.value).toContain('voxel centroids');
    expect(row.value).toContain('not run on the full cloud');
  });
  test('(1) stride-only sample keeps pass but names the sample', () => {
    const row = rowByLabel(healthCheck.run(stridedCloud()).rows, 'Duplicate Points');
    expect(row.status).toBe('pass');
    expect(row.value).toContain('4-point display sample');
    expect(row.value).toContain('not run on the full cloud');
  });
  test('(1) full cloud is a plain pass', () => {
    const row = rowByLabel(healthCheck.run(fullCloud()).rows, 'Duplicate Points');
    expect(row.status).toBe('pass');
    expect(row.value).toBe('None');
  });
  test('(2) Stray Outliers on centroids is info and discloses averaging', () => {
    const tight: number[] = [];
    for (let i = 0; i < 20; i++) tight.push(i * 0.1, i * 0.1, i * 0.1);
    const cloud = new PointCloud({
      positions: new Float32Array(tight), origin: [0, 0, 0], sourceFormat: 'laz', name: 'v',
      declaredPointCount: 400, decodedPointCount: 100, loadStride: 4,
    });
    const row = rowByLabel(healthCheck.run(cloud).rows, 'Stray Outliers');
    expect(row.status).toBe('info');
    expect(row.value).toContain('voxel centroids');
    expect(row.value).toContain('not run on the full cloud');
  });
});

describe('Scan Report — provenance labels', () => {
  const cloud = new PointCloud({
    positions: POS, origin: [0, 0, 0], sourceFormat: 'laz', name: 'meta',
    metadata: { captureSensor: 'Quantum Spatial', captureDate: 'Jan 12, 2021' },
  });
  const rows = scanReport.run(cloud).rows;
  test('(3) header creation date is "File created", never "Captured"', () => {
    expect(rowByLabel(rows, 'File created').value).toBe('Jan 12, 2021');
    expect(rows.find((r) => r.label === 'Captured')).toBeUndefined();
  });
  test('(4) LAS system_identifier is "System identifier"', () => {
    expect(rowByLabel(rows, 'System identifier').value).toBe('Quantum Spatial');
    expect(rows.find((r) => r.label === 'Capture Sensor')).toBeUndefined();
  });
});

describe('Scan Report — sample and nominal bases', () => {
  test('(8) Loaded names both reductions with reconciling counts', () => {
    const v = rowByLabel(scanReport.run(voxelCloud()).rows, 'Loaded').value;
    expect(v).toBe('4 (display sample: stride to 12, then voxel-reduced to 4 centroids)');
    const s = rowByLabel(scanReport.run(stridedCloud()).rows, 'Loaded').value;
    expect(s).toBe('4 (display sample: 1-in-10 stride)');
  });
  test('(9) strided Density / Spacing state the mixed basis', () => {
    const rows = scanReport.run(stridedCloud()).rows;
    const d = rowByLabel(rows, 'Density').value;
    expect(parseFloat(d)).toBeCloseTo(10, 3);
    expect(d).toContain('mean: declared count over the display-sample footprint');
    const s = rowByLabel(rows, 'Spacing').value;
    expect(s).toContain('nominal');
  });
  test('(9) a fully loaded cloud keeps the bare figure', () => {
    expect(rowByLabel(scanReport.run(fullCloud()).rows, 'Density').value).toBe('1.0 pts/unit²');
  });
  test('(10) in-memory resolution says "mean over the reach", not "typical"', () => {
    const cloud = new PointCloud({
      positions: POS, origin: [1000, 0, 0], sourceFormat: 'laz', name: 'm',
      metadata: { crs: { kind: 'projected', name: 'x', linearUnit: 'metre', linearUnitToMetres: 1 } as never },
    });
    const v = rowByLabel(scanReport.run(cloud).rows, 'In-memory resolution').value;
    expect(v).toContain('mean over the reach');
    expect(v).not.toContain('typical');
  });
  test('(7) class 1 is not counted as classified in the headline', () => {
    const cls = new Uint8Array([1, 1, 1, 2]);
    const rows = scanReport.run(voxelCloud({ classification: cls })).rows;
    expect(rowByLabel(rows, 'Classification').value).toBe(
      'Yes — codes on 100.0 %, 75.0 % unclassified (code 1) of display sample',
    );
    const full = new PointCloud({
      positions: POS, origin: [0, 0, 0], sourceFormat: 'laz', name: 'full',
      classification: new Uint8Array([0, 1, 2, 2]),
    });
    expect(rowByLabel(scanReport.run(full).rows, 'Classification').value).toBe(
      'Yes — codes on 75.0 %, 25.0 % unclassified (code 1)',
    );
  });
});

describe('Scan Report — class scope on a display sample', () => {
  test('(11) a solo\'d class keeps the file count, the Loaded row and adds Visible', () => {
    const cloud = voxelCloud({ classification: new Uint8Array([2, 2, 6, 6]) });
    const rows = scanReport.run(cloud, undefined, {
      scope: scopeFrom([2], [2, 6], (c) => `class ${c}`),
    }).rows;
    expect(rowByLabel(rows, 'Point Count').value).toBe('40');
    expect(rowByLabel(rows, 'Point Count').scope).toBeUndefined();
    expect(rowByLabel(rows, 'Loaded').value).toContain('display sample: stride to 12');
    const visible = rowByLabel(rows, 'Visible');
    expect(visible.value).toBe('2 of the 4-point display sample');
    expect(visible.scope?.kind).toBe('subset');
  });
});

describe('Layer Health — loading and vertical unit', () => {
  function base(over: Partial<LayerHealthInput> = {}): LayerHealthInput {
    return {
      name: 'a.laz', crsName: 'x', crsSource: 'las-vlr', horizontalUnit: 'metre',
      verticalUnit: 'metre', verticalDatum: 'NAVD88', compatibility: 'verified', mounted: true,
      sourceOrigin: [0, 0, 0], frameOffset: [0, 0, 0], precisionMm: 0.02,
      precisionBasis: 'projected-linear-unit', streaming: false, soleLayer: true, ...over,
    };
  }
  const row = (rows: readonly { label: string; value: string; status: string }[], l: string) => {
    const r = rows.find((x) => x.label === l);
    if (!r) throw new Error(l);
    return r;
  };
  test('(5) a display sample is not "fully loaded"', () => {
    const r = row(buildLayerHealth(base({ residency: { resident: 2_880_236, source: 53_670_848 } })), 'Loading');
    expect(r.value).toBe('display sample — 2,880,236 of 53,670,848 resident');
    expect(r.status).toBe('info');
  });
  test('(5) resident == source is fully loaded', () => {
    const r = row(buildLayerHealth(base({ residency: { resident: 10, source: 10 } })), 'Loading');
    expect(r.value).toBe('fully loaded');
    expect(r.status).toBe('ok');
  });
  test('(5) no source count known → residency undisclosed, not claimed', () => {
    const r = row(buildLayerHealth(base({ residency: null })), 'Loading');
    expect(r.value).toBe('fully loaded (no source count declared)');
    expect(r.status).toBe('info');
  });
});
