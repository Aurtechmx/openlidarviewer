import { describe, it, expect } from 'vitest';
import {
  selectProfileSectionLod,
  selectProfileSectionLodChunks,
  profileSectionLodGrid,
  profileSectionLodCell,
  type ProfileSectionLodInput,
  type ProfileSectionLodOptions,
} from '../src/render/measure/profileSectionLod';

/**
 * What the section view has to survive: a display cap far below the accepted
 * return count.
 *
 * Every property here is checked against two samplers that a renderer reaches
 * for first — read the first `cap` returns, or read every `n/cap`th one — and
 * the assertion helpers are shared, so a test that both a naive sampler and
 * this module pass is a test that proves nothing. The naive results are
 * asserted to FAIL the same helpers.
 */

const GROUND = 2;
const CANOPY = 5;
const NOISE = 7;

interface Section extends ProfileSectionLodInput {
  readonly count: number;
  readonly chainage: Float32Array;
  readonly height: Float64Array;
  readonly lateralOffset: Float32Array;
  readonly sourceSlot: Uint16Array;
  readonly pointIndex: Uint32Array;
  readonly channelPresence: Uint8Array;
  readonly classification: Uint8Array;
}

/** Deterministic integer stream. Nothing in this file may call Math.random. */
function lcg(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

function makeSection(rows: {
  chainage: number[];
  height: number[];
  slot: number[];
  cls: number[];
}): Section {
  const n = rows.chainage.length;
  const pointIndex = new Uint32Array(n);
  for (let i = 0; i < n; i++) pointIndex[i] = i;
  return {
    count: n,
    chainage: Float32Array.from(rows.chainage),
    height: Float64Array.from(rows.height),
    lateralOffset: new Float32Array(n),
    sourceSlot: Uint16Array.from(rows.slot),
    pointIndex,
    // classification bit of PROFILE_ATTRIBUTE_BIT, set on every return here.
    channelPresence: new Uint8Array(n).fill(4),
    classification: Uint8Array.from(rows.cls),
  };
}

/**
 * A canopy over a ground line, in the order a reader produces it: the canopy
 * source first, the ground source after.
 *
 * The canopy fills 2 m to 22 m of height over 200 m of chainage. The ground
 * band is 0.10 m thick and holds 5 % of the returns, which is the shape that
 * breaks a proportional sample: the band is dense per unit area and a minority
 * per return.
 */
function canopyOverGround(total = 400_000, groundShare = 0.05): Section {
  const nGround = Math.round(total * groundShare);
  const nCanopy = total - nGround;
  const chainage: number[] = [];
  const height: number[] = [];
  const slot: number[] = [];
  const cls: number[] = [];
  const rand = lcg(20250823);
  for (let i = 0; i < nCanopy; i++) {
    chainage.push(rand() * 200);
    height.push(2 + rand() * 20);
    slot.push(0);
    cls.push(CANOPY);
  }
  for (let i = 0; i < nGround; i++) {
    chainage.push(rand() * 200);
    height.push(rand() * 0.1);
    slot.push(0);
    cls.push(GROUND);
  }
  return makeSection({ chainage, height, slot, cls });
}

/** Read the first `cap` returns. */
function firstN(n: number, cap: number): Uint32Array {
  const k = Math.min(n, Math.max(0, cap));
  const out = new Uint32Array(k);
  for (let i = 0; i < k; i++) out[i] = i;
  return out;
}

/** Read every `n / cap`th return. */
function uniformStride(n: number, cap: number): Uint32Array {
  if (cap <= 0) return new Uint32Array(0);
  if (n <= cap) return firstN(n, n);
  const out = new Uint32Array(cap);
  const step = n / cap;
  for (let k = 0; k < cap; k++) out[k] = Math.min(n - 1, Math.floor(k * step));
  return out;
}

function countClass(sel: ArrayLike<number>, cls: Uint8Array, want: number): number {
  let c = 0;
  for (let k = 0; k < sel.length; k++) if (cls[sel[k]!] === want) c++;
  return c;
}

function countSlot(sel: ArrayLike<number>, slot: Uint16Array, want: number): number {
  let c = 0;
  for (let k = 0; k < sel.length; k++) if (slot[sel[k]!] === want) c++;
  return c;
}

function histogram(keys: ArrayLike<number>): Map<number, number> {
  const h = new Map<number, number>();
  for (let k = 0; k < keys.length; k++) h.set(keys[k]!, (h.get(keys[k]!) ?? 0) + 1);
  return h;
}

/** Shared property helpers. Each throws with the number it measured. */

function assertGroundLine(sel: ArrayLike<number>, s: Section, atLeast: number): void {
  const kept = countClass(sel, s.classification, GROUND);
  if (kept < atLeast) throw new Error(`ground returns kept ${kept}, need at least ${atLeast}`);
}

function assertClassFloor(sel: ArrayLike<number>, s: Section, cls: number, atLeast: number): void {
  const kept = countClass(sel, s.classification, cls);
  if (kept < atLeast) throw new Error(`class ${cls} kept ${kept}, need at least ${atLeast}`);
}

function assertSlotFloor(sel: ArrayLike<number>, s: Section, want: number, atLeast: number): void {
  const kept = countSlot(sel, s.sourceSlot, want);
  if (kept < atLeast) throw new Error(`slot ${want} kept ${kept}, need at least ${atLeast}`);
}

function assertChainageCoverage(sel: ArrayLike<number>, s: Section, bins: number): void {
  const filled = new Uint8Array(bins);
  for (let k = 0; k < sel.length; k++) {
    const t = s.chainage[sel[k]!]! / 200;
    filled[Math.min(bins - 1, Math.max(0, Math.floor(t * bins)))] = 1;
  }
  const empty: number[] = [];
  for (let b = 0; b < bins; b++) if (filled[b] === 0) empty.push(b);
  if (empty.length > 0) throw new Error(`chainage bins with nothing drawn: ${empty.join(',')}`);
}

/** Every bin of `[lo, hi)` has at least one drawn return in it. */
function assertAxisCoverage(
  axis: string,
  values: readonly number[],
  lo: number,
  hi: number,
  bins: number,
): void {
  const filled = new Uint8Array(bins);
  for (const v of values) {
    const t = (v - lo) / (hi - lo);
    filled[Math.min(bins - 1, Math.max(0, Math.floor(t * bins)))] = 1;
  }
  const empty: number[] = [];
  for (let b = 0; b < bins; b++) if (filled[b] === 0) empty.push(b);
  if (empty.length > 0) throw new Error(`${axis} bins with nothing drawn: ${empty.join(',')}`);
}

function assertContains(sel: ArrayLike<number>, wanted: readonly number[]): void {
  const have = new Set(Array.from(sel as ArrayLike<number>, (v) => v));
  const missing = wanted.filter((i) => !have.has(i));
  if (missing.length > 0) throw new Error(`missing forced keeps: ${missing.join(',')}`);
}

function snapshot(s: Section): string {
  return JSON.stringify([
    s.count,
    Array.from(s.chainage.slice(0, 64)),
    Array.from(s.height.slice(0, 64)),
    Array.from(s.sourceSlot.slice(0, 64)),
    Array.from(s.classification.slice(0, 64)),
    s.chainage.length,
    s.height.length,
  ]);
}

describe('profileSectionLod: cap and identity', () => {
  it('returns every index in order when the section fits the cap', () => {
    const s = canopyOverGround(500);
    const sel = selectProfileSectionLod(s, { cap: 500 });
    expect(sel.length).toBe(500);
    expect(Array.from(sel.slice(0, 5))).toEqual([0, 1, 2, 3, 4]);
    for (let i = 0; i < 500; i++) expect(sel[i]).toBe(i);

    const under = selectProfileSectionLod(s, { cap: 501 });
    expect(Array.from(under)).toEqual(Array.from(sel));
  });

  it('spends the whole budget and never overshoots it', () => {
    const s = canopyOverGround(20_000);
    for (const cap of [1, 2, 7, 100, 999, 5000, 19_999]) {
      const sel = selectProfileSectionLod(s, { cap });
      expect(sel.length).toBe(cap);
      expect(new Set(Array.from(sel)).size).toBe(cap);
      for (let k = 1; k < sel.length; k++) expect(sel[k]!).toBeGreaterThan(sel[k - 1]!);
    }
  });

  it('handles an empty section, a zero cap and a negative or non-finite cap', () => {
    const empty = makeSection({ chainage: [], height: [], slot: [], cls: [] });
    expect(selectProfileSectionLod(empty, { cap: 100 }).length).toBe(0);

    const s = canopyOverGround(5000);
    expect(selectProfileSectionLod(s, { cap: 0 }).length).toBe(0);
    expect(selectProfileSectionLod(s, { cap: -10 }).length).toBe(0);
    expect(selectProfileSectionLod(s, { cap: Number.NaN }).length).toBe(0);
    expect(selectProfileSectionLod(s, { cap: 1 }).length).toBe(1);
    // A cap of one still draws a return, not the first one by position.
    expect(selectProfileSectionLod(s, { cap: 2 }).length).toBe(2);
  });

  it('leaves the section untouched', () => {
    const s = canopyOverGround(20_000);
    const before = snapshot(s);
    const chainageRef = s.chainage;
    selectProfileSectionLod(s, { cap: 1000, keep: [3, 4, 19_999] });
    expect(snapshot(s)).toBe(before);
    expect(s.chainage).toBe(chainageRef);
  });
});

describe('profileSectionLod: determinism', () => {
  it('gives byte-identical output for identical input', () => {
    const s = canopyOverGround(50_000);
    const a = selectProfileSectionLod(s, { cap: 3000, keep: [7, 49_000] });
    const b = selectProfileSectionLod(s, { cap: 3000, keep: [7, 49_000] });
    expect(new Uint8Array(a.buffer)).toEqual(new Uint8Array(b.buffer));

    // A fresh, equal section must land on the same indices too.
    const s2 = canopyOverGround(50_000);
    const c = selectProfileSectionLod(s2, { cap: 3000, keep: [7, 49_000] });
    expect(new Uint8Array(c.buffer)).toEqual(new Uint8Array(a.buffer));
  });

  it('carries no Math.random in the module source', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/render/measure/profileSectionLod.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/Math\s*\.\s*random/);
  });
});

