import { describe, it, expect } from 'vitest';
import {
  directCoverage,
  edgeLeakage,
  unsupportedReconstruction,
  temporalVariance,
  type Frame,
} from './quality/frameQuality';
import type { SupportKind } from '../src/render/streaming/microGap';

/** Build a frame from a picture: `.` empty, `d` direct, `a` accumulated, `r` reconstructed. */
function frame(rows: string[], depths: number[][]): Frame {
  const heightPx = rows.length;
  const widthPx = rows[0].length;
  const support: SupportKind[] = [];
  const depth = new Float32Array(widthPx * heightPx);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const c = rows[y][x];
      support.push(c === 'd' ? 'direct' : c === 'a' ? 'accumulated' : c === 'r' ? 'reconstructed' : 'none');
      depth[y * widthPx + x] = depths[y][x];
    }
  }
  return { widthPx, heightPx, depth, support };
}

const flat = (v: number, w: number, h: number) => Array.from({ length: h }, () => Array(w).fill(v));

describe('direct coverage', () => {
  it('is everything when nothing was filled', () => {
    expect(directCoverage(frame(['dd', 'dd'], flat(10, 2, 2)))).toBe(1);
  });

  it('counts accumulated pixels as measured, not invented', () => {
    expect(directCoverage(frame(['da', 'da'], flat(10, 2, 2)))).toBe(1);
  });

  it('falls as more is filled', () => {
    expect(directCoverage(frame(['dr', 'dd'], flat(10, 2, 2)))).toBeCloseTo(0.75, 12);
  });

  // Against drawn pixels, so the figure cannot be improved by looking at sky.
  it('ignores background', () => {
    const tight = directCoverage(frame(['dr'], [[10, 10]]));
    const wide = directCoverage(frame(['dr..........'], [[10, 10, ...Array(10).fill(0)]]));
    expect(wide).toBeCloseTo(tight as number, 12);
  });

  it('has no value for an empty frame', () => {
    expect(directCoverage(frame(['..', '..'], flat(0, 2, 2)))).toBeNull();
  });
});

describe('edge leakage', () => {
  // A fill between neighbours on one surface is the case the pass is for.
  it('is nothing when a fill sits on one surface', () => {
    expect(edgeLeakage(frame(['drd'], [[10, 10, 10.05]]))).toBe(0);
  });

  // The failure the whole design guards against: a patch laid over a ridge.
  it('catches a fill laid across a depth boundary', () => {
    expect(edgeLeakage(frame(['drd'], [[10, 10, 400]]))).toBe(1);
  });

  it('reports the share, not just a flag', () => {
    const f = frame(['drd', 'drd'], [[10, 10, 10.05], [10, 10, 400]]);
    expect(edgeLeakage(f)).toBeCloseTo(0.5, 12);
  });

  it('has no value when nothing was reconstructed', () => {
    expect(edgeLeakage(frame(['ddd'], [[10, 10, 400]]))).toBeNull();
  });

  // Judged by the renderer's own depth rule, so the metric and the pass cannot
  // drift into disagreeing about what one surface means.
  it('honours a caller-supplied tolerance', () => {
    const f = frame(['drd'], [[10, 10, 12]]);
    expect(edgeLeakage(f)).toBe(1);
    expect(edgeLeakage(f, 1)).toBe(0);
  });
});

describe('unsupported reconstruction', () => {
  it('is nothing when a fill is bracketed', () => {
    expect(unsupportedReconstruction(frame(['drd'], [[10, 10, 10]]))).toBe(0);
  });

  it('catches a fill with nothing spanning it', () => {
    expect(unsupportedReconstruction(frame(['.r.'], [[0, 10, 0]]))).toBe(1);
  });

  it('catches a fill with only one drawn neighbour', () => {
    expect(unsupportedReconstruction(frame(['dr.'], [[10, 10, 0]]))).toBe(1);
  });
});

describe('temporal variance', () => {
  it('is nothing between identical frames', () => {
    const f = frame(['dd', 'dd'], flat(10, 2, 2));
    expect(temporalVariance(f, f)).toBe(0);
  });

  it('counts a pixel that appeared or vanished', () => {
    const a = frame(['d.'], [[10, 0]]);
    const b = frame(['dd'], [[10, 10]]);
    expect(temporalVariance(a, b)).toBeCloseTo(0.5, 12);
  });

  it('counts a pixel whose depth moved beyond the tolerance', () => {
    const a = frame(['dd'], [[10, 10]]);
    const b = frame(['dd'], [[10, 400]]);
    expect(temporalVariance(a, b)).toBeCloseTo(0.5, 12);
  });

  it('ignores a depth that only jittered', () => {
    const a = frame(['dd'], [[10, 10]]);
    const b = frame(['dd'], [[10, 10.05]]);
    expect(temporalVariance(a, b)).toBe(0);
  });
});

describe('the metrics have to be read together', () => {
  // Filling more raises coverage of the frame and can raise leakage at the same
  // time, so either figure alone rewards what the other exists to catch.
  it('shows a fill improving one figure while worsening the other', () => {
    const before = frame(['d.d'], [[10, 0, 400]]);
    const after = frame(['drd'], [[10, 10, 400]]);

    const drawnBefore = before.support.filter((s) => s !== 'none').length;
    const drawnAfter = after.support.filter((s) => s !== 'none').length;
    expect(drawnAfter).toBeGreaterThan(drawnBefore);

    expect(edgeLeakage(before)).toBeNull();
    expect(edgeLeakage(after)).toBe(1);
    expect(directCoverage(after)).toBeLessThan(directCoverage(before) as number);
  });
});
