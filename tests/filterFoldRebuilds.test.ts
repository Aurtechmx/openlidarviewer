/**
 * filterFoldRebuilds.test.ts
 *
 * Turning the class, elevation or intensity filter on the first time folds
 * its mask into every point material's size graph, which rebuilds the
 * pipelines. After that the fold stays (an exact multiplier of 1 while the
 * filter is off), so toggling again changes uniforms only. Opening a scan
 * drops a fold whose filter is off, so a scan still opens with the plain size
 * graph. The shipped Viewer methods run against a fake `this`.
 */

import { describe, it, expect } from 'vitest';
import { Viewer } from '../src/render/Viewer';
import { ClipBoxGpu, FilterFolds, StickyFold } from '../src/render/clip/clipGpu';
import { ElevationFilterGpu } from '../src/render/elevationFilterGpu';
import type { ClassVisibility } from '../src/render/class/classVisibility';

const CLASS_COUNT = 256;

function visibility(hidden: number[]): ClassVisibility {
  const mask = new Array<number>(CLASS_COUNT).fill(1);
  for (const c of hidden) mask[c] = 0;
  return { toMaskArray: () => mask } as unknown as ClassVisibility;
}

function setup() {
  let rebuilds = 0;
  const folds = new FilterFolds();
  const intenEnabled = { value: 0 };
  const v = Object.assign(Object.create(Viewer.prototype) as object, {
    _classMaskUniform: { array: new Array<number>(CLASS_COUNT).fill(1) },
    _classFiltered: false,
    _folds: folds,
    _elevGpu: new ElevationFilterGpu(),
    _clipGpu: new ClipBoxGpu(),
    _intenFilterEnabled: intenEnabled,
    _intenFilterMin: { value: 0 },
    _intenFilterMax: { value: 0 },
    _gpuErrorLedger: { reset: () => {} },
    _demand: { changed: () => {} },
    _allPointMaterials: () => [],
    _reapplyAllSizeModes: () => { rebuilds++; },
  }) as unknown as Viewer;
  const openScan = () => (v as unknown as { _resetGpuErrorHistory(): void })._resetGpuErrorHistory();
  return { v, folds, intenEnabled, openScan, rebuilds: () => rebuilds };
}

describe('filter folds stay after first use', () => {
  it('class filter: only the first hide rebuilds; toggling again is uniform-only', () => {
    const { v, folds, rebuilds } = setup();
    v.applyClassVisibility(visibility([2]));
    expect(rebuilds()).toBe(1);
    v.applyClassVisibility(visibility([]));
    v.applyClassVisibility(visibility([2]));
    v.applyClassVisibility(visibility([5, 6]));
    v.applyClassVisibility(visibility([]));
    expect(rebuilds()).toBe(1);
    expect(folds.classMask.folded).toBe(true);
    // The off state is an all-ones mask: an exact multiplier of 1.
    const mask = (v as unknown as { _classMaskUniform: { array: number[] } })._classMaskUniform.array;
    expect(mask.every((m) => m === 1)).toBe(true);
  });

  it('elevation filter: only the first on rebuilds', () => {
    const { v, folds, rebuilds } = setup();
    v.setElevationFilter([0, 10]);
    v.setElevationFilter(undefined);
    v.setElevationFilter([2, 8]);
    v.setElevationFilter(undefined);
    expect(rebuilds()).toBe(1);
    expect(folds.elevation.folded).toBe(true);
  });

  it('intensity filter: only the first on rebuilds, and off is enabled = 0', () => {
    const { v, folds, intenEnabled, rebuilds } = setup();
    v.setIntensityFilter([100, 200]);
    v.setIntensityFilter(undefined);
    expect(intenEnabled.value).toBe(0);
    v.setIntensityFilter([10, 20]);
    v.setIntensityFilter(undefined);
    expect(rebuilds()).toBe(1);
    expect(folds.intensity.folded).toBe(true);
  });

  it('opening a scan drops folds whose filter is off and keeps one that is on', () => {
    const { v, folds, openScan, rebuilds } = setup();
    openScan();
    expect(rebuilds()).toBe(0); // nothing was folded: the scan opens plain with no rebuild
    v.applyClassVisibility(visibility([2]));
    v.applyClassVisibility(visibility([]));
    v.setIntensityFilter([1, 2]);
    expect(rebuilds()).toBe(2);
    openScan();
    expect(rebuilds()).toBe(3);
    expect(folds.classMask.folded).toBe(false);
    expect(folds.intensity.folded).toBe(true); // still on
    // After the scan opened plain, the first hide folds (and rebuilds) again.
    v.applyClassVisibility(visibility([2]));
    expect(rebuilds()).toBe(4);
  });

  it('StickyFold follows the clip box rule', () => {
    const f = new StickyFold();
    expect(f.folded).toBe(false);
    expect(f.set(true)).toBe(true);
    expect(f.set(false)).toBe(false);
    expect(f.folded).toBe(true);
    expect(f.forget()).toBe(true);
    expect(f.folded).toBe(false);
    expect(f.set(true)).toBe(true);
    expect(f.forget()).toBe(false);
    expect(f.folded).toBe(true);
  });
});