describe('profileSectionLod: the ground line under a dense canopy', () => {
  const s = canopyOverGround(400_000, 0.05);
  const cap = 5000;
  const groundTotal = countClass(
    Array.from({ length: s.count }, (_v, i) => i),
    s.classification,
    GROUND,
  );
  // A sample drawn in proportion to return count would draw this many ground
  // returns. Measured on this section: 250 of 5000.
  const proportional = Math.round((cap * groundTotal) / s.count);

  it('keeps the ground line where first-N and uniform stride do not', () => {
    const ours = selectProfileSectionLod(s, { cap });
    const naiveFirst = firstN(s.count, cap);
    const naiveStride = uniformStride(s.count, cap);

    const counts = {
      groundTotal,
      proportional,
      firstN: countClass(naiveFirst, s.classification, GROUND),
      stride: countClass(naiveStride, s.classification, GROUND),
      stratified: countClass(ours, s.classification, GROUND),
    };
    // Printed so the margin is a number in the log, not an inference.
    console.log('ground-stratum survival at cap 5000:', JSON.stringify(counts));

    // The bar is three times the proportional share: enough that the band
    // reads as a continuous line rather than a dusting, and far enough above
    // the proportional number that a sampler which only got there by luck of
    // ordering cannot clear it.
    const bar = proportional * 3;
    expect(() => assertGroundLine(naiveFirst, s, bar)).toThrow(/ground returns kept 0,/);
    expect(() => assertGroundLine(naiveStride, s, bar)).toThrow(/ground returns kept/);
    expect(() => assertGroundLine(ours, s, bar)).not.toThrow();
  });

  it('draws the ground line across the whole chainage, not one end of it', () => {
    const ours = selectProfileSectionLod(s, { cap });
    const groundOnly = Array.from(ours).filter((i) => s.classification[i] === GROUND);
    // 20 bins over 200 m: a 10 m gap in a drawn ground line is visible.
    expect(() => assertChainageCoverage(groundOnly, s, 20)).not.toThrow();
    // first-N draws no ground at all, so every bin of its ground line is empty.
    const firstGround = Array.from(firstN(s.count, cap)).filter(
      (i) => s.classification[i] === GROUND,
    );
    expect(() => assertChainageCoverage(firstGround, s, 20)).toThrow();
  });

  /** The same section plus one extra return of class 7 at `height`. */
  function withExtra(height: number): Section {
    const rows = {
      chainage: Array.from(s.chainage),
      height: Array.from(s.height),
      slot: Array.from(s.sourceSlot),
      cls: Array.from(s.classification),
    };
    rows.chainage.push(100);
    rows.height.push(height);
    rows.slot.push(0);
    rows.cls.push(NOISE);
    return makeSection(rows);
  }

  it('survives a stray return 10 km above the section', () => {
    // Control and subject differ in one number: where the extra return sits.
    // Both carry the same return count and the same three strata, so any
    // difference between them is the outlier's effect on the grid alone.
    const control = withExtra(21);
    const outlier = withExtra(10_000);

    const gc = profileSectionLodGrid(control, cap);
    const go = profileSectionLodGrid(outlier, cap);
    console.log(
      'grid with and without a 10 km outlier:',
      JSON.stringify({
        control: { nx: gc.nx, ny: gc.ny, row: (gc.maxHeight - gc.minHeight) / gc.ny },
        outlier: { nx: go.nx, ny: go.ny, row: (go.maxHeight - go.minHeight) / go.ny },
      }),
    );
    // Cells stay square, so a height range stretched by the outlier would
    // collapse the chainage axis as well. Measured untrimmed: 10 columns of
    // 20 m. Trimmed it stays at 185 columns of 1.08 m.
    expect(go.nx).toBeGreaterThan(100);
    expect((go.maxHeight - go.minHeight) / go.ny).toBeLessThan(2);

    const groundControl = countClass(
      selectProfileSectionLod(control, { cap }),
      control.classification,
      GROUND,
    );
    const ours = selectProfileSectionLod(outlier, { cap });
    const groundOutlier = countClass(ours, outlier.classification, GROUND);
    console.log(
      'ground kept with and without the outlier:',
      JSON.stringify({ control: groundControl, outlier: groundOutlier }),
    );
    // Within a tenth of the control. The residual gap is the coarser grid the
    // widened height range leaves behind, not a lost stratum.
    expect(groundOutlier).toBeGreaterThanOrEqual(Math.floor(groundControl * 0.9));
    const groundOnly = Array.from(ours).filter((i) => outlier.classification[i] === GROUND);
    expect(() => assertChainageCoverage(groundOnly, outlier, 20)).not.toThrow();
  });
});

