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
