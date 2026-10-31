/**
 * classSharesAfterRestore.test.ts
 *
 * Clear classes → Auto-classify → Restore earlier classes. The Scan Report went
 * back to the even-sample basis but the Classes legend stayed on "Shares of the
 * loaded display sample.": Auto-classify reset the legend without the
 * pre-reduction class counts, so Restore had nothing to return to. An edit that
 * keeps every class count (two classes swapped) must still leave the even-sample
 * basis, since the sample no longer describes the codes on screen.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { classDigest, classSampleOf, cloudClassShareBasis, heldClassCounts } from '../src/model/classShareBasis';
import { ClassLegendPanel } from '../src/ui/ClassLegendPanel';
import { installFakeDom } from './support/measurePanelDom';

const derive = vi.hoisted(() => vi.fn());
vi.mock('../src/render/class/deriveClassificationAsync', () => ({ deriveClassificationAsync: derive }));
vi.mock('../src/render/class/classifierCues', () => ({ classifierOptions: () => ({}), classifierVerticalRefusal: () => null }));

beforeAll(() => {
  installFakeDom({ fragment: true });
});

function cloudOf(codes: (i: number) => number, n: number, extra: Partial<ConstructorParameters<typeof PointCloud>[0]> = {}): PointCloud {
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) cls[i] = codes(i);
  return new PointCloud({ positions: new Float32Array(n * 3), classification: cls, origin: [0, 0, 0], sourceFormat: 'laz', name: 's.laz', ...extra });
}

describe('Classes legend shares after Restore', () => {
  it('returns to the even-sample basis once the source classes are back', async () => {
    const decoded = cloudOf((i) => (i < 600 ? 1 : i < 900 ? 2 : 5), 1000, { loadStride: 24, declaredPointCount: 24_000 });
    const held = cloudOf((i) => (i < 33 ? 1 : i < 66 ? 2 : 5), 99, { loadStride: 24, declaredPointCount: 24_000 });
    held.classSample = classSampleOf(decoded, held);
    const source = held.classification!.slice();
    const legend = new ClassLegendPanel();
    legend.setClasses(heldClassCounts(source), { loaded: 99, declared: 24_000, shares: held.classSample, heldDigest: classDigest(source) });
    expect(legend.shareNote()).toBe('Shares of an even sample of 1,000 points.');

    // Clear, then Auto-classify through the real action.
    held.setClassificationState('cleared', undefined, source);
    held.classification!.fill(1);
    derive.mockResolvedValue({ codes: new Uint8Array(99).fill(2), confidence: 0.5, warnings: [], classifier: { method: 'm@1' } });
    const { runDeriveClassification } = await import('../src/app/classifyActions');
    await runDeriveClassification({
      viewer: {
        getCloud: () => held,
        classificationEpoch: () => 0,
        applyDerivedClassification: (_id: string, codes: Uint8Array) => { held.classification!.set(codes); return true; },
      } as never,
      activeId: () => 'a',
      crsService: { crsRevision: () => 1, context: () => ({}) as never },
      toast: () => {},
      legend,
      setDerivedConfidence: () => {},
      afterDerive: () => {},
    });
    expect(legend.shareNote()).toBe('Shares of the loaded display sample.');

    // Restore: the class-edit hook recounts the legend from the source codes.
    held.classification!.set(source);
    legend.replaceCounts(heldClassCounts(held.classification!), classDigest(held.classification!));
    expect(legend.shareNote()).toBe('Shares of an even sample of 1,000 points.');
    expect(legend.classSummary().find((r) => r.code === 1)?.share).toBeCloseTo(60, 6);
  });

  it('leaves the even-sample basis after two classes are swapped', () => {
    const decoded = cloudOf((i) => (i < 600 ? 1 : i < 900 ? 2 : 5), 1000, { loadStride: 24, declaredPointCount: 24_000 });
    const held = cloudOf((i) => (i < 33 ? 1 : i < 66 ? 2 : 5), 99, { loadStride: 24, declaredPointCount: 24_000 });
    held.classSample = classSampleOf(decoded, held);
    const legend = new ClassLegendPanel();
    legend.setClasses(heldClassCounts(held.classification!), { loaded: 99, declared: 24_000, shares: held.classSample, heldDigest: classDigest(held.classification!) });
    expect(legend.shareNote()).toBe('Shares of an even sample of 1,000 points.');

    // Swap classes 1 and 2: every count is unchanged, the codes are not.
    const c = held.classification!;
    for (let i = 0; i < c.length; i++) if (c[i] === 1) c[i] = 2; else if (c[i] === 2) c[i] = 1;
    legend.replaceCounts(heldClassCounts(c), classDigest(c));
    expect(legend.shareNote()).toBe('Shares of the loaded display sample.');
    expect(legend.classSummary().find((r) => r.code === 1)?.share).toBeCloseTo(100 / 3, 6);
    const report = cloudClassShareBasis(held)!;
    expect(report.fromSample).toBe(false);
    expect((report.counts.get(1)! / report.total) * 100).toBeCloseTo(100 / 3, 6);

    // Swapping back puts the load's codes back, and the sample applies again.
    for (let i = 0; i < c.length; i++) if (c[i] === 1) c[i] = 2; else if (c[i] === 2) c[i] = 1;
    legend.replaceCounts(heldClassCounts(c), classDigest(c));
    expect(legend.shareNote()).toBe('Shares of an even sample of 1,000 points.');
    expect(cloudClassShareBasis(held)!.fromSample).toBe(true);
  });
});