describe('profileSectionLod: rare strata', () => {
  /** 200k canopy returns, 40 noise returns and a 100-return second scan, all appended last. */
  function withRareStrata(): Section {
    const base = canopyOverGround(200_000, 0.05);
    const rows = {
      chainage: Array.from(base.chainage),
      height: Array.from(base.height),
      slot: Array.from(base.sourceSlot),
      cls: Array.from(base.classification),
    };
    const rand = lcg(77);
    for (let i = 0; i < 40; i++) {
      rows.chainage.push(rand() * 200);
      rows.height.push(25 + rand() * 5);
      rows.slot.push(0);
      rows.cls.push(NOISE);
    }
    for (let i = 0; i < 100; i++) {
      rows.chainage.push(rand() * 200);
      rows.height.push(2 + rand() * 20);
      rows.slot.push(1);
      rows.cls.push(CANOPY);
    }
    return makeSection(rows);
  }

  const s = withRareStrata();
  const cap = 4000;

  it('keeps a 40-return class that first-N and stride erase', () => {
    const ours = selectProfileSectionLod(s, { cap });
    const naiveFirst = firstN(s.count, cap);
    const naiveStride = uniformStride(s.count, cap);
    console.log(
      'rare class 7 (40 present) at cap 4000:',
      JSON.stringify({
        firstN: countClass(naiveFirst, s.classification, NOISE),
        stride: countClass(naiveStride, s.classification, NOISE),
        stratified: countClass(ours, s.classification, NOISE),
      }),
    );
    // The class holds 40 returns and the budget is 4000, so nothing about the
    // cap forces a loss: all 40 are expected.
    expect(() => assertClassFloor(naiveFirst, s, NOISE, 40)).toThrow();
    expect(() => assertClassFloor(naiveStride, s, NOISE, 40)).toThrow();
    expect(() => assertClassFloor(ours, s, NOISE, 40)).not.toThrow();
  });

  it('keeps a 100-return second scan that first-N and stride erase', () => {
    const ours = selectProfileSectionLod(s, { cap });
    const naiveFirst = firstN(s.count, cap);
    const naiveStride = uniformStride(s.count, cap);
    console.log(
      'rare slot 1 (100 present) at cap 4000:',
      JSON.stringify({
        firstN: countSlot(naiveFirst, s.sourceSlot, 1),
        stride: countSlot(naiveStride, s.sourceSlot, 1),
        stratified: countSlot(ours, s.sourceSlot, 1),
      }),
    );
    expect(() => assertSlotFloor(naiveFirst, s, 1, 100)).toThrow();
    expect(() => assertSlotFloor(naiveStride, s, 1, 100)).toThrow();
    expect(() => assertSlotFloor(ours, s, 1, 100)).not.toThrow();
  });

  /**
   * `count` classes of the given sizes, laid out so that each class's
   * coordinates come from its own stream. The two sections a test builds from
   * this hold the identical returns whichever order the classes are written
   * in, so a difference between their results is a read-order bias and
   * nothing else.
   */
  function manyClasses(sizes: readonly number[], descending: boolean): Section {
    const rows = { chainage: [] as number[], height: [] as number[], slot: [] as number[], cls: [] as number[] };
    const order = sizes.map((_v, k) => k + 1);
    for (const c of descending ? order.slice().reverse() : order) {
      const rand = lcg(1000 + c);
      for (let i = 0; i < sizes[c - 1]!; i++) {
        rows.chainage.push(rand() * 200);
        rows.height.push(2 + rand() * 20);
        rows.slot.push(0);
        rows.cls.push(c);
      }
    }
    return makeSection(rows);
  }

  it('rations the floors by stratum, not by which source was read first', () => {
    // 40 classes and a cap of 20: fewer floor slots than strata, so the
    // ration order decides who is drawn at all.
    const sizes = new Array(40).fill(500) as number[];
    const asc = selectProfileSectionLod(manyClasses(sizes, false), { cap: 20 });
    const desc = selectProfileSectionLod(manyClasses(sizes, true), { cap: 20 });
    const ha = histogram(Array.from(asc, (i) => manyClasses(sizes, false).classification[i]!));
    const hb = histogram(Array.from(desc, (i) => manyClasses(sizes, true).classification[i]!));
    const asPairs = (h: Map<number, number>): [number, number][] =>
      Array.from(h.entries()).sort((a, b) => a[0] - b[0]);
    expect(asPairs(hb)).toEqual(asPairs(ha));
    // Every slot goes to a different stratum while strata are still unserved.
    expect(ha.size).toBe(20);
  });

  it('spends a rationed floor on the rarest strata', () => {
    // 30 classes and a cap of 15. Size runs opposite to class number - class 1
    // holds 300 returns and class 30 holds 10 - so the 15 rarest are classes
    // 16 to 30. A ration that followed class number, or read order, would draw
    // a different fifteen.
    const sizes = Array.from({ length: 30 }, (_v, k) => (30 - k) * 10);
    for (const descending of [false, true]) {
      const s = manyClasses(sizes, descending);
      const sel = selectProfileSectionLod(s, { cap: 15 });
      const kept = Array.from(new Set(Array.from(sel, (i) => s.classification[i]!))).sort(
        (a, b) => a - b,
      );
      expect(kept).toEqual(Array.from({ length: 15 }, (_v, k) => k + 16));
    }
  });

  it('gives every stratum a share when the cap is tight', () => {
    const tight = selectProfileSectionLod(s, { cap: 200 });
    expect(tight.length).toBe(200);
    for (const cls of [GROUND, CANOPY, NOISE]) {
      expect(countClass(tight, s.classification, cls)).toBeGreaterThan(0);
    }
    expect(countSlot(tight, s.sourceSlot, 1)).toBeGreaterThan(0);
  });
});

