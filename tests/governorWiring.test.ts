import { afterEach, describe, expect, it } from 'vitest';

import {
  GOVERNOR_WINDOW,
  GovernorWiring,
  KEEP_HASH_STEP,
  STILL_MS,
  governedDpr,
  governedUploadLimits,
  installGovernor,
  uninstallGovernor,
} from '../src/render/perf/governorWiring';
import { GOVERNOR_SLOT, governDpr, governor } from '../src/render/perf/governorHook';
import { TARGET_FRAME_MS, SWITCH_THRESHOLDS } from '../src/render/perf/frameBudgetGovernor';
import { feedFrameMs } from '../src/perf/navProbeHook';
import { makeStreamingCommit } from '../src/render/streaming/meteredCommit';
import { fadeHashUnit, PHI_CONJUGATE } from '../src/render/streaming/fadeDither';
import * as tsl from 'three/tsl';
import type { KeepNodeBuilders } from '../src/render/perf/governorHook';

const TSL = tsl as unknown as KeepNodeBuilders;


/** Frame time whose median alone gives `load` (load = (ms - T) / 2T). */
const msAt = (load: number): number => TARGET_FRAME_MS * (1 + 2 * load);

function fill(g: GovernorWiring, ms: number): void {
  for (let i = 0; i < GOVERNOR_WINDOW; i++) g.frameMs(ms);
}

afterEach(() => uninstallGovernor());

describe('off (no governor installed)', () => {
  it('every hook is the identity', () => {
    expect(governor()).toBeNull();
    expect(governDpr(1.75, 1, 2)).toBe(1.75);
    feedFrameMs(null, 80); // no sink: nothing to feed, nothing thrown
    expect(governor()).toBeNull();
  });

  it('metered commit uses the unscaled limits', () => {
    const c = makeStreamingCommit('metered', false);
    expect(c.pump(8)?.stoppedBy).toBe('drained');
  });
});

describe('applies the policy', () => {
  it('dprPressure lowers the adaptive DPR target toward the floor, never above the target', () => {
    expect(governedDpr(2, 1, 2, 0)).toBe(2);
    expect(governedDpr(2, 1, 2, 0.5)).toBe(1.5);
    expect(governedDpr(2, 1, 2, 1)).toBe(1);
    expect(governedDpr(1.25, 1, 2, 0.25)).toBe(1.25);
    expect(governedDpr(1, 1, 1, 1)).toBe(1); // floor == max: nothing to give
  });

  it('gpuCommitScale scales the node and byte limits, keeping at least one', () => {
    const l = { budgetMs: 4, maxNodes: 8, maxBytes: 1000 };
    expect(governedUploadLimits(l, 1)).toBe(l);
    expect(governedUploadLimits(l, 0.5)).toEqual({ budgetMs: 4, maxNodes: 4, maxBytes: 500 });
    expect(governedUploadLimits(l, 0.01)).toEqual({ budgetMs: 4, maxNodes: 1, maxBytes: 10 });
    const bare: { budgetMs: number; maxNodes?: number } = { budgetMs: 4 };
    expect(governedUploadLimits(bare, 0.5)).toEqual({ budgetMs: 4 });
  });

  it('an installed governor is fed through the frame recorder and answers the hooks', () => {
    const g = installGovernor();
    expect(governor()).toBe(g);
    for (let i = 0; i < GOVERNOR_WINDOW; i++) feedFrameMs(null, msAt(1));
    g.frame('full-refine', false);
    expect(g.policy.load).toBeGreaterThan(0.99);
    expect(g.edl()).toBe(false);
    expect(governDpr(2, 1, 2)).toBe(1);
    const lim = { budgetMs: 4, maxNodes: 8 };
    expect(g.uploadLimits(lim, 5)).toEqual({ budgetMs: 4, maxNodes: 8 }); // pending recorded next frame
    g.frame('full-refine', false);
    expect(g.policy.gpuCommitScale).toBeLessThan(1);
    expect(g.uploadLimits(lim, 5).maxNodes).toBeLessThan(8);
  });

  it('an unloaded frame leaves everything alone', () => {
    const g = new GovernorWiring();
    fill(g, 10);
    g.frame('full-refine', false);
    expect(g.edl()).toBe(true);
    expect(g.dpr(2, 1, 2)).toBe(2);
  });

  it('with no frames recorded it keeps the unloaded policy', () => {
    const g = new GovernorWiring();
    g.frame('moving', true);
    expect(g.policy.load).toBe(0);
    expect(g.edl()).toBe(true);
  });
});

describe('hysteresis', () => {
  const { drop, restore } = SWITCH_THRESHOLDS.edl;
  const between = msAt((drop + restore) / 2);

  it('EDL stays on inside the gap when it was on', () => {
    const g = new GovernorWiring();
    fill(g, between);
    g.frame('full-refine', false);
    expect(g.edl()).toBe(true);
  });

  it('EDL stays off inside the gap after a drop, and returns only below restore', () => {
    const g = new GovernorWiring();
    fill(g, msAt(drop + 0.05));
    g.frame('full-refine', false);
    expect(g.edl()).toBe(false);
    fill(g, between);
    g.frame('full-refine', false);
    expect(g.edl()).toBe(false);
    fill(g, msAt(restore - 0.05));
    g.frame('full-refine', false);
    expect(g.edl()).toBe(true);
  });
});

