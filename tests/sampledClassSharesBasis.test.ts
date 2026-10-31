/**
 * sampledClassSharesBasis.test.ts
 *
 * A large scan opened as a display sample is strided, then voxel-reduced. The
 * voxel pass collapses dense ground far more than sparse canopy, so class
 * SHARES counted on the held centroids are biased. Shares are stated from the
 * class counts of the strided records instead, with the basis named, and only
 * while the classes are still the source's. After an edit they fall back to
 * the loaded points with the loaded-sample wording.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PointCloud } from '../src/model/PointCloud';
import {
  classDigest,
  classSampleOf,
  cloudClassShareBasis,
  heldClassCounts,
  unclassifiedShare,
} from '../src/model/classShareBasis';
import { scanReport } from '../src/analysis/modules/scanReport';
import { ClassLegendPanel } from '../src/ui/ClassLegendPanel';
import { classificationShare } from '../src/app/reportExport';
import { buildDatasetSummary, type MetadataInputs } from '../src/report/ReportMetadataSection';
import { buildScanFitness, type FitnessInputs } from '../src/terrain/quality/scanFitness';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom({ fragment: true });
});

/** A strided cloud: 60 % class 1, 30 % class 2, 10 % class 5. */
function stridedCloud(): PointCloud {
  const n = 1000;
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) cls[i] = i < 600 ? 1 : i < 900 ? 2 : 5;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions[i * 3] = i;
  return new PointCloud({
    positions, classification: cls, origin: [0, 0, 0], sourceFormat: 'laz', name: 's.laz',
    declaredPointCount: 24_000, decodedPointCount: n, loadStride: 24,
  });
}

/** Its voxel reduction: 100 centroids, a third of each class (biased). */
function reducedFrom(src: PointCloud): PointCloud {
  const n = 99;
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) cls[i] = i < 33 ? 1 : i < 66 ? 2 : 5;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions[i * 3] = i;
  const out = new PointCloud({
    positions, classification: cls, origin: [0, 0, 0], sourceFormat: 'laz', name: 's.laz',
    declaredPointCount: src.declaredPointCount, decodedPointCount: src.decodedPointCount,
    loadStride: src.loadStride, pointReduction: 'voxel-centroids',
  });
  out.classSample = classSampleOf(src, out);
  return out;
}

function row(rows: readonly { label: string; value: string }[], label: string): string {
  return rows.find((r) => r.label === label)?.value ?? '';
}

describe('class shares on a voxel-reduced display sample', () => {
  it('states shares from the strided records and names the basis', () => {
    const b = cloudClassShareBasis(reducedFrom(stridedCloud()));
    expect(b?.fromSample).toBe(true);
    expect(b?.total).toBe(1000);
    expect(b?.phrase).toBe('an even sample of 1,000 points');
    expect(unclassifiedShare(b!)).toBeCloseTo(0.6, 6);
  });

  it('falls back to the loaded points once the classes are edited', () => {
    const cloud = reducedFrom(stridedCloud());
    const before = cloud.classification!.slice();
    cloud.classification![0] = 2; // a lasso edit moves one point
    let b = cloudClassShareBasis(cloud);
    expect(b?.fromSample).toBe(false);
    expect(b?.phrase).toBe('the loaded display sample');
    // Restore puts the source codes back, and the histogram applies again.
    cloud.classification!.set(before);
    b = cloudClassShareBasis(cloud);
    expect(b?.fromSample).toBe(true);
    // A cleared classification is never the source the histogram counted.
    cloud.setClassificationState('cleared', undefined, before);
    expect(cloudClassShareBasis(cloud)?.fromSample).toBe(false);
  });

  it('Scan Report classification line uses the strided basis', () => {
    const v = row(scanReport.run(reducedFrom(stridedCloud())).rows, 'Classification');
    expect(v).toContain('60.0 % unclassified');
    expect(v).toContain('of an even sample of 1,000 points');
  });

  it('Classes shares and caption use the strided basis, counts stay loaded', () => {
    const cloud = reducedFrom(stridedCloud());
    const panel = new ClassLegendPanel();
    panel.setClasses(heldClassCounts(cloud.classification!), {
      loaded: cloud.pointCount, declared: cloud.declaredPointCount, shares: cloud.classSample,
      heldDigest: classDigest(cloud.classification!),
    });
    const s = panel.classSummary();
    expect(s.find((r) => r.code === 1)?.share).toBeCloseTo(60, 6);
    expect(panel.shareNote()).toBe('Shares of an even sample of 1,000 points.');
    // An in-place edit: shares follow the loaded points again.
    const edited = new Map(heldClassCounts(cloud.classification!));
    edited.set(1, 32);
    edited.set(2, 34);
    panel.replaceCounts(edited);
    expect(panel.shareNote()).toBe('Shares of the loaded display sample.');
    expect(panel.classSummary().find((r) => r.code === 1)?.share).toBeCloseTo((32 / 99) * 100, 6);
  });

  it('report PDF dataset row names the basis', () => {
    const share = classificationShare(reducedFrom(stridedCloud()));
    expect(share.unclassifiedFraction).toBeCloseTo(0.6, 6);
    const rows = buildDatasetSummary({
      fileName: 's.laz', format: 'LAZ', sourcePointCount: 24_000, width: 1, depth: 1, height: 1,
      density: Number.NaN, hasRgb: false, hasIntensity: false, hasClassification: true, ...share,
    } as MetadataInputs);
    expect(row(rows, 'Classification')).toContain('60.0 % ASPRS code 0/1 (unclassified, of an even sample of 1,000 points)');
  });

  it('terrain validation names the basis of the unclassified share', () => {
    const f = buildScanFitness({
      status: 'Good', score: 80, crsKnown: true, datumKnown: true, crsName: 'x', datumName: 'y',
      measuredFraction: 0.9, groundDensityPerM2: 10, verticalRmse: 0.05, unit: 'm', unitToMetres: 1,
      unclassifiedFraction: 0.3, unclassifiedBasis: 'an even sample of 1,000 points',
      hasGroundClass: true, coverageMode: 'full',
    } as FitnessInputs);
    const c = f.dimensions.find((d) => d.key === 'classification');
    expect(c?.summary).toContain('30% of points are unclassified (of an even sample of 1,000 points)');
  });
});

describe('Scan Report after a class edit', () => {
  it('the class-edit hook re-runs the active scan report', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const start = main.indexOf('v.onClassificationEdited = (id) =>');
    expect(start).toBeGreaterThan(-1);
    const hook = main.slice(start, main.indexOf('\n});', start));
    expect(hook).toContain('refreshScopedReport()');
  });
});