describe('profileSectionLod: input order', () => {
  /** Fisher-Yates over the section rows, driven by the deterministic stream. */
  function permute(s: Section, seed: number): { section: Section; from: Uint32Array } {
    const n = s.count;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const rand = lcg(seed);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = order[i]!;
      order[i] = order[j]!;
      order[j] = t;
    }
    const rows = {
      chainage: Array.from(order, (i) => s.chainage[i]!),
      height: Array.from(order, (i) => s.height[i]!),
      slot: Array.from(order, (i) => s.sourceSlot[i]!),
      cls: Array.from(order, (i) => s.classification[i]!),
    };
    return { section: makeSection(rows), from: order };
  }

  it('draws the same count from every cell and every class after a permutation', () => {
    const s = canopyOverGround(120_000, 0.05);
    const cap = 4000;
    const a = selectProfileSectionLod(s, { cap });
    const { section: p } = permute(s, 991);
    const b = selectProfileSectionLod(p, { cap });

    expect(b.length).toBe(a.length);

    const gridA = profileSectionLodGrid(s, cap);
    const gridB = profileSectionLodGrid(p, cap);
    expect(gridB.nx).toBe(gridA.nx);
    expect(gridB.ny).toBe(gridA.ny);

    const cellsA = histogram(
      Array.from(a, (i) => profileSectionLodCell(gridA, s.chainage[i]!, s.height[i]!)),
    );
    const cellsB = histogram(
      Array.from(b, (i) => profileSectionLodCell(gridB, p.chainage[i]!, p.height[i]!)),
    );
    expect(cellsB.size).toBe(cellsA.size);
    for (const [cell, count] of cellsA) expect(cellsB.get(cell)).toBe(count);

    const clsA = histogram(Array.from(a, (i) => s.classification[i]!));
    const clsB = histogram(Array.from(b, (i) => p.classification[i]!));
    for (const [cls, count] of clsA) expect(clsB.get(cls)).toBe(count);
  });

  it('does not favour the source that was scanned first', () => {
    // Two scans of the same corridor, equal size, concatenated.
    const rows = { chainage: [] as number[], height: [] as number[], slot: [] as number[], cls: [] as number[] };
    const rand = lcg(4242);
    for (const s of [0, 1]) {
      for (let i = 0; i < 60_000; i++) {
        rows.chainage.push(rand() * 200);
        rows.height.push(2 + rand() * 20);
        rows.slot.push(s);
        rows.cls.push(CANOPY);
      }
    }
    const section = makeSection(rows);
    const cap = 4000;
    const ours = selectProfileSectionLod(section, { cap });
    const share = countSlot(ours, section.sourceSlot, 1) / ours.length;
    console.log('second-scan share at cap 4000:', share.toFixed(3));
    // Two equal scans over the same corridor: a sampler with no order bias
    // lands near 0.5. The window is +/- 0.1, wide enough that grid ties do
    // not flake it and narrow enough that first-N (0.0) fails.
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
    const naiveFirst = firstN(section.count, cap);
    expect(countSlot(naiveFirst, section.sourceSlot, 1) / cap).toBe(0);
  });

  it('thins the whole section evenly when the strata outnumber the budget', () => {
    // 4 classes spread over the same 200 m x 40 m section, cap 1500. There
    // are about four strata per cell, so the walk over occupied strata is cut
    // off around a fifth of the way through and the order it runs in decides
    // what the view shows. Row-major, or any order that finishes one region
    // before starting the next, leaves most of the section blank.
    const rand = lcg(8080);
    const rows = { chainage: [] as number[], height: [] as number[], slot: [] as number[], cls: [] as number[] };
    for (let c = 1; c <= 4; c++) {
      for (let i = 0; i < 50_000; i++) {
        rows.chainage.push(rand() * 200);
        rows.height.push(rand() * 40);
        rows.slot.push(0);
        rows.cls.push(c);
      }
    }
    const s = makeSection(rows);
    const sel = selectProfileSectionLod(s, { cap: 1500 });
    const x = Array.from(sel, (i) => s.chainage[i]!);
    const y = Array.from(sel, (i) => s.height[i]!);
    // 12 bins on each axis: 1500 returns over 144 tiles average ten a tile,
    // so an empty tile is a hole in the walk and not a sampling accident.
    expect(() => assertAxisCoverage('chainage', x, 0, 200, 12)).not.toThrow();
    expect(() => assertAxisCoverage('height', y, 0, 40, 12)).not.toThrow();
  });

  it('covers the whole chainage rather than a prefix of it', () => {
    // A corridor read station by station, so index order is chainage order.
    // This is the arrangement that makes reading a prefix a truncation.
    const n = 120_000;
    const rand = lcg(31337);
    const rows = { chainage: [] as number[], height: [] as number[], slot: [] as number[], cls: [] as number[] };
    for (let i = 0; i < n; i++) {
      rows.chainage.push((i / n) * 200);
      rows.height.push(rand() < 0.05 ? rand() * 0.1 : 2 + rand() * 20);
      rows.slot.push(0);
      rows.cls.push(rows.height[i]! < 1 ? GROUND : CANOPY);
    }
    const s = makeSection(rows);
    const cap = 3000;
    const ours = selectProfileSectionLod(s, { cap });
    // 40 bins over 200 m: first-N reaches 5 m of the corridor and leaves 39
    // of them empty.
    expect(() => assertChainageCoverage(ours, s, 40)).not.toThrow();
    expect(() => assertChainageCoverage(firstN(s.count, cap), s, 40)).toThrow(
      /chainage bins with nothing drawn/,
    );
  });
});

