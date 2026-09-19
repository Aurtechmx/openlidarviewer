/**
 * A hole wider than the kernel must stay a hole.
 *
 * The single-pixel rules are covered in `microGap.test.ts`. What they cannot
 * show on their own is the behaviour on a real grid, where a pass runs over
 * and over and each round could seed the next until a gap in the data has
 * become a surface.
 *
 * Driving it to a fixed point shows the rules are stricter than the creep
 * argument assumes. A hole two or more pixels wide fills NOTHING, not even at
 * its rim: a rim pixel has neighbours on one side only, so the opposite-pair
 * rule refuses it as unsupported before any question of creeping arises. The
 * first pass fills zero pixels and the pass is already at its fixed point.
 *
 * So the rule that a reconstructed pixel is never evidence is a second line
 * behind a first that has already held in this geometry. It is asserted here
 * directly rather than through a hole, because a hole never reaches it.
 */
import { describe, it, expect } from 'vitest';
import { shouldFill, type SupportKind, type Cardinals } from '../src/render/continuity/microGap';

const W = 11;
const H = 11;
const DEPTH = 10;

interface Frame {
  support: SupportKind[];
  depth: number[];
}

/** A frame of directly-sampled surface with a square hole punched in it. */
function frameWithHole(holeHalf: number): Frame {
  const support: SupportKind[] = [];
  const depth: number[] = [];
  const c = Math.floor(W / 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inHole = Math.abs(x - c) <= holeHalf && Math.abs(y - c) <= holeHalf;
      support.push(inHole ? 'none' : 'direct');
      depth.push(inHole ? 0 : DEPTH);
    }
  }
  return { support, depth };
}

const at = (f: Frame, x: number, y: number) =>
  x < 0 || y < 0 || x >= W || y >= H
    ? { depth: 0, support: 'none' as SupportKind }
    : { depth: f.depth[y * W + x], support: f.support[y * W + x] };

function cardinals(f: Frame, x: number, y: number): Cardinals {
  return {
    left: at(f, x - 1, y),
    right: at(f, x + 1, y),
    up: at(f, x, y - 1),
    down: at(f, x, y + 1),
  };
}

/** One pass over every pixel, reading the frame as it was at pass start. */
function onePass(f: Frame): { next: Frame; filled: number } {
  const next: Frame = { support: [...f.support], depth: [...f.depth] };
  let filled = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const decision = shouldFill(f.support[i], cardinals(f, x, y));
      if (decision.fill) {
        next.support[i] = 'reconstructed';
        next.depth[i] = decision.depth;
        filled += 1;
      }
    }
  }
  return { next, filled };
}

/** Run passes until nothing more changes. */
function toFixedPoint(f: Frame): { frame: Frame; passes: number } {
  let frame = f;
  for (let pass = 1; pass <= 40; pass++) {
    const { next, filled } = onePass(frame);
    frame = next;
    if (filled === 0) return { frame, passes: pass };
  }
  throw new Error('micro-gap closure did not reach a fixed point');
}

const holeCells = (f: Frame, holeHalf: number): SupportKind[] => {
  const c = Math.floor(W / 2);
  const out: SupportKind[] = [];
  for (let y = c - holeHalf; y <= c + holeHalf; y++) {
    for (let x = c - holeHalf; x <= c + holeHalf; x++) out.push(f.support[y * W + x]);
  }
  return out;
};

describe('micro-gap closure over a hole wider than one pixel', () => {
  it('closes a hole exactly one pixel across', () => {
    const { frame, passes } = toFixedPoint(frameWithHole(0));
    expect(frame.support[Math.floor(H / 2) * W + Math.floor(W / 2)]).toBe('reconstructed');
    expect(passes).toBeLessThanOrEqual(2);
  });

  it('fills nothing at all in a hole three or more pixels wide', () => {
    for (const holeHalf of [1, 2, 3]) {
      const { filled } = onePass(frameWithHole(holeHalf));
      expect(filled).toBe(0);
    }
  });

  it('leaves every cell of a wide hole as it found it', () => {
    for (const holeHalf of [1, 2, 3]) {
      const { frame } = toFixedPoint(frameWithHole(holeHalf));
      expect(holeCells(frame, holeHalf).every((s) => s === 'none')).toBe(true);
    }
  });

  it('refuses the rim for want of support rather than for depth', () => {
    // The mechanism that makes the two previous assertions true: a rim pixel
    // has neighbours on one side only, which is a corner and not a surface.
    const f = frameWithHole(2);
    const c = Math.floor(W / 2);
    const rim = shouldFill(f.support[c * W + (c - 2)], cardinals(f, c - 2, c));
    expect(rim.fill).toBe(false);
    if (!rim.fill) expect(rim.reason).toBe('unsupported');
  });

  it('closes a one-pixel seam, which is what the pass is for', () => {
    // A slit one pixel wide: every cell has a direct neighbour left and right.
    const f: Frame = {
      support: Array.from({ length: W * H }, () => 'direct' as SupportKind),
      depth: Array.from({ length: W * H }, () => DEPTH),
    };
    const c = Math.floor(W / 2);
    for (let y = 2; y <= H - 3; y++) {
      f.support[y * W + c] = 'none';
      f.depth[y * W + c] = 0;
    }
    const { frame } = toFixedPoint(f);
    for (let y = 2; y <= H - 3; y++) {
      expect(frame.support[y * W + c]).toBe('reconstructed');
      expect(frame.depth[y * W + c]).toBe(DEPTH);
    }
  });

  it('reaches a fixed point rather than filling forever', () => {
    for (const holeHalf of [0, 1, 2, 3]) {
      expect(() => toFixedPoint(frameWithHole(holeHalf))).not.toThrow();
    }
  });

  it('never fills a pixel whose only support is reconstructed', () => {
    // The second line of defence, asserted directly because no hole reaches
    // it: a wide hole is already refused as unsupported at its rim.
    const f: Frame = {
      support: Array.from({ length: W * H }, () => 'reconstructed' as SupportKind),
      depth: Array.from({ length: W * H }, () => DEPTH),
    };
    const i = Math.floor(H / 2) * W + Math.floor(W / 2);
    f.support[i] = 'none';
    f.depth[i] = 0;
    const { frame } = toFixedPoint(f);
    expect(frame.support[i]).toBe('none');
  });

  it('closes nothing at all when the surface itself is absent', () => {
    const empty: Frame = {
      support: Array.from({ length: W * H }, () => 'none' as SupportKind),
      depth: Array.from({ length: W * H }, () => 0),
    };
    const { frame } = toFixedPoint(empty);
    expect(frame.support.every((s) => s === 'none')).toBe(true);
  });
});
