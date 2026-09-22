import { describe, it, expect } from 'vitest';
import { localDensitySizes, autoDensitySizeParams } from '../src/render/localDensitySize';

/**
 * tests/localDensitySize.test.ts
 *
 * Regression coverage for the density-adaptive point-sizing formula.
 * v0.3.10 formula-hardening pass — the module had unit-test coverage
 * gap that the Visuals Studio audit flagged. The function is on the
 * hot path for every static-cloud render with adaptive sizing
 * enabled, so silent NaN propagation or divide-by-zero would surface
 * as black-pixel zones in the rendered scan.
 */

describe('localDensitySizes — pure data formula hardening', () => {
  it('returns an empty Float32Array for an empty input', () => {
    const out = localDensitySizes({
      positions: new Float32Array(0),
      cellSize: 1,
      referenceDensity: 1,
    });
    expect(out).toHaveLength(0);
  });

  it('handles a single point gracefully (one cell, count = 1)', () => {
    const out = localDensitySizes({
      positions: new Float32Array([0, 0, 0]),
      cellSize: 1,
      referenceDensity: 1,
    });
    expect(out).toHaveLength(1);
    // ratio = refDensity / cellDensity = 1 / (1 / 1) = 1 → scale = √1 = 1
    expect(out[0]).toBeCloseTo(1, 6);
  });

  it('clamps refDensity = 0 to a safe lower bound (no NaN)', () => {
    const out = localDensitySizes({
      positions: new Float32Array([0, 0, 0, 1, 1, 0]),
      cellSize: 1,
      referenceDensity: 0,
    });
    // ratio = 1e-9 / cellD → very small, sqrt → still small, clamps to minScale (0.5)
    expect(out).toHaveLength(2);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(Number.isFinite(out[1])).toBe(true);
    expect(out[0]).toBeGreaterThanOrEqual(0.5); // default minScale
  });

  it('clamps cellSize ≤ 0 to a safe lower bound (no divide-by-zero)', () => {
    const out = localDensitySizes({
      positions: new Float32Array([0, 0, 0, 1, 1, 0]),
      cellSize: 0,
      referenceDensity: 1,
    });
    expect(out).toHaveLength(2);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(Number.isFinite(out[1])).toBe(true);
  });

  it('returns identical scales for uniform density', () => {
    // 4 points in 4 separate 1×1 cells — each cell has density 1/m²,
    // which equals the reference density. All scales should be ≈ 1.
    const positions = new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      2, 2, 0,
    ]);
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 1,
    });
    expect(out).toHaveLength(4);
    for (const v of out) expect(v).toBeCloseTo(1, 6);
  });

  it('shrinks scale in dense regions, grows scale in sparse regions', () => {
    // 5 points stacked in one cell (dense) + 1 point alone in another (sparse).
    const positions = new Float32Array([
      // Five points crammed into the (0,0) cell.
      0.1, 0.1, 0,
      0.2, 0.2, 0,
      0.3, 0.3, 0,
      0.4, 0.4, 0,
      0.5, 0.5, 0,
      // One lone point in the (10,10) cell.
      10.1, 10.1, 0,
    ]);
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 1,
    });
    // Dense cell points all share the same scale (smaller than reference).
    expect(out[0]).toBe(out[1]);
    expect(out[0]).toBe(out[4]);
    // Dense < reference (1) < sparse — verifies the curve direction.
    expect(out[0]).toBeLessThan(1);
    // Sparse point's scale is exactly ≈ 1 (matches reference density).
    expect(out[5]).toBeCloseTo(1, 6);
  });

  it('honours custom minScale / maxScale caps', () => {
    // Extreme dense region — without caps the sqrt(ratio) could go
    // very small. The minScale cap keeps every output ≥ minScale.
    const positions = new Float32Array(60);
    for (let i = 0; i < 20; i++) {
      positions[i * 3] = 0.1;
      positions[i * 3 + 1] = 0.1;
      positions[i * 3 + 2] = 0;
    }
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 1,
      minScale: 0.25,
      maxScale: 4,
    });
    expect(out).toHaveLength(20);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0.25);
      expect(v).toBeLessThanOrEqual(4);
    }
  });

  it('never produces NaN or Infinity on any input', () => {
    // Fuzz a small set of weird-but-valid inputs and assert finite output.
    const inputs: Array<Parameters<typeof localDensitySizes>[0]> = [
      { positions: new Float32Array([0, 0, 0]), cellSize: 1e-6, referenceDensity: 1e9 },
      { positions: new Float32Array([1e6, 1e6, 0]), cellSize: 1, referenceDensity: 1 },
      { positions: new Float32Array([-1e6, -1e6, 0]), cellSize: 1, referenceDensity: 1 },
    ];
    for (const input of inputs) {
      const out = localDensitySizes(input);
      for (const v of out) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('autoDensitySizeParams', () => {
  it('returns safe unit values for an empty cloud', () => {
    expect(autoDensitySizeParams(new Float32Array(0))).toEqual({
      cellSize: 1,
      referenceDensity: 1,
      axes: [0, 1],
      localPlanes: true,
    });
  });

  it('sets the reference to the mean areal density and a positive cell size', () => {
    // 100 points on a 10×10 grid at spacing 1 → footprint 9×9 = 81 m², so the
    // mean areal density is 100/81 ≈ 1.235 points/m².
    const positions = new Float32Array(100 * 3);
    let k = 0;
    for (let ix = 0; ix < 10; ix++) {
      for (let iy = 0; iy < 10; iy++) {
        positions[k++] = ix;
        positions[k++] = iy;
        positions[k++] = 0;
      }
    }
    const { cellSize, referenceDensity } = autoDensitySizeParams(positions);
    expect(referenceDensity).toBeCloseTo(100 / 81, 2);
    expect(cellSize).toBeGreaterThan(0);
  });

  it('feeds params that keep a uniform cloud near scale 1', () => {
    // A uniform grid has ~constant local density, so every per-point scale
    // should sit near 1 (neither the sparse-grow nor dense-shrink cap).
    const positions = new Float32Array(400 * 3);
    let k = 0;
    for (let ix = 0; ix < 20; ix++) {
      for (let iy = 0; iy < 20; iy++) {
        positions[k++] = ix;
        positions[k++] = iy;
        positions[k++] = 0;
      }
    }
    const scales = localDensitySizes({ positions, ...autoDensitySizeParams(positions) });
    const mean = scales.reduce((s, v) => s + v, 0) / scales.length;
    expect(mean).toBeGreaterThan(0.6);
    expect(mean).toBeLessThan(1.6);
  });
});

describe('orientation', () => {
  // The same sampled surface, laid flat and stood upright. Density sizing is a
  // display aid, so the two must read the same: a facade is not denser than a
  // field because of how it is turned.
  const surface = (upright: boolean, noise: number): Float32Array => {
    const n = 120;
    const out = new Float32Array(n * n * 3);
    let k = 0;
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const u = (i / n) * 20;
        const v = (j / n) * 12;
        const w = rnd() * noise;
        if (upright) {
          out[k++] = u;
          out[k++] = w;
          out[k++] = v;
        } else {
          out[k++] = u;
          out[k++] = v;
          out[k++] = w;
        }
      }
    }
    return out;
  };

  const scalesFor = (upright: boolean, noise: number): Float32Array => {
    const positions = surface(upright, noise);
    return localDensitySizes({ positions, ...autoDensitySizeParams(positions) });
  };

  // An isotropic cloud has no dominant plane to find, so it has to keep the
  // axes it used before rather than quietly rebinning onto a different pair.
  it('resolves a tie to x and y', () => {
    const n = 12;
    const cube = new Float32Array(n * n * n * 3);
    let k = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (let m = 0; m < n; m++) {
          cube[k++] = i;
          cube[k++] = j;
          cube[k++] = m;
        }
    expect(autoDensitySizeParams(cube).axes).toEqual([0, 1]);
  });

  it('keys on the widest two axes, so a vertical surface is not x/y', () => {
    expect(autoDensitySizeParams(surface(false, 0.01)).axes).toEqual([0, 1]);
    expect(autoDensitySizeParams(surface(true, 0.01)).axes).toEqual([0, 2]);
  });

  // Keying on x/y put every point of the upright case on a clamp: the 0.5 floor
  // at millimetre surface noise, the 2.0 cap at none. Both are the whole scan at
  // one size, which is the absence of density sizing rather than a version of it.
  it.each([0, 0.001, 0.005, 0.01, 0.05])('matches flat and upright at %s m noise', (noise) => {
    const flat = scalesFor(false, noise);
    const upright = scalesFor(true, noise);
    expect(upright.length).toBe(flat.length);
    for (let i = 0; i < flat.length; i++) expect(upright[i]).toBeCloseTo(flat[i], 6);
  });

  it('leaves the upright case off both clamps', () => {
    const upright = scalesFor(true, 0.005);
    expect(upright.every((v) => v > 0.5 && v < 2)).toBe(true);
  });
});

describe('mixed orientation', () => {
  // A 100 m x 100 m ground plane with a 40 m x 20 m facade standing on it. The
  // facade's reference is the same grid run on the facade alone, keyed across
  // its own face, with the cloud's cell size and reference density.
  const scene = (frac: number, noise: number) => {
    let seed = 7;
    const r = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const total = 200_000;
    const nf = Math.round(total * frac);
    const ng = total - nf;
    const p = new Float32Array(total * 3);
    const g = (): number => (r() + r() + r() - 1.5) * noise;
    for (let i = 0; i < ng; i++) {
      p[i * 3] = r() * 100;
      p[i * 3 + 1] = r() * 100;
      p[i * 3 + 2] = g();
    }
    for (let j = 0; j < nf; j++) {
      const i = ng + j;
      p[i * 3] = 30 + r() * 40;
      p[i * 3 + 1] = 50 + g();
      p[i * 3 + 2] = r() * 20;
    }
    return { p, ng, nf };
  };
  // `ext` overrides the clamp so a ratio reflects the raw density formula rather than two
  // independently-clamped scales landing on the same 0.5 floor. At a 50% facade share both
  // sides sit on that floor under the default clamp regardless of how they were binned.
  const ratios = (
    frac: number,
    noise: number,
    localPlanes: boolean,
    ext: { minScale?: number; maxScale?: number } = {},
  ): number[] => {
    const { p, ng, nf } = scene(frac, noise);
    const prm = autoDensitySizeParams(p);
    const s = localDensitySizes({ positions: p, ...prm, localPlanes, ...ext });
    const ref = localDensitySizes({
      positions: p.subarray(ng * 3),
      cellSize: prm.cellSize,
      referenceDensity: prm.referenceDensity,
      axes: [0, 2],
      ...ext,
    });
    const out: number[] = [];
    for (let j = 0; j < nf; j++) out.push(s[ng + j] / ref[j]);
    return out.sort((a, b) => a - b);
  };
  const q = (a: number[], f: number): number => a[Math.min(a.length - 1, Math.floor(f * a.length))];

  it('shrinks a 5% facade to 0.4 of its own-plane size under the whole-cloud plane', () => {
    expect(q(ratios(0.05, 0, false), 0.5)).toBeLessThan(0.45);
  });

  // Unclamped (minScale 0, maxScale 1e9): the default [0.5, 2] clamp used to hide that a 5%
  // facade share puts its x-end and top-edge voxels below MIN_VOXEL_POINTS, where they fall
  // back to the ground plane and read as small as 0.66 (p10) and 0.10 (min) of their alone
  // size. Both bounds already sat at that floor before this test unclamped them, so the
  // 20%/50% bounds below only had to widen enough to stop relying on it, not because binning
  // changed for those shares. The 5% p10/min bounds are new: MIN_VOXEL_POINTS rising from 6
  // to 10 (to stop scatter reading as flat, see the "misclassifies" test below) means more of
  // that share's few-point edge voxels miss the threshold and inherit the ground plane.
  it.each([
    [0.05, 0, 0.6, 0.09],
    [0.2, 0, 0.99, 0.18],
    [0.5, 0, 0.99, 0.5],
    [0.05, 0.05, 0.6, 0.09],
    [0.2, 0.05, 0.99, 0.18],
    [0.5, 0.05, 0.99, 0.35],
  ])('sizes a %s facade share at %s m noise as it would alone', (frac, noise, p10Min, ratMin) => {
    const rat = ratios(frac, noise, true, { minScale: 0, maxScale: 1e9 });
    expect(Math.abs(q(rat, 0.5) - 1)).toBeLessThan(0.01);
    expect(q(rat, 0.1)).toBeGreaterThan(p10Min);
    expect(q(rat, 0.9)).toBeLessThan(1.01);
    expect(rat[0]).toBeGreaterThan(ratMin);
  });
});

describe('orientation limit and parallel walls', () => {
  const lcg = (seed0: number) => {
    let seed = seed0;
    return (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  };
  const q = (a: number[], f: number): number => a[Math.min(a.length - 1, Math.floor(f * a.length))];

  // One 5% facade rotated `ang` from the x axis, referenced against the same facade alone,
  // rotated back to axis-aligned. `localPlanes` only classes a voxel thin within about 26.6
  // degrees of an axis (`THIN_RATIO` 0.5 in the source), so a 45-degree wall never qualifies.
  const rotatedWallRatios = (angDeg: number, noise: number): number[] => {
    const r = lcg(99);
    const g = (): number => (r() + r() + r() - 1.5) * noise;
    const total = 200_000;
    const nf = Math.round(total * 0.05);
    const ng = total - nf;
    const p = new Float32Array(total * 3);
    for (let i = 0; i < ng; i++) {
      p[i * 3] = r() * 100;
      p[i * 3 + 1] = r() * 100;
      p[i * 3 + 2] = g();
    }
    const ang = (angDeg * Math.PI) / 180;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let j = 0; j < nf; j++) {
      const i = ng + j;
      const t = r() * 40;
      const off = g();
      p[i * 3] = 30 + t * c - off * s;
      p[i * 3 + 1] = 30 + t * s + off * c;
      p[i * 3 + 2] = r() * 20;
    }
    const prm = autoDensitySizeParams(p);
    const sizes = localDensitySizes({ positions: p, ...prm });
    const q2 = new Float32Array(nf * 3);
    const c2 = Math.cos(-ang);
    const s2 = Math.sin(-ang);
    for (let j = 0; j < nf; j++) {
      const i = ng + j;
      const x = p[i * 3] - 30;
      const y = p[i * 3 + 1] - 30;
      q2[j * 3] = x * c2 - y * s2;
      q2[j * 3 + 1] = x * s2 + y * c2;
      q2[j * 3 + 2] = p[i * 3 + 2];
    }
    const ref = localDensitySizes({ positions: q2, cellSize: prm.cellSize, referenceDensity: prm.referenceDensity, axes: [0, 2] });
    const out: number[] = [];
    for (let j = 0; j < nf; j++) out.push(sizes[ng + j] / ref[j]);
    return out.sort((a, b) => a - b);
  };

  it('leaves a 45-degree facade at its whole-cloud-plane size, same as before localPlanes existed', () => {
    const rat = rotatedWallRatios(45, 0);
    expect(q(rat, 0.5)).toBeGreaterThan(0.35);
    expect(q(rat, 0.5)).toBeLessThan(0.45);
  });

  // Two and four 5% walls on the same ground, each referenced against itself alone. Before the
  // bin key carried a voxel's position along its own normal, parallel walls at different offsets
  // projected onto the same 2D cell and their counts merged, undersizing each one as though it
  // were shared with the others: median 0.71 at two walls, 0.51 at four, against a whole-cloud
  // plane's 0.40 either way. The key now separates them and both read as they would alone.
  const wallRatios = (walls: number[], noise: number): number[] => {
    const r = lcg(99);
    const g = (): number => (r() + r() + r() - 1.5) * noise;
    const total = 200_000;
    const nEach = Math.round(total * 0.05);
    const ng = total - nEach * walls.length;
    const p = new Float32Array(total * 3);
    for (let i = 0; i < ng; i++) {
      p[i * 3] = r() * 100;
      p[i * 3 + 1] = r() * 100;
      p[i * 3 + 2] = g();
    }
    const starts: number[] = [];
    let i = ng;
    for (const y of walls) {
      starts.push(i);
      for (let j = 0; j < nEach; j++, i++) {
        p[i * 3] = 30 + r() * 40;
        p[i * 3 + 1] = y + g();
        p[i * 3 + 2] = r() * 20;
      }
    }
    const prm = autoDensitySizeParams(p);
    const sizes = localDensitySizes({ positions: p, ...prm });
    const out: number[] = [];
    for (const start of starts) {
      const ref = localDensitySizes({
        positions: p.subarray(start * 3, (start + nEach) * 3),
        cellSize: prm.cellSize,
        referenceDensity: prm.referenceDensity,
        axes: [0, 2],
      });
      for (let j = 0; j < nEach; j++) out.push(sizes[start + j] / ref[j]);
    }
    return out.sort((a, b) => a - b);
  };

  it.each([
    [1, [50]],
    [2, [40, 60]],
    [4, [20, 40, 60, 80]],
  ])('sizes %s parallel wall(s) as each would alone', (_count, walls) => {
    const rat = wallRatios(walls as number[], 0);
    expect(q(rat, 0.5)).toBeGreaterThan(0.98);
    expect(q(rat, 0.9)).toBeLessThan(1.05);
    expect(rat[0]).toBeGreaterThan(0.3);
  });

  // 100,000 points 30% vegetation scatter over a flat ground, no facade at all. A voxel of
  // scattered points can still pass the min/max spread test by chance; at the previous 6-point
  // minimum that misclassified about 2% of points as sitting on a false local plane. Raising
  // MIN_VOXEL_POINTS to 10 (Monte Carlo: a uniform 3D voxel of 10 points passes about 0.5% of
  // the time, against about 5.7% at 6) keeps this well under 1%.
  it('misclassifies well under 1% of a ground-plus-scatter cloud as locally planar', () => {
    const r = lcg(12345);
    const g = (): number => r() + r() + r() - 1.5;
    const n = 100_000;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = r() * 100;
      const y = r() * 100;
      const veg = r() < 0.3;
      p[i * 3] = x;
      p[i * 3 + 1] = y;
      p[i * 3 + 2] = veg ? r() * 8 : g() * 0.05;
    }
    const prm = autoDensitySizeParams(p);
    const on = localDensitySizes({ positions: p, ...prm });
    const off = localDensitySizes({ positions: p, ...prm, localPlanes: false });
    let changed = 0;
    for (let i = 0; i < n; i++) if (on[i] !== off[i]) changed++;
    expect(changed / n).toBeLessThan(0.01);
  });
});