describe('restated constants', () => {
  it('the DPR step matches adaptiveDpr', async () => {
    const { DPR_QUANT_STEP } = await import('../src/render/adaptiveDpr');
    expect(governedDpr(2, 0.5, 2, 0.4)).toBe(1.5); // 2 - 0.6 = 1.4 → 1.5 on a 0.25 step
    expect(DPR_QUANT_STEP).toBe(0.25);
  });

  it('the slot matches governorHook', () => {
    const g = installGovernor();
    expect((globalThis as Record<string, unknown>)[GOVERNOR_SLOT]).toBe(g);
  });
});

describe('v2 presentation outputs', () => {
  type Mat = { isNodeMaterial: true; sizeNode: unknown; needsUpdate: boolean };
  const mesh = (n: number) => ({
    geometry: { isInstancedBufferGeometry: true, instanceCount: n },
    material: { isNodeMaterial: true, sizeNode: null, needsUpdate: false } as Mat,
  });

  it('moving under load: render scale to 0.6, points to 40%; both restore at once when still', () => {
    const g = new GovernorWiring();
    fill(g, msAt(0.8));
    g.frame('moving', false);
    expect(g.policy.renderScale).toBe(0.6);
    expect(g.policy.pointBudgetFraction).toBe(0.4);
    expect(g.dpr(1, 1, 1)).toBe(0.6);
    expect(g.dpr(2, 2, 2)).toBe(1.2); // floor at max: only the render scale acts
    const big = mesh(1000);
    const small = mesh(10);
    const scene = { children: [big, { children: [small] }] };
    g.points(scene, TSL);
    // The instance count and buffers are untouched; the size graph carries the keep test.
    expect(big.geometry.instanceCount).toBe(1000);
    expect(big.material.needsUpdate).toBe(true);
    expect(g.keepOf(big.material)).toBeCloseTo(0.4);
    expect(g.presentation().reducedMeshes).toBe(2);
    // Lighter frames while moving never raise either output.
    fill(g, msAt(0));
    g.frame('moving', false);
    expect(g.policy.renderScale).toBe(0.6);
    expect(g.settling()).toBe(true);
    // Still: both outputs back in one frame, the fold stays with keep = 1.
    g.frame('coverage', false);
    expect(g.policy.pointBudgetFraction).toBe(1);
    expect(g.policy.renderScale).toBe(1);
    const folded = big.material.sizeNode;
    big.material.needsUpdate = false;
    g.points(scene, TSL);
    expect(g.keepOf(big.material)).toBe(1);
    expect(big.material.sizeNode).toBe(folded);
    expect(g.dpr(1, 1, 1)).toBe(1);
    expect(g.presentation()).toEqual({ renderScale: 1, pointBudgetFraction: 1, reducedMeshes: 0 });
    expect(g.settling()).toBe(false);
    expect(g.renderScaleChanges).toBe(2);
    // Reduced again: the uniform moves, no recompile.
    fill(g, msAt(0.8));
    g.frame('moving', false);
    g.points(scene, TSL);
    expect(big.material.needsUpdate).toBe(false);
    expect(g.keepOf(big.material)).toBeCloseTo(0.4);
  });

  it('the kept points are spread evenly over the buffer order, not its first share', () => {
    expect(KEEP_HASH_STEP).toBe(PHI_CONJUGATE); // the same hash the dissolve uses
    const f = 0.4;
    const kept = (from: number, to: number): number => {
      let k = 0;
      for (let i = from; i < to; i++) if (fadeHashUnit(i) <= f) k++;
      return k;
    };
    // Every window of 100 consecutive points keeps its share (first-N kept 100 or 0).
    for (const start of [0, 400, 999_900, 5_000_000]) expect(Math.abs(kept(start, start + 100) - 40)).toBeLessThanOrEqual(2);
  });

  it('quietMs, when given, decides stillness instead of the phase', () => {
    const g = new GovernorWiring();
    fill(g, msAt(0.8));
    g.frame('moving', false, 0);
    expect(g.policy.renderScale).toBe(0.6);
    g.frame('moving', false, STILL_MS - 1);
    expect(g.policy.renderScale).toBe(0.6);
    g.frame('moving', false, STILL_MS);
    expect(g.policy.renderScale).toBe(1);
    g.frame('moving', true, STILL_MS * 10); // a tween is motion
    expect(g.policy.renderScale).toBe(0.6);
  });

  it('never below the floors; a size graph rebuilt by its owner is folded again', () => {
    const g = new GovernorWiring();
    fill(g, msAt(5));
    g.frame('moving', true);
    expect(g.policy.renderScale).toBeGreaterThanOrEqual(0.6);
    expect(g.policy.pointBudgetFraction).toBeGreaterThanOrEqual(0.4);
    const m = mesh(100);
    const plain = { geometry: { isInstancedBufferGeometry: true, instanceCount: 5 }, material: { sizeNode: null, needsUpdate: false } };
    g.points({ children: [m, plain] }, TSL);
    expect(plain.material.sizeNode).toBeNull(); // not a node material: left alone
    const first = m.material.sizeNode;
    m.material.sizeNode = null; // the owner rebuilt the size graph
    g.points({ children: [m] }, TSL);
    expect(m.material.sizeNode).not.toBeNull();
    expect(m.material.sizeNode).not.toBe(first);
    expect(g.presentation().reducedMeshes).toBe(1);
  });
});