describe('profileSectionLod: forced keeps', () => {
  const s = canopyOverGround(100_000, 0.05);

  it('always draws the kept indices', () => {
    const keep = [0, 1, 12_345, 99_999];
    const sel = selectProfileSectionLod(s, { cap: 2000, keep });
    expect(() => assertContains(sel, keep)).not.toThrow();
    expect(sel.length).toBe(2000);

    const without = selectProfileSectionLod(s, { cap: 2000 });
    expect(() => assertContains(without, keep)).toThrow(/missing forced keeps/);
  });

  it('keeps a return that the stratified walk would otherwise never reach', () => {
    // The last return of the densest canopy stratum: deep in a crowded cell,
    // and last in index order inside it.
    const target = 90_000;
    const plain = selectProfileSectionLod(s, { cap: 1500 });
    expect(Array.from(plain)).not.toContain(target);
    const kept = selectProfileSectionLod(s, { cap: 1500, keep: [target] });
    expect(Array.from(kept)).toContain(target);
    expect(kept.length).toBe(1500);
  });

  it('ignores repeats and out-of-range keeps', () => {
    const sel = selectProfileSectionLod(s, {
      cap: 500,
      keep: [42, 42, 42, -1, 100_000, 1e9, 3.5, Number.NaN],
    });
    expect(sel.length).toBe(500);
    expect(new Set(Array.from(sel)).size).toBe(500);
    expect(Array.from(sel)).toContain(42);
  });

  it('emits the keep set whole when it is larger than the cap', () => {
    const keep = [5, 6, 7, 8, 9];
    const sel = selectProfileSectionLod(s, { cap: 2, keep });
    expect(Array.from(sel)).toEqual(keep);
    const none = selectProfileSectionLod(s, { cap: 0, keep });
    expect(Array.from(none)).toEqual(keep);
  });
});

