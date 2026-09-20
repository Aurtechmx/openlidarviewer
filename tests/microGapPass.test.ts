import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { SupportKind } from '../src/render/continuity/microGap';
import {
  GAP_RADIUS_PX,
  runMicroGapPass,
  type SupportRaster,
} from '../src/render/continuity/microGapPass';
import { packSupport, unpackSampleCount, unpackSupportKind } from '../src/render/continuity/supportProvenance';

/** Build a raster from a picture: `.` background, `#` a direct sample. */
function raster(rows: readonly string[], depth = 10): SupportRaster {
  const h = rows.length;
  const w = rows[0].length;
  const support = new Uint8Array(w * h);
  const depths = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = rows[y][x];
      const kind: SupportKind = c === '#' ? 'direct' : c === 'a' ? 'accumulated'
        : c === 'r' ? 'reconstructed' : 'none';
      support[i] = packSupport(kind, kind === 'none' ? 0 : 4);
      depths[i] = kind === 'none' ? 0 : depth;
    }
  }
  return { widthPx: w, heightPx: h, support, depth: depths };
}

function blank(like: SupportRaster): SupportRaster {
  return {
    widthPx: like.widthPx,
    heightPx: like.heightPx,
    support: new Uint8Array(like.support.length),
    depth: new Float32Array(like.depth.length),
  };
}

/** The picture the pass produced, in the same notation. */
function picture(r: SupportRaster): string[] {
  const out: string[] = [];
  for (let y = 0; y < r.heightPx; y++) {
    let row = '';
    for (let x = 0; x < r.widthPx; x++) {
      const kind = unpackSupportKind(r.support[y * r.widthPx + x]);
      row += kind === 'direct' ? '#' : kind === 'accumulated' ? 'a' : kind === 'reconstructed' ? 'r' : '.';
    }
    out.push(row);
  }
  return out;
}

describe('a one-pixel gap', () => {
  it('is closed when samples bracket it on both axes', () => {
    const input = raster([
      '###',
      '#.#',
      '###',
    ]);
    const output = blank(input);
    const result = runMicroGapPass(input, output);
    expect(result.filled).toBe(1);
    expect(picture(output)[1]).toBe('#r#');
    expect(output.depth[4]).toBeCloseTo(10, 6);
  });

  it('is left alone across a depth discontinuity', () => {
    const input = raster(['###', '#.#', '###']);
    // The right-hand column sits far behind: an edge, not a gap.
    for (const i of [2, 5, 8]) input.depth[i] = 400;
    const output = blank(input);
    const result = runMicroGapPass(input, output);
    expect(result.filled).toBe(0);
    expect(result.refused.discontinuity).toBe(1);
    expect(picture(output)[1]).toBe('#.#');
  });

  it('accepts carried-forward samples as evidence', () => {
    const input = raster(['aaa', 'a.a', 'aaa']);
    const output = blank(input);
    expect(runMicroGapPass(input, output).filled).toBe(1);
  });

  it('refuses reconstructed neighbours as evidence', () => {
    // Across frames as well as within one: a fill is never evidence.
    const input = raster(['rrr', 'r.r', 'rrr']);
    const output = blank(input);
    const result = runMicroGapPass(input, output);
    expect(result.filled).toBe(0);
    expect(result.refused.unsupported).toBeGreaterThan(0);
  });
});

describe('the bound is thickness, not length', () => {
  it('closes a slit one pixel tall however long it runs', () => {
    // Every pixel in it is bracketed above and below by samples that agree on
    // a depth, which is a row of sampling gaps rather than a hole.
    const input = raster([
      '#######',
      '#.....#',
      '#######',
    ]);
    const output = blank(input);
    const result = runMicroGapPass(input, output);
    expect(result.filled).toBe(5);
    expect(picture(output)[1]).toBe('#rrrrr#');
  });

  it('leaves a region two pixels thick in both directions alone', () => {
    // Each of its pixels has background on two sides, so no opposite pair
    // supports it and fewer than three cardinals do.
    const input = raster([
      '####',
      '#..#',
      '#..#',
      '####',
    ]);
    const output = blank(input);
    const result = runMicroGapPass(input, output);
    expect(result.filled).toBe(0);
    expect(picture(output).slice(1, 3)).toEqual(['#..#', '#..#']);
  });

  it('leaves a three by three hole alone', () => {
    const input = raster([
      '#####',
      '#...#',
      '#...#',
      '#...#',
      '#####',
    ]);
    const output = blank(input);
    expect(runMicroGapPass(input, output).filled).toBe(0);
  });

  it('does not eat into a thick hole one pixel per pass either', () => {
    // Running the pass repeatedly must not walk a surface across it.
    let input = raster(['#####', '#...#', '#...#', '#...#', '#####']);
    for (let i = 0; i < 5; i++) {
      const output = blank(input);
      expect(runMicroGapPass(input, output).filled).toBe(0);
      input = output;
    }
  });
});

