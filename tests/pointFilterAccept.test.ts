import { describe, it, expect } from 'vitest';
import { buildPointFilterAccept } from '../src/render/pointFilterAccept';
import type { PointFilterWindow } from '../src/render/pointFilterAccept';

/** A 256-entry all-visible class mask, optionally hiding some codes. */
function mask(hide: number[] = []): Float32Array {
  const m = new Float32Array(256).fill(1);
  for (const c of hide) m[c] = 0;
  return m;
}

function win(over: Partial<PointFilterWindow> = {}): PointFilterWindow {
  return {
    classActive: false,
    classMask: mask(),
    elevActive: false,
    elevAxisIdx: 2,
    elevMin: 0,
    elevMax: 0,
    intenActive: false,
    intenMin: 0,
    intenMax: 0,
    ...over,
  };
}

// Two points: index 0 at z=1 intensity=100 class=2; index 1 at z=9 intensity=900 class=6.
const positions = new Float32Array([0, 0, 1, 0, 0, 9]);
const classification = new Uint8Array([2, 6]);
const intensity = new Uint16Array([100, 900]);

describe('buildPointFilterAccept', () => {
  it('returns undefined when no channel is active (the hot path)', () => {
    expect(buildPointFilterAccept(positions, classification, intensity, win())).toBeUndefined();
  });

  it('rejects a hidden class, keeps a visible one', () => {
    const accept = buildPointFilterAccept(positions, classification, intensity,
      win({ classActive: true, classMask: mask([6]) }));
    expect(accept).toBeDefined();
    expect(accept!(0)).toBe(true);  // class 2 visible
    expect(accept!(1)).toBe(false); // class 6 hidden
  });

  it('rejects points outside the elevation window (Z-up), inclusive', () => {
    const accept = buildPointFilterAccept(positions, classification, intensity,
      win({ elevActive: true, elevAxisIdx: 2, elevMin: 0, elevMax: 5 }));
    expect(accept!(0)).toBe(true);  // z=1 inside
    expect(accept!(1)).toBe(false); // z=9 outside
    // Inclusive on the boundary.
    const edge = buildPointFilterAccept(positions, classification, intensity,
      win({ elevActive: true, elevAxisIdx: 2, elevMin: 1, elevMax: 9 }));
    expect(edge!(0)).toBe(true);
    expect(edge!(1)).toBe(true);
  });

  it('uses the Y component when the up axis is Y', () => {
    const yPos = new Float32Array([0, 1, 0, 0, 9, 0]);
    const accept = buildPointFilterAccept(yPos, null, null,
      win({ elevActive: true, elevAxisIdx: 1, elevMin: 0, elevMax: 5 }));
    expect(accept!(0)).toBe(true);  // y=1 inside
    expect(accept!(1)).toBe(false); // y=9 outside
  });

  it('rejects points outside the intensity window', () => {
    const accept = buildPointFilterAccept(positions, classification, intensity,
      win({ intenActive: true, intenMin: 0, intenMax: 500 }));
    expect(accept!(0)).toBe(true);  // 100 inside
    expect(accept!(1)).toBe(false); // 900 outside
  });

  it('skips a channel whose data is absent', () => {
    // Intensity active but no intensity buffer ⇒ intensity test skipped; with no
    // other active channel the result is the hot-path undefined.
    expect(buildPointFilterAccept(positions, classification, null,
      win({ intenActive: true, intenMin: 0, intenMax: 500 }))).toBeUndefined();
    // Class active but no classification ⇒ class test skipped likewise.
    expect(buildPointFilterAccept(positions, null, intensity,
      win({ classActive: true }))).toBeUndefined();
  });

  it('combines channels — a point must pass all active windows', () => {
    const accept = buildPointFilterAccept(positions, classification, intensity,
      win({
        classActive: true, classMask: mask([6]),
        elevActive: true, elevAxisIdx: 2, elevMin: 0, elevMax: 5,
        intenActive: true, intenMin: 0, intenMax: 500,
      }));
    expect(accept!(0)).toBe(true);  // class 2 ✓ z=1 ✓ i=100 ✓
    expect(accept!(1)).toBe(false); // fails all three
  });
});

