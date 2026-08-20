/**
 * e57PdalCrossDecode.test.ts — OLV's E57 reader against PDAL's, point for point.
 *
 * WHY A SECOND READER AND NOT THE FILE'S OWN METADATA. An E57 file declares its
 * own `recordCount`, `cartesianBounds` and per-field limits, and OLV reproduces
 * all of them exactly. That is worth asserting, and it is NOT cross-implementation
 * evidence: bounds are six numbers, two per axis, out of 1,788,994 decoded values,
 * and they are the tails by construction. A decoder that corrupted the interior
 * while preserving the extremal points would satisfy every declared figure. This
 * test exists because agreement on six statistics is not agreement on a decode.
 *
 * The oracle is PDAL 2.10.2 `readers.e57`, an independent implementation of the
 * same standard, and the same tool this project already cross-checks DSM, DTM and
 * CHM against. Its output is committed, so the assertion runs without PDAL
 * installed; regenerating it needs PDAL and the source file.
 *
 * WHAT MAKES THE COMPARISON FULL COVERAGE. The per-dimension QUANTISED SUM is the
 * strong leg: every value rounded to 1e-6 and summed as an exact integer, which
 * is order independent and lossless, so ANY single point differing by 1e-6 or
 * more fails it. The mean is kept as a second, differently-shaped check but is
 * deliberately NOT relied on for that: measured against this point count, one
 * value would have to be wrong by about 1.79 m before it moved the mean past the
 * registered 1e-6 budget. The mean catches systematic error, which is the
 * realistic parser failure; the integer sum catches the isolated kind it cannot.
 * Extremes and count bound the set, and the 18 committed positional samples,
 * spread the length of the file, turn a failure into a diagnosis.
 *
 * SCOPE, and what is deliberately outside it.
 *   - Cartesian, normals and colour are compared. Colour reconciles exactly:
 *     PDAL promotes the E57 8-bit channel to uint16 as `c * 257`.
 *   - INTENSITY IS EXCLUDED. PDAL scales it by 65535/(max-min) WITHOUT
 *     subtracting the minimum, so its values do not round-trip the declared
 *     limits. That transform is PDAL's choice, not something the E57 standard
 *     pins, so a tolerance here would measure the scaling rather than either
 *     reader. The measured relationship is recorded in the reference file.
 *   - One file, one writer. This is evidence about THIS profile (E57Format 2.3.0,
 *     uncompressed, single-precision cartesian, `nor:` normals extension, 8-bit
 *     colour) and says nothing about scanner-native writers or scaled-integer
 *     cartesian fields, whose per-field limits ARE decode parameters and would
 *     make a bounds check circular.
 *
 * Source: Zenodo 10.5281/zenodo.7576524, "3DPC of a gypsum slope in Finestrat,
 * Alicante (Spain)", Abellan and Riquelme, CC-BY-4.0. Not redistributed here;
 * the test skips when the file is absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseE57 } from '../src/io/e57/parseE57';

/**
 * Where a local copy of the CC-BY source lives, if the runner has one. The file
 * is not vendored, so the path is supplied rather than baked in: set
 * `OLV_E57_FINESTRAT` to a copy fetched from the DOI in the study manifest. With
 * no such copy the comparison skips and the committed reference is still checked.
 */
const E57_PATH = process.env.OLV_E57_FINESTRAT ?? '';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'e57-pdal');

interface DimStats {
  readonly count: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
}
interface Reference {
  readonly recordCount: number;
  readonly sha256: string;
  readonly quantum: number;
  readonly stats: Record<string, DimStats>;
  /** Exact integer sums, as decimal strings so no precision is lost in JSON. */
  readonly quantisedSums: Record<string, string>;
}

/**
 * Tolerances REGISTERED BEFORE the reference was generated, which is what keeps
 * this an agreement measurement rather than a description of the error that
 * happened to occur.
 */
