/**
 * lassoVolumeWithheld.test.ts — the lasso volume leaves Withheld points out of
 * its input and keeps Overlap points, and says how many it left out.
 *
 * ASPRS LAS 1.4 defines Withheld as a point that should not be included in
 * processing; `withheldPolicy.ts` applies that to scientific processing. The
 * fixture puts Withheld points high above a flat pile, so reading them would
 * inflate the fill, and marks other points Overlap, which must be read as
 * normal. A source with no flags channel must report its count as unknown.
 */
import { describe, it, expect } from 'vitest';
import {
  computeLassoVolume,
  dropWithheld,
  streamingLassoParts,
  type LassoVolumeHost,
} from '../src/render/measure/lassoVolumeCompute';
import { PointCloud } from '../src/model/PointCloud';
import { encodeExtendedClassificationFlags } from '../src/lasSemantics';

const WITHHELD = encodeExtendedClassificationFlags({ withheld: true });
const OVERLAP = encodeExtendedClassificationFlags({ overlap: true });
const BOTH = encodeExtendedClassificationFlags({ withheld: true, overlap: true });

const N = 20;
const SIZE = 10;

/** A 20×20 grid with a 1 m raised centre; flagged points carry their own z. */
function fixture(): { positions: Float32Array; flags: Uint8Array; withheld: number; overlap: number } {
  const positions = new Float32Array(N * N * 3);
  const flags = new Uint8Array(N * N);
  let withheld = 0;
  let overlap = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      const x = (c / (N - 1)) * SIZE;
      const y = (r / (N - 1)) * SIZE;
      let z = Math.hypot(x - SIZE / 2, y - SIZE / 2) < SIZE / 4 ? 1 : 0;
      if (i % 17 === 5) {
        // Withheld: a spike that would add fill if it were read.
        flags[i] = i % 34 === 5 ? BOTH : WITHHELD;
        z = 40;
        withheld++;
      } else if (i % 11 === 3) {
        flags[i] = OVERLAP;
        overlap++;
      }
      positions.set([x, y, z], i * 3);
    }
  }
  return { positions, flags, withheld, overlap };
}

function cloud(positions: Float32Array, classificationFlags?: Uint8Array): PointCloud {
  return new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 'w.las', classificationFlags });
}

/** The same fixture with the Withheld points removed from the buffer. */
function withoutWithheld(f: ReturnType<typeof fixture>): Float32Array {
  const kept: number[] = [];
  for (let i = 0; i < N * N; i++) {
    if (f.flags[i] === WITHHELD || f.flags[i] === BOTH) continue;
    kept.push(f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]);
  }
  return Float32Array.from(kept);
}

const lasso = [
  { x: -1, y: -1 },
  { x: SIZE + 1, y: -1 },
  { x: SIZE + 1, y: SIZE + 1 },
  { x: -1, y: SIZE + 1 },
];

function host(over: Partial<LassoVolumeHost> = {}): LassoVolumeHost {
  return {
    project: (x, y) => ({ x, y }),
    integrable: [],
    streamingParts: [],
    wasReduced: () => false,
    visibilityFor: () => null,
    worldUp: [0, 0, 1],
    ...over,
  };
}

const run = (h: LassoVolumeHost, includeWithheld?: boolean) =>
  computeLassoVolume({ host: h, lasso, referencePercentile: 0.05, includeWithheld })!;

