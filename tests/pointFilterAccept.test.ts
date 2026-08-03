import { describe, it, expect } from 'vitest';
import { buildPointFilterAccept, elevWindowFieldsFor } from '../src/render/pointFilterAccept';
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

describe('elevWindowFieldsFor — CPU world→attribute conversion (per-cloud)', () => {
  // This pins the seam the Viewer's CPU pick / lasso path now goes through
  // (`_currentFilterWindow(layer)`), mirroring elevationWindowResolver.test.ts's
  // two-different-origins case but for the CPU accept path. The block above
  // proves the PREDICATE honours two already-different windows; this proves the
  // Viewer derives those two windows from ONE world range per cloud, closing the
  // gap where a single primary-origin window was reused for every cloud.

  it('subtracts the cloud origin along the up-axis (attr = world - origin), matching the resolver', () => {
    // Same fixture as the resolver test: Cloud A, Z origin 195, world [198, 202].
    expect(elevWindowFieldsFor([198, 202], 195, 2)).toEqual({ elevAxisIdx: 2, elevMin: 3, elevMax: 7 });
  });

  it('maps the up-axis to the position component: Z-up -> 2, Y-up -> 1', () => {
    expect(elevWindowFieldsFor([10, 20], 0, 2).elevAxisIdx).toBe(2);
    expect(elevWindowFieldsFor([10, 20], 0, 1).elevAxisIdx).toBe(1);
  });

  it('still returns finite bounds when the filter is off (undefined range)', () => {
    // The accept predicate gates on `elevActive`, so an off window is never
    // consulted — but it must be a real window, never NaN, matching the resolver.
    const w = elevWindowFieldsFor(undefined, 195, 2);
    expect(Number.isFinite(w.elevMin)).toBe(true);
    expect(Number.isFinite(w.elevMax)).toBe(true);
  });

  it('gives two clouds at different origins two windows that accept the SAME true-height point', () => {
    // The core CPU-path guarantee. gate2-origin-a: Z origin 195; gate2-origin-b:
    // Z origin 150. ONE world window [198, 202] must convert per cloud, so a real
    // point at true world Z=200 (stored origin-shifted: 5 in A, 50 in B) is
    // accepted by BOTH — the whole point of routing each cloud through its own
    // origin instead of the primary's.
    const world: [number, number] = [198, 202];
    const a = elevWindowFieldsFor(world, 195, 2);
    const b = elevWindowFieldsFor(world, 150, 2);
    expect(a).toEqual({ elevAxisIdx: 2, elevMin: 3, elevMax: 7 });
    expect(b).toEqual({ elevAxisIdx: 2, elevMin: 48, elevMax: 52 });
    expect(a.elevMin).not.toBe(b.elevMin);

    const posA = new Float32Array([0, 0, 200 - 195]); // 5
    const posB = new Float32Array([0, 0, 200 - 150]); // 50
    const base = { classActive: false, classMask: null, intenActive: false, intenMin: 0, intenMax: 0 } as const;
    expect(buildPointFilterAccept(posA, null, null, { ...base, elevActive: true, ...a })!(0)).toBe(true);
    expect(buildPointFilterAccept(posB, null, null, { ...base, elevActive: true, ...b })!(0)).toBe(true);

    // The Stage-A CPU bug this fix closes: cloud B's point tested against cloud
    // A's window (one shared/primary origin) is wrongly rejected — 50 ∉ [3, 7].
    expect(buildPointFilterAccept(posB, null, null, { ...base, elevActive: true, ...a })!(0)).toBe(false);
  });

  it('reads the correct component for a Z-up cloud beside a Y-up cloud from one world window', () => {
    expect(elevWindowFieldsFor([12, 17], 10, 2).elevAxisIdx).toBe(2); // survey, Z-up
    expect(elevWindowFieldsFor([12, 17], 10, 1).elevAxisIdx).toBe(1); // phone, Y-up
  });
});