describe('profileSectionLod: degenerate sections', () => {
  it('handles a section at a single chainage', () => {
    const n = 10_000;
    const rand = lcg(5);
    const rows = { chainage: [] as number[], height: [] as number[], slot: [] as number[], cls: [] as number[] };
    for (let i = 0; i < n; i++) {
      rows.chainage.push(12.5);
      rows.height.push(rand() * 30);
      rows.slot.push(0);
      rows.cls.push(i % 100 === 0 ? GROUND : CANOPY);
    }
    const s = makeSection(rows);
    const grid = profileSectionLodGrid(s, 500);
    expect(grid.nx).toBe(1);
    expect(grid.ny).toBeGreaterThan(1);
    const sel = selectProfileSectionLod(s, { cap: 500 });
    expect(sel.length).toBe(500);
    expect(countClass(sel, s.classification, GROUND)).toBeGreaterThan(0);
  });

  it('handles a section at a single height', () => {
    const n = 10_000;
    const rand = lcg(6);
    const rows = { chainage: [] as number[], height: [] as number[], slot: [] as number[], cls: [] as number[] };
    for (let i = 0; i < n; i++) {
      rows.chainage.push(rand() * 200);
      rows.height.push(101.25);
      rows.slot.push(0);
      rows.cls.push(GROUND);
    }
    const s = makeSection(rows);
    const grid = profileSectionLodGrid(s, 500);
    expect(grid.ny).toBe(1);
    expect(grid.nx).toBeGreaterThan(1);
    const sel = selectProfileSectionLod(s, { cap: 500 });
    expect(sel.length).toBe(500);
    expect(() => assertChainageCoverage(sel, s, 20)).not.toThrow();
  });

  it('handles a single return and a section of identical returns', () => {
    const one = makeSection({ chainage: [3], height: [4], slot: [0], cls: [GROUND] });
    expect(Array.from(selectProfileSectionLod(one, { cap: 1 }))).toEqual([0]);
    expect(Array.from(selectProfileSectionLod(one, { cap: 500 }))).toEqual([0]);
    expect(selectProfileSectionLod(one, { cap: 0 }).length).toBe(0);

    const same = makeSection({
      chainage: new Array(5000).fill(1),
      height: new Array(5000).fill(1),
      slot: new Array(5000).fill(0),
      cls: new Array(5000).fill(GROUND),
    });
    const grid = profileSectionLodGrid(same, 100);
    expect(grid.nx).toBe(1);
    expect(grid.ny).toBe(1);
    const sel = selectProfileSectionLod(same, { cap: 100 });
    expect(sel.length).toBe(100);
    expect(new Set(Array.from(sel)).size).toBe(100);
  });

  it('handles a section with no classification channel', () => {
    const base = canopyOverGround(20_000, 0.05);
    const noCls: ProfileSectionLodInput = {
      count: base.count,
      chainage: base.chainage,
      height: base.height,
      sourceSlot: base.sourceSlot,
    };
    const sel = selectProfileSectionLod(noCls, { cap: 1000 });
    expect(sel.length).toBe(1000);
    expect(new Set(Array.from(sel)).size).toBe(1000);
  });

  it('tolerates non-finite coordinates', () => {
    const rand = lcg(9);
    const rows = { chainage: [] as number[], height: [] as number[], slot: [] as number[], cls: [] as number[] };
    for (let i = 0; i < 5000; i++) {
      rows.chainage.push(rand() * 200);
      rows.height.push(rand() * 20);
      rows.slot.push(0);
      rows.cls.push(CANOPY);
    }
    rows.chainage[10] = Number.NaN;
    rows.height[20] = Number.POSITIVE_INFINITY;
    const s = makeSection(rows);
    const sel = selectProfileSectionLod(s, { cap: 400 });
    expect(sel.length).toBe(400);
    expect(new Set(Array.from(sel)).size).toBe(400);
  });
});