describe('a fill is never evidence within the same pass', () => {
  it('cannot chain along a row, whichever way the walk runs', () => {
    // Two adjacent background pixels bracketed by samples. A pass that wrote
    // in place would fill the left one and then read it as support for the
    // right one; reading the input raster is what stops that.
    const input = raster(['#####', '#.#.#', '#####']);
    const output = blank(input);
    const result = runMicroGapPass(input, output);
    // Both are genuine one-pixel gaps with their own support, so both fill.
    expect(result.filled).toBe(2);
    expect(picture(output)[1]).toBe('#r#r#');
  });

  it('judges every pixel against the frame that arrived', () => {
    const input = raster(['###', '#.#', '###']);
    const output = blank(input);
    runMicroGapPass(input, output);
    // The input is untouched: the pass reads it and writes only the copy.
    expect(unpackSupportKind(input.support[4])).toBe('none');
    expect(input.depth[4]).toBe(0);
  });
});

describe('the edges of the frame', () => {
  it('refuses a pixel with no neighbour on one side', () => {
    const input = raster(['.#', '##']);
    const output = blank(input);
    const result = runMicroGapPass(input, output);
    expect(result.filled).toBe(0);
    expect(result.refused.unsupported).toBeGreaterThan(0);
  });
});

describe('normals', () => {
  it('refuse a fill when the neighbouring surfaces disagree', () => {
    const input = raster(['###', '#.#', '###']);
    const flat = { x: 0, y: 0, z: 1 };
    const wall = { x: 1, y: 0, z: 0 };
    const normals = Array.from({ length: 9 }, (_, i) => (i === 1 ? wall : flat));
    const output = blank(input);
    const result = runMicroGapPass(input, output, { normals });
    expect(result.filled).toBe(0);
    expect(result.refusedByNormals).toBe(1);
  });

  it('allow it when they agree', () => {
    const input = raster(['###', '#.#', '###']);
    const normals = Array.from({ length: 9 }, () => ({ x: 0, y: 0, z: 1 }));
    const output = blank(input);
    expect(runMicroGapPass(input, output, { normals }).filled).toBe(1);
  });

  it('behave as though absent for a source that has none', () => {
    const input = raster(['###', '#.#', '###']);
    const normals = Array.from({ length: 9 }, () => null);
    const output = blank(input);
    expect(runMicroGapPass(input, output, { normals }).filled).toBe(1);
  });
});

describe('what it reports', () => {
  it('counts every pixel exactly once, filled or refused', () => {
    const input = raster(['####', '#..#', '#..#', '####']);
    const output = blank(input);
    const r = runMicroGapPass(input, output);
    const total = r.filled + r.refusedByNormals
      + r.refused.occupied + r.refused.unsupported + r.refused.discontinuity;
    expect(total).toBe(input.widthPx * input.heightPx);
  });

  it('censuses the raster it produced, not the one it read', () => {
    const input = raster(['###', '#.#', '###']);
    const output = blank(input);
    const r = runMicroGapPass(input, output);
    expect(r.census.reconstructed).toBe(1);
    expect(r.census.direct).toBe(8);
    expect(r.census.none).toBe(0);
  });

  it('keeps the sample count a filled pixel arrived with', () => {
    const input = raster(['###', '#.#', '###']);
    const output = blank(input);
    runMicroGapPass(input, output);
    expect(unpackSampleCount(output.support[4])).toBe(0);
    expect(unpackSampleCount(output.support[0])).toBe(4);
  });

  it('fills nothing when the rasters disagree about their size', () => {
    const input = raster(['###', '#.#', '###']);
    const wrong = blank(raster(['##', '##']));
    const r = runMicroGapPass(input, wrong);
    expect(r.filled).toBe(0);
  });
});

