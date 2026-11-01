/**
 * classProvenanceOnScanSwitch.test.ts
 *
 * 200 source records, 100 ground and 100 unclassified; the held sample keeps
 * the 100 ground points. Auto-classify left them derived ground, and the legend
 * and the Scan Report both read 100 % ground. Switching to another scan and
 * back reseeded the legend as the source's: it read 50 % off the load sample
 * and dropped the Derived caption, while the report still read 100 %.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { classDigest, classSampleOf, cloudClassShareBasis, heldClassCounts } from '../src/model/classShareBasis';
import { ClassLegendPanel } from '../src/ui/ClassLegendPanel';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom({ fragment: true });
});

function cloudOf(codes: (i: number) => number, n: number): PointCloud {
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) cls[i] = codes(i);
  return new PointCloud({ positions: new Float32Array(n * 3), classification: cls, origin: [0, 0, 0], sourceFormat: 'laz', name: 'a.laz', loadStride: 2, declaredPointCount: 200 });
}

/** What the shell's refreshClassLegend does for a layer: seed, then restore its provenance. */
function reseed(legend: ClassLegendPanel, cloud: PointCloud): void {
  const cls = cloud.classification!;
  legend.setClasses(heldClassCounts(cls), { loaded: cloud.pointCount, declared: cloud.declaredPointCount, shares: cloud.classSample, heldDigest: classDigest(cls) });
  const prov = cloud.classificationProvenance;
  if (prov !== 'none') legend.syncProvenance(prov);
}

const groundShare = (legend: ClassLegendPanel) => legend.classSummary().find((r) => r.code === 2)?.share;

describe('class provenance after switching scans', () => {
  it('keeps derived ground at 100 % on the legend and the report across A, B, A', () => {
    const decoded = cloudOf((i) => (i < 100 ? 2 : 1), 200);
    const a = cloudOf(() => 2, 100);
    a.classSample = classSampleOf(decoded, a);
    const source = a.classification!.slice();
    a.setClassificationState('cleared', undefined, source);
    a.attachDerivedClassification(source.slice(), 'm@1');
    expect(a.classificationProvenance).toBe('derived');

    const legend = new ClassLegendPanel();
    reseed(legend, a);
    expect(groundShare(legend)).toBeCloseTo(100, 6);
    expect(legend.classificationIsDerived()).toBe(true);

    const b = cloudOf((i) => (i % 2 ? 2 : 6), 100);
    reseed(legend, b);
    expect(legend.classificationIsDerived()).toBe(false);

    reseed(legend, a);
    expect(legend.classificationIsDerived()).toBe(true);
    expect(legend.shareNote()).toBe('Shares of the loaded display sample.');
    expect(groundShare(legend)).toBeCloseTo(100, 6);
    const report = cloudClassShareBasis(a)!;
    expect(report.fromSample).toBe(false);
    expect((report.counts.get(2)! / report.total) * 100).toBeCloseTo(100, 6);
  });

  it('keeps the cleared caption and the held basis for a cleared layer', () => {
    const decoded = cloudOf((i) => (i < 100 ? 2 : 1), 200);
    const a = cloudOf(() => 2, 100);
    a.classSample = classSampleOf(decoded, a);
    const source = a.classification!.slice();
    a.setClassificationState('cleared', undefined, source);
    a.classification!.fill(1);

    const legend = new ClassLegendPanel();
    reseed(legend, a);
    expect(legend.classificationIsDerived()).toBe(false);
    expect(legend.shareNote()).toBe('Shares of the loaded display sample.');
    expect(cloudClassShareBasis(a)!.fromSample).toBe(false);
  });

  it('returns a source layer to the even-sample basis', () => {
    const decoded = cloudOf((i) => (i < 100 ? 2 : 1), 200);
    const a = cloudOf(() => 2, 100);
    a.classSample = classSampleOf(decoded, a);
    const legend = new ClassLegendPanel();
    reseed(legend, a);
    expect(legend.shareNote()).toBe('Shares of an even sample of 200 points.');
    expect(groundShare(legend)).toBeCloseTo(50, 6);
    expect(cloudClassShareBasis(a)!.fromSample).toBe(true);
  });
});