/**
 * The seam that lets a caller spread a selection across frames.
 *
 * Two things are pinned here, and they pull against each other. The walk has
 * to hand the thread back often enough to be worth having — a generator that
 * yields once at the end is not a seam — and handing it back must not change
 * a single index of the answer. So every property the module is built on is
 * re-checked on a walk pumped one step at a time, and the chunk size is
 * varied over four orders of magnitude with the bytes compared exactly.
 */
describe('profileSectionLod: the yield seam', () => {
  /** Canopy over ground, with a rare class and a rare second scan. */
  function mixed(total: number): Section {
    const rows = { chainage: [] as number[], height: [] as number[], slot: [] as number[], cls: [] as number[] };
    const rand = lcg(4242);
    for (let i = 0; i < total; i++) {
      // Drawn rather than laid on the index, so a stride cannot alias onto a
      // stratum and appear to preserve it.
      const ground = rand() < 0.05;
      const rare = rand() < 0.0016;
      const second = rand() < 0.001;
      rows.chainage.push(rand() * 200);
      rows.height.push(ground ? rand() * 0.1 : 2 + rand() * 20);
      rows.slot.push(second ? 1 : 0);
      rows.cls.push(rare ? NOISE : ground ? GROUND : CANOPY);
    }
    return makeSection(rows);
  }

  /** Drive the generator by hand, keeping every progress value it yielded. */
  function pumped(
    section: ProfileSectionLodInput,
    options: ProfileSectionLodOptions,
  ): { indices: Uint32Array; progress: number[] } {
    const it = selectProfileSectionLodChunks(section, options);
    const progress: number[] = [];
    let step = it.next();
    while (!step.done) {
      progress.push(step.value);
      step = it.next();
    }
    return { indices: step.value, progress };
  }

  const section = mixed(60_000);
  const CAP = 3000;

  it('chooses the same returns wherever the thread is handed back', () => {
    const want = selectProfileSectionLod(section, { cap: CAP });
    expect(want.length).toBe(CAP);
    for (const chunkSize of [1, 97, 5000, 64_000, undefined]) {
      const got = pumped(section, { cap: CAP, chunkSize }).indices;
      expect(Array.from(got)).toEqual(Array.from(want));
    }
    // And with a keep set, which is the state most easily lost at a boundary.
    const keep = [3, 4, section.count - 1];
    const wantKept = selectProfileSectionLod(section, { cap: CAP, keep });
    for (const chunkSize of [1, 97, 5000]) {
      const got = pumped(section, { cap: CAP, keep, chunkSize }).indices;
      expect(Array.from(got)).toEqual(Array.from(wantKept));
    }
  });

  it('spends the whole cap on a walk pumped one step at a time', () => {
    const { indices } = pumped(section, { cap: CAP, chunkSize: 1 });
    expect(indices.length).toBe(CAP);
    expect(new Set(Array.from(indices)).size).toBe(CAP);
    // Ascending, so the result is still an index list a renderer can read
    // straight through.
    expect(Array.from(indices)).toEqual(Array.from(indices).slice().sort((a, b) => a - b));
  });

  it('keeps the stratum floors on a walk pumped one step at a time', () => {
    const { indices } = pumped(section, { cap: CAP, chunkSize: 1 });
    // The floors are what a chunk boundary inside the floor stage would cost:
    // the ground band, the rare class and the second scan are all minorities.
    assertGroundLine(indices, section, 250);
    assertClassFloor(indices, section, NOISE, 90);
    assertSlotFloor(indices, section, 1, 50);
    // A stride over the same section, which is what the floors exist to beat.
    const stride = uniformStride(section.count, CAP);
    expect(() => assertGroundLine(stride, section, 250)).toThrow();
    expect(() => assertClassFloor(stride, section, NOISE, 90)).toThrow();
    expect(() => assertSlotFloor(stride, section, 1, 50)).toThrow();
    // Exactly what the run-to-completion path draws from each, not merely some.
    const whole = selectProfileSectionLod(section, { cap: CAP });
    for (const cls of [GROUND, CANOPY, NOISE]) {
      expect(countClass(indices, section.classification, cls)).toBe(
        countClass(whole, section.classification, cls),
      );
    }
  });

  it('carries the forced keeps across every boundary', () => {
    const keep = [3, 4, 19_999, section.count - 1];
    const { indices } = pumped(section, { cap: CAP, keep, chunkSize: 1 });
    assertContains(indices, keep);
    expect(indices.length).toBe(CAP);
  });

  it('hands the thread back at least every chunk, and more often as the chunk shrinks', () => {
    const coarse = pumped(section, { cap: CAP, chunkSize: 20_000 });
    const fine = pumped(section, { cap: CAP, chunkSize: 2_000 });
    // A generator that yielded once at the end would satisfy nothing here.
    expect(coarse.progress.length).toBeGreaterThan(4);
    expect(fine.progress.length).toBeGreaterThan(coarse.progress.length);
    // Progress only ever goes forward, and never by more than one chunk: the
    // gap between two yields is the work one uninterrupted task carries.
    let previous = 0;
    for (const at of coarse.progress) {
      expect(at).toBeGreaterThan(previous);
      expect(at - previous).toBeLessThanOrEqual(20_000);
      previous = at;
    }
  });

  it('runs the generator to completion in the convenience wrapper', () => {
    const keep = [1, 2, 3];
    const direct = selectProfileSectionLod(section, { cap: CAP, keep });
    const byHand = pumped(section, { cap: CAP, keep, chunkSize: 64_000 }).indices;
    expect(Array.from(direct)).toEqual(Array.from(byHand));
  });

  it('yields nothing it cannot finish: empty, under-cap and zero-cap sections', () => {
    const small = mixed(500);
    expect(pumped(small, { cap: 5000, chunkSize: 1 }).indices.length).toBe(500);
    expect(pumped(small, { cap: 0, chunkSize: 1 }).indices.length).toBe(0);
    const empty = makeSection({ chainage: [], height: [], slot: [], cls: [] });
    expect(pumped(empty, { cap: 100, chunkSize: 1 }).indices.length).toBe(0);
  });
});