describe('buildPointFilterAccept — per-cloud windows (Gate 2 Stage B contract)', () => {
  // Gate 2's bug: two clouds recentred by different origins were filtered
  // against ONE attribute-space window built from ONE cloud's origin, so the
  // second cloud's points got clipped at the wrong world height. Pick and
  // render share this same predicate shape, so if the Viewer ever regresses
  // to passing one shared PointFilterWindow to every cloud's pick call, these
  // two per-cloud windows disagreeing on the same point is what a real bug
  // report would look like — pin that they're allowed to disagree.

  it('a point at the same true world elevation is correctly accepted by its own cloud window, but wrongly rejected by the OTHER cloud window — the exact shared-window bug', () => {
    // World filter [100, 150]. Cloud A recentred with origin shift 40 -> window
    // [60, 110]; cloud B recentred with origin shift 90 -> window [10, 60] (same
    // pair as the elevationFilterUniform per-cloud test). A real point at world
    // elevation 105 lives inside the filter range and should be visible on
    // EITHER cloud, but each cloud stores it at a different attribute value.
    const worldElevation = 105;
    const attrInCloudA = worldElevation - 40; // 65
    const attrInCloudB = worldElevation - 90; // 15
    const posA = new Float32Array([0, 0, attrInCloudA]);
    const posB = new Float32Array([0, 0, attrInCloudB]);

    const windowA = win({ elevActive: true, elevAxisIdx: 2, elevMin: 60, elevMax: 110 }); // world[100,150] shift 40
    const windowB = win({ elevActive: true, elevAxisIdx: 2, elevMin: 10, elevMax: 60 });  // world[100,150] shift 90

    // Correct: each cloud's point tested against ITS OWN converted window.
    expect(buildPointFilterAccept(posA, null, null, windowA)!(0)).toBe(true);
    expect(buildPointFilterAccept(posB, null, null, windowB)!(0)).toBe(true);

    // The Gate 2 defect: one shared window (here, cloud A's) fed to cloud B's
    // point. The point is genuinely inside the world filter range, but the
    // wrong attribute-space window rejects it — exactly the false negative a
    // regression to a single shared `_elevFilterMin/Max` would reintroduce.
    expect(buildPointFilterAccept(posB, null, null, windowA)!(0)).toBe(false);
  });

  it('a Z-up cloud and a Y-up cloud read different position components for the same world window', () => {
    // Same attribute-space bounds applied via elevAxisIdx 2 (Z-up) vs 1 (Y-up):
    // a point with matching z and mismatching y (or vice versa) must be judged
    // independently per cloud, never off a single shared axis index.
    const zUpPos = new Float32Array([0, 999, 5]); // z=5 inside, y=999 (irrelevant, would be outside)
    const yUpPos = new Float32Array([0, 5, 999]); // y=5 inside, z=999 (irrelevant, would be outside)

    const zUpAccept = buildPointFilterAccept(zUpPos, null, null,
      win({ elevActive: true, elevAxisIdx: 2, elevMin: 0, elevMax: 10 }));
    const yUpAccept = buildPointFilterAccept(yUpPos, null, null,
      win({ elevActive: true, elevAxisIdx: 1, elevMin: 0, elevMax: 10 }));

    expect(zUpAccept!(0)).toBe(true);
    expect(yUpAccept!(0)).toBe(true);

    // Prove the axis index is actually being read, not defaulted: swapping which
    // axis each window checks against the OTHER cloud's layout flips the result.
    const zUpAcceptWrongAxis = buildPointFilterAccept(zUpPos, null, null,
      win({ elevActive: true, elevAxisIdx: 1, elevMin: 0, elevMax: 10 }));
    expect(zUpAcceptWrongAxis!(0)).toBe(false); // reads y=999, outside the window
  });
});