describe('what it cannot reach', () => {
  it('names no position, point buffer, pick target or measurement', () => {
    // Structural rather than trusted: reconstructed pixels stay unpickable
    // because picking goes to the source points and never to this raster.
    const source = readFileSync(
      new URL('../src/render/continuity/microGapPass.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/pick|position|measure|positions/i);
    expect(code).toMatch(/export function runMicroGapPass/);
  });

  it('looks exactly one pixel out', () => {
    expect(GAP_RADIUS_PX).toBe(1);
  });
});

describe('the evidence lens', () => {
  it('refuses every fill it covers', () => {
    const input = raster(['###', '#.#', '###']);
    const output = blank(input);
    const lens = { centreXPx: 1, centreYPx: 1, radiusPx: 2, featherPx: 1, enabled: true };
    const result = runMicroGapPass(input, output, { lens });
    expect(result.filled).toBe(0);
    expect(result.refusedByLens).toBe(1);
    expect(picture(output)[1]).toBe('#.#');
  });

  it('fills where the lens is not', () => {
    const input = raster([
      '#######',
      '#.....#',
      '#######',
    ]);
    const output = blank(input);
    // Over the left end only.
    const lens = { centreXPx: 1, centreYPx: 1, radiusPx: 1, featherPx: 0, enabled: true };
    const result = runMicroGapPass(input, output, { lens });
    expect(result.refusedByLens).toBeGreaterThan(0);
    expect(result.filled).toBeGreaterThan(0);
    expect(result.filled + result.refusedByLens).toBe(5);
  });

  it('fills as usual when no lens is open', () => {
    const input = raster(['###', '#.#', '###']);
    const output = blank(input);
    const closed = { centreXPx: 1, centreYPx: 1, radiusPx: 0, featherPx: 0, enabled: false };
    const result = runMicroGapPass(input, output, { lens: closed });
    expect(result.filled).toBe(1);
    expect(result.refusedByLens).toBe(0);
  });

  it('still counts every pixel exactly once', () => {
    const input = raster(['###', '#.#', '###']);
    const output = blank(input);
    const lens = { centreXPx: 1, centreYPx: 1, radiusPx: 2, featherPx: 1, enabled: true };
    const r = runMicroGapPass(input, output, { lens });
    const total = r.filled + r.refusedByNormals + r.refusedByLens
      + r.refused.occupied + r.refused.unsupported + r.refused.discontinuity;
    expect(total).toBe(input.widthPx * input.heightPx);
  });
});

describe('normals at the frame edge', () => {
  it('does not read across a row boundary for a left or right neighbour', () => {
    // A pixel at x = 0 bracketed vertically is fillable. Its left neighbour is
    // off-frame, and reading the flat array at i-1 would take the previous
    // row's last pixel instead, so an unrelated surface would decide the fill.
    const input = raster([
      '##',
      '.#',
      '##',
    ]);
    const flat = { x: 0, y: 0, z: 1 };
    const wall = { x: 1, y: 0, z: 0 };
    // Everything agrees except the pixel the wrapped index would have read:
    // the last pixel of the row above the candidate.
    const normals = [flat, wall, flat, flat, flat, flat];
    const output = blank(input);
    const result = runMicroGapPass(input, output, { normals });
    expect(result.refusedByNormals).toBe(0);
    expect(result.filled).toBe(1);
  });

  it('still refuses when a real neighbour disagrees at the edge', () => {
    const input = raster(['##', '.#', '##']);
    const flat = { x: 0, y: 0, z: 1 };
    const wall = { x: 1, y: 0, z: 0 };
    // Index 0 is the pixel directly above the candidate at (0,1).
    const normals = [wall, flat, flat, flat, flat, flat];
    const output = blank(input);
    const result = runMicroGapPass(input, output, { normals });
    expect(result.refusedByNormals).toBe(1);
    expect(result.filled).toBe(0);
  });
});