describe('lasso volume input and the Withheld flag', () => {
  const f = fixture();

  it('leaves Withheld points out and counts them', () => {
    const out = run(host({ integrable: [['a', { cloud: cloud(f.positions, f.flags) }]] }));
    expect(f.withheld).toBeGreaterThan(0);
    expect(out.withheld).toEqual({ source: N * N, excluded: f.withheld, analysed: N * N - f.withheld });
    expect(out.selectedCount).toBe(N * N - f.withheld);
    // Same figure as a buffer that never held them.
    const ref = run(host({ integrable: [['a', { cloud: cloud(withoutWithheld(f)) }]] }));
    expect(out.result.fill).toBe(ref.result.fill);
    expect(out.result.cut).toBe(ref.result.cut);
    // And no spike reached the estimator.
    for (let i = 2; i < out.selectedPositions.length; i += 3) expect(out.selectedPositions[i]).toBeLessThan(40);
  });

  it('keeps Overlap points', () => {
    const onlyOverlap = f.flags.map((b) => (b === OVERLAP ? OVERLAP : 0));
    const flat = f.positions.map((v, k) => (k % 3 === 2 && v === 40 ? 0 : v));
    const out = run(host({ integrable: [['a', { cloud: cloud(flat, onlyOverlap) }]] }));
    expect(f.overlap).toBeGreaterThan(0);
    expect(out.withheld).toEqual({ source: N * N, excluded: 0, analysed: N * N });
    const unflagged = run(host({ integrable: [['a', { cloud: cloud(flat, new Uint8Array(N * N)) }]] }));
    expect(out.result.fill).toBe(unflagged.result.fill);
  });

  it('a point both Withheld and Overlap is left out', () => {
    const out = run(host({ integrable: [['a', { cloud: cloud(f.positions, f.flags) }]] }));
    expect(f.flags.includes(BOTH)).toBe(true);
    expect(out.withheld.excluded).toBe(f.withheld);
  });

  it('reports unknown, not 0, when the cloud has no flags channel', () => {
    const out = run(host({ integrable: [['a', { cloud: cloud(f.positions) }]] }));
    expect(out.withheld).toEqual({ source: N * N, excluded: 'unknown', analysed: N * N });
  });

  it('reports unknown for a voxel-reduced cloud even when it holds a flags array', () => {
    const out = run(host({
      integrable: [['a', { cloud: cloud(f.positions, f.flags) }]],
      wasReduced: () => true,
    }));
    expect(out.withheld.excluded).toBe('unknown');
    expect(out.selectedCount).toBe(N * N);
  });

  it('keeps them when the caller asks', () => {
    const out = run(host({ integrable: [['a', { cloud: cloud(f.positions, f.flags) }]] }), true);
    expect(out.withheld).toEqual({ source: N * N, excluded: 0, analysed: N * N });
  });

  it('applies to a resident streaming node that carries flags', () => {
    const parts = streamingLassoParts(
      [{ positions: f.positions, classificationFlags: f.flags }],
      null,
      () => null,
    );
    const out = run(host({ streamingParts: parts }));
    expect(out.withheld).toEqual({ source: N * N, excluded: f.withheld, analysed: N * N - f.withheld });
  });

  it('a mix of flagged and unflagged sources is unknown, and still drops what it can see', () => {
    const shifted = f.positions.map((v, k) => (k % 3 === 0 ? v + 0.01 : v));
    const out = run(host({
      integrable: [
        ['a', { cloud: cloud(f.positions, f.flags) }],
        ['b', { cloud: cloud(shifted) }],
      ],
    }));
    expect(out.withheld.excluded).toBe('unknown');
    expect(out.withheld.source).toBe(2 * N * N);
    expect(out.withheld.analysed).toBe(2 * N * N - f.withheld);
  });
});

describe('dropWithheld', () => {
  const sel = () => ({
    indices: Int32Array.from([0, 1, 2, 3]),
    screenX: Float64Array.from([0, 1, 2, 3]),
    screenY: Float64Array.from([0, 0, 0, 0]),
    depth: Float64Array.from([1, 1, 1, 1]),
    count: 4,
  });

  it('reads the source buffer through the walk stride', () => {
    // Strided index i addresses source point 2i.
    const flags = Uint8Array.from([0, WITHHELD, WITHHELD, 0, 0, 0, OVERLAP, 0]);
    const out = dropWithheld(sel(), flags, 8, 2);
    expect(out.dropped).toBe(1);
    expect(Array.from(out.sel.indices.subarray(0, out.sel.count))).toEqual([0, 2, 3]);
    expect(Array.from(out.sel.screenX.subarray(0, out.sel.count))).toEqual([0, 2, 3]);
  });

  it('treats a flags array of the wrong length as absent', () => {
    const out = dropWithheld(sel(), new Uint8Array(3).fill(WITHHELD), 4, 1);
    expect(out.dropped).toBeNull();
    expect(out.sel.count).toBe(4);
  });
});