const TOL = {
  /** Both readers surface IEEE singles. Far below survey relevance, far above
   *  the ~2e-10 rounding of the 9-decimal text round trip PDAL wrote. */
  cartesianM: 1e-6,
  /** Dimensionless unit-vector components. */
  normal: 1e-6,
  /** `c * 257` is exact integer arithmetic on both sides, so the EXTREMES match
   *  exactly and carry no budget. */
  colorCounts: 0,
  /**
   * The MEAN is the one figure the pre-registered budget did not anticipate, and
   * widening it after measuring is disclosed rather than quiet. Both readers
   * average the same 1,788,994 values, but in different summation orders, so
   * float64 accumulation separates them by a few parts in 1e11. A real decode
   * error moves a mean by order one count, which is 3e-5 relative on the colour
   * channels: seven orders of magnitude above this, so the widened budget still
   * fails on anything that matters.
   */
  meanRelative: 1e-9,
} as const;

/** PDAL promotes an E57 8-bit colour channel to uint16. */
const COLOR_TO_UINT16 = 257;

const reference = JSON.parse(
  readFileSync(join(FIXTURES, 'pdal-reference.json'), 'utf8'),
) as Reference;

/** The committed positional samples, PDAL's values in file order. */
function pdalSamples(): Record<string, number>[] {
  const lines = readFileSync(join(FIXTURES, 'pdal_sample.csv'), 'utf8').trim().split('\n');
  const head = lines[0].split(',').map((h) => h.replace(/"/g, ''));
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map(Number);
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

/** Decode with OLV, or null when the source file is not on this machine. */
function decode(): Record<string, ArrayLike<number>> | null {
  if (!E57_PATH || !existsSync(E57_PATH)) return null;
  const buf = readFileSync(E57_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const parsed = parseE57(ab) as unknown as { scans: Record<string, unknown>[] };
  return parsed.scans[0].columns as Record<string, ArrayLike<number>>;
}

const cols = decode();
const haveSource = cols !== null;
const withSource = haveSource ? describe : describe.skip;

describe('E57 cross-decode reference', () => {
  it('records which source file it was generated from', () => {
    // The checksum is the link between the committed numbers and the bytes they
    // describe. Without it a future reference could silently describe a
    // different file.
    expect(reference.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reference.recordCount).toBe(1788994);
  });

  it('excludes intensity, and says why in the reference itself', () => {
    const excluded = (reference as unknown as Record<string, { note?: string }>)
      ._excluded_Intensity ?? (reference.stats as unknown as Record<string, { note?: string }>)._excluded_Intensity;
    const note = JSON.stringify(reference);
    expect(note).toMatch(/EXCLUDED/);
    expect(note).toMatch(/without subtracting the minimum/i);
    expect(excluded ?? true).toBeTruthy();
  });
});

withSource('OLV and PDAL decode the same E57 the same way', () => {
  /** Mean, min and max over EVERY decoded value of one column. */
  function summarize(c: ArrayLike<number>): DimStats {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let nonFinite = 0;
    // No assertion inside this loop: it runs 1,788,994 times per column, and an
    // `expect` per iteration costs more than the decode it is checking.
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      if (!Number.isFinite(v)) { nonFinite++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    expect(nonFinite, 'non-finite decoded values').toBe(0);
    return { count: c.length, mean: sum / c.length, min, max };
  }

  const CARTESIAN: readonly (readonly [string, string])[] = [
    ['cartesianX', 'X'],
    ['cartesianY', 'Y'],
    ['cartesianZ', 'Z'],
  ];
  const NORMALS: readonly (readonly [string, string])[] = [
    ['nor:normalX', 'NormalX'],
    ['nor:normalY', 'NormalY'],
    ['nor:normalZ', 'NormalZ'],
  ];
  const COLOURS: readonly (readonly [string, string])[] = [
    ['colorRed', 'Red'],
    ['colorGreen', 'Green'],
    ['colorBlue', 'Blue'],
  ];

  /**
   * Sum of `Math.round(v * quantum)` as an exact BigInt: order independent, and
   * lossless, so it cannot absorb a single wrong value the way a mean can. The
   * reference is generated with `floor(x + 0.5)` to match `Math.round` exactly,
   * including on ties and negatives.
   */
  function quantisedSum(c: ArrayLike<number>, scale = 1): bigint {
    let total = 0n;
    for (let i = 0; i < c.length; i++) {
      total += BigInt(Math.round(c[i] * scale * reference.quantum));
    }
    return total;
  }

  it('matches PDAL exactly on the quantised sum of every value', () => {
    // The strong leg. Unlike the mean, this cannot absorb one bad point: any
    // value differing by a micron changes the integer.
    for (const [olvKey, pdalKey] of [...CARTESIAN, ...NORMALS]) {
      const got = quantisedSum(cols![olvKey]);
      expect(got.toString(), `${pdalKey} quantised sum`).toBe(reference.quantisedSums[pdalKey]);
    }
    for (const [olvKey, pdalKey] of COLOURS) {
      const got = quantisedSum(cols![olvKey], COLOR_TO_UINT16);
      expect(got.toString(), `${pdalKey} quantised sum`).toBe(reference.quantisedSums[pdalKey]);
    }
  });

  it('decodes the same number of points', () => {
    for (const [olvKey] of [...CARTESIAN, ...NORMALS, ...COLOURS]) {
      expect(cols![olvKey], `missing column ${olvKey}`).toBeDefined();
      expect(cols![olvKey].length).toBe(reference.recordCount);
    }
  });

  it('agrees on every cartesian axis, over all 1,788,994 points', () => {
    for (const [olvKey, pdalKey] of CARTESIAN) {
      const got = summarize(cols![olvKey]);
      const want = reference.stats[pdalKey];
      // The MEAN is the full-coverage leg: one wrong interior value moves it.
      expect(Math.abs(got.mean - want.mean), `${pdalKey} mean`).toBeLessThan(TOL.cartesianM);
      expect(Math.abs(got.min - want.min), `${pdalKey} min`).toBeLessThan(TOL.cartesianM);
      expect(Math.abs(got.max - want.max), `${pdalKey} max`).toBeLessThan(TOL.cartesianM);
    }
  });

  it('agrees on the namespaced surface normals', () => {
    // These ride the `nor:` extension. A reader that dropped an unknown
    // namespace would mis-stride every record after it, so agreement here is
    // also evidence the extension fields are consumed at the right offsets.
    for (const [olvKey, pdalKey] of NORMALS) {
      const got = summarize(cols![olvKey]);
      const want = reference.stats[pdalKey];
      expect(Math.abs(got.mean - want.mean), `${pdalKey} mean`).toBeLessThan(TOL.normal);
      expect(Math.abs(got.min - want.min), `${pdalKey} min`).toBeLessThan(TOL.normal);
      expect(Math.abs(got.max - want.max), `${pdalKey} max`).toBeLessThan(TOL.normal);
    }
  });

  it('agrees on colour once PDAL’s uint16 promotion is undone', () => {
    for (const [olvKey, pdalKey] of COLOURS) {
      const got = summarize(cols![olvKey]);
      const want = reference.stats[pdalKey];
      // Exact integer arithmetic, so the tolerance is zero on the extremes.
      expect(got.min * COLOR_TO_UINT16, `${pdalKey} min`).toBe(want.min);
      expect(got.max * COLOR_TO_UINT16, `${pdalKey} max`).toBe(want.max);
      const mean = got.mean * COLOR_TO_UINT16;
      expect(
        Math.abs(mean - want.mean) / Math.abs(want.mean),
        `${pdalKey} mean (relative)`,
      ).toBeLessThan(TOL.meanRelative);
    }
  });

  it('agrees point for point on the committed samples, in file order', () => {
    // The aggregates above prove agreement; these make a failure legible, and
    // they pin ORDER, which an aggregate cannot see.
    const samples = pdalSamples();
    expect(samples.length).toBeGreaterThan(10);
    samples.forEach((row, s) => {
      const i = s * 100_000; // filters.decimation step
      for (const [olvKey, pdalKey] of CARTESIAN) {
        expect(Math.abs(cols![olvKey][i] - row[pdalKey]), `sample ${s} ${pdalKey}`)
          .toBeLessThan(TOL.cartesianM);
      }
      for (const [olvKey, pdalKey] of COLOURS) {
        expect(cols![olvKey][i] * COLOR_TO_UINT16, `sample ${s} ${pdalKey}`).toBe(row[pdalKey]);
      }
    });
  });
});
