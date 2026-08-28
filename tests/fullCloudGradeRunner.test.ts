/**
 * fullCloudGradeRunner.test.ts — the full-cloud grade orchestration seam.
 *
 * Decode and grade are injected (live streaming I/O and the terrain pipeline are
 * browser/heavy and stay out of this layer), so these tests pin the deterministic
 * orchestration: plan → budget guard → coverage → ordered assembly → one
 * back-scaled grade, plus the honest exhaustive-vs-sampled coverage, the strict
 * decoded-count check, the oversized-plan refusal, and cooperative cancellation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runFullCloudGrade,
  FullCloudGradeRefusedError,
  FullCloudGradeShortDecodeError,
} from '../src/render/streaming/fullCloudGradeRunner';
import type { SampleNode } from '../src/render/streaming/samplingPlan';
import { MAX_SAMPLE_POINTS } from '../src/render/streaming/fullCloudGrade';
import { gradeSampleDensity } from '../src/render/streaming/sampleGrade';

/** Three nodes: root 2 pts, then two depth-1 nodes (3 and 1 pts) → 6 total. */
function nodes(): SampleNode[] {
  return [
    { id: '0-0-0-0', depth: 0, pointCount: 2, byteSize: 1000 },
    { id: '1-0-0-0', depth: 1, pointCount: 3, byteSize: 1000 },
    { id: '1-1-0-0', depth: 1, pointCount: 1, byteSize: 1000 },
  ];
}

/** Points per node id, matching the header counts in {@link nodes}. */
const COUNT: Record<string, number> = { '0-0-0-0': 2, '1-0-0-0': 3, '1-1-0-0': 1 };

/**
 * A decode that returns EXACTLY the node's declared count of identical XYZ
 * triples (all set to the id's marker) — the honest case COPC/EPT always meet,
 * since hierarchy counts are exact.
 */
function markerDecode(marker: Record<string, number>) {
  return async (id: string): Promise<Float32Array> => {
    const v = marker[id];
    const n = COUNT[id] ?? 0;
    const out = new Float32Array(n * 3);
    out.fill(v);
    return out;
  };
}

describe('runFullCloudGrade — orchestration', () => {
  it('exhaustive plan: grades with scale 1 and reports the exact coverage', async () => {
    const grade = vi.fn((_pos: Float32Array, scale: number) => ({ scale }));
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 }),
      grade,
      // budget above the 6 total → every node selected → exhaustive
      options: { maxPoints: 10_000 },
    });
    expect(out.coverage.scope).toBe('exhaustive');
    expect(out.coverage.coveragePercent).toBe(100);
    expect(out.coverage.samplePointScale).toBe(1);
    expect(grade).toHaveBeenCalledTimes(1);
    expect(grade.mock.calls[0][1]).toBe(1); // scale passed through
    // The whole sample (6 points) is graded, no truncation.
    expect(grade.mock.calls[0][0]).toHaveLength(18);
  });

  it('sampled plan: back-scales density and marks the grade as sampled', async () => {
    // maxPoints 2 → only the root node (2 pts) is decoded; 2 of 6 = 33%.
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 }),
      grade: (_pos, scale) => scale,
      options: { maxPoints: 2 },
    });
    expect(out.coverage.scope).toBe('sampled');
    expect(out.coverage.coveragePercent).toBe(33);
    expect(out.coverage.samplePointScale).toBeCloseTo(3, 5); // 6/2
    expect(out.grade).toBeCloseTo(3, 5);
    expect(out.coverage.note).toMatch(/representative octree sample/i);
  });

  it('assembles decoded chunks in deterministic plan order', async () => {
    // Root first (shallow), then the two depth-1 nodes by count desc, then id.
    // Markers prove order: root=10 (2 pts), 1-0-0-0=20 (3 pts), 1-1-0-0=30 (1 pt).
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 10, '1-0-0-0': 20, '1-1-0-0': 30 }),
      grade: (pos) => Array.from(pos),
      options: { maxPoints: 10_000 },
    });
    expect(out.grade).toEqual([
      10, 10, 10, 10, 10, 10, // root: 2 pts
      20, 20, 20, 20, 20, 20, 20, 20, 20, // 1-0-0-0: 3 pts
      30, 30, 30, // 1-1-0-0: 1 pt
    ]);
  });

  it('FAILS the grade when a node decodes MORE points than its header count', async () => {
    // The plan sizes coverage + the density back-scale from the exact header
    // counts. A node decoding extra points is a hierarchy/decoder inconsistency,
    // not something to silently absorb — fail cleanly.
    const decode = async (id: string): Promise<Float32Array> =>
      id === '0-0-0-0'
        ? Float32Array.of(1, 1, 1, 9, 9, 9, 5, 5, 5) // 3 pts, header says 2
        : markerDecode({ '1-0-0-0': 2, '1-1-0-0': 3 })(id);
    await expect(
      runFullCloudGrade({
        nodes: nodes(),
        decodeNode: decode,
        grade: (pos) => Array.from(pos),
        options: { maxPoints: 10_000 },
      }),
    ).rejects.toBeInstanceOf(FullCloudGradeShortDecodeError);
  });

  it('FAILS the grade when a node decodes FEWER points than its header count', async () => {
    // The defect BUG 8 guards: a short decode under a plan-based scale would
    // report a coverage the grade never decoded. Strict check → clean failure.
    const decode = async (id: string): Promise<Float32Array> =>
      id === '1-0-0-0'
        ? Float32Array.of(2, 2, 2) // 1 pt, header says 3
        : markerDecode({ '0-0-0-0': 1, '1-1-0-0': 3 })(id);
    await expect(
      runFullCloudGrade({
        nodes: nodes(),
        decodeNode: decode,
        grade: (pos) => pos.length,
        options: { maxPoints: 10_000 },
      }),
    ).rejects.toThrow(/decoded 1 points.*declared 3/);
  });

  it('EQUIVALENCE: the streamed-into-one-buffer grade equals grading a manual concat', async () => {
    // The memory optimisation (decode straight into a pre-sized buffer, release
    // each chunk) must not change the result. Build varied-size chunks whose
    // counts MATCH their headers, grade via the runner with the REAL
    // gradeSampleDensity, and compare field-for-field to grading a
    // hand-concatenated buffer of the same points in the same order.
    const big: SampleNode[] = [
      { id: '0-0-0-0', depth: 0, pointCount: 2, byteSize: 1 },
      { id: '1-0-0-0', depth: 1, pointCount: 3, byteSize: 1 },
      { id: '1-1-0-0', depth: 1, pointCount: 1, byteSize: 1 },
    ];
    // Deterministic, finite points; a couple of non-finite to exercise validity.
    // Each chunk's point count equals its header count above.
    const chunkFor: Record<string, Float32Array> = {
      '0-0-0-0': Float32Array.of(0, 0, 0, 10, 5, 2),
      '1-0-0-0': Float32Array.of(3, 4, 1, 7, 1, 9, NaN, 2, 2),
      '1-1-0-0': Float32Array.of(6, 6, 6),
    };
    const order = ['0-0-0-0', '1-0-0-0', '1-1-0-0'];
    const concat = Float32Array.of(...order.flatMap((id) => Array.from(chunkFor[id])));

    const out = await runFullCloudGrade({
      nodes: big,
      decodeNode: async (id) => chunkFor[id],
      grade: (pos, scale) => gradeSampleDensity(pos, scale),
      options: { maxPoints: 10_000 },
    });
    const direct = gradeSampleDensity(concat, out.coverage.samplePointScale);
    expect(out.grade).toEqual(direct);
  });

  it('empty octree: no decode, scale 1, "no points" coverage', async () => {
    const decode = vi.fn();
    const out = await runFullCloudGrade({
      nodes: [],
      decodeNode: decode,
      grade: (pos) => pos.length,
    });
    expect(decode).not.toHaveBeenCalled();
    expect(out.grade).toBe(0); // empty assembled buffer
    expect(out.coverage.samplePointScale).toBe(1);
    expect(out.coverage.label).toMatch(/no points/i);
  });

  it('honours an already-aborted signal before decoding', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const decode = vi.fn();
    await expect(
      runFullCloudGrade({
        nodes: nodes(),
        decodeNode: decode,
        grade: (_p, s) => s,
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('forwards octree completeness: an incomplete hierarchy is never labelled exact', async () => {
    // Budget covers all 6 points → plan.exhaustive is true → the old path said
    // "exact". A false `completeness` (a truncated hierarchy) must override that.
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 }),
      grade: (_pos, scale) => scale,
      options: { maxPoints: 10_000 },
      completeness: { complete: false, errorCount: 1 },
    });
    expect(out.coverage.scope).toBe('sampled');
    expect(out.coverage.label).not.toMatch(/exact/);
    expect(out.coverage.note).toMatch(/did not fully load/i);
  });

  it('a complete hierarchy within budget keeps the exact label (no false downgrade)', async () => {
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 }),
      grade: (_pos, scale) => scale,
      options: { maxPoints: 10_000 },
      completeness: { complete: true, errorCount: 0 },
    });
    expect(out.coverage.scope).toBe('exhaustive');
    expect(out.coverage.label).toMatch(/exact/);
  });
});

describe('runFullCloudGrade — oversized-plan budget guard (BUG 7)', () => {
  it('REFUSES a first node above the point ceiling WITHOUT the giant allocation', async () => {
    // The planner always selects at least one node, so a single node above the
    // sample budget becomes the whole plan. Sizing positions at sampledPoints*3
    // would allocate multiple gigabytes; the guard must refuse before that.
    const huge: SampleNode[] = [
      { id: '0-0-0-0', depth: 0, pointCount: MAX_SAMPLE_POINTS + 1, byteSize: 10 },
    ];
    const decode = vi.fn();

    // Spy every Float32Array construction so we can prove none of the giant
    // decode buffer was allocated. Safe here because the refusal is thrown
    // before decode/coverage, so nothing on this path constructs a Float32Array.
    const RealF32 = Float32Array;
    const sizes: number[] = [];
    const spy = vi.spyOn(globalThis, 'Float32Array').mockImplementation(((arg: number) => {
      if (typeof arg === 'number') sizes.push(arg);
      return new RealF32(arg as number);
    }) as never);

    try {
      await expect(
        runFullCloudGrade({
          nodes: huge,
          decodeNode: decode,
          grade: () => null,
          options: { maxPoints: 2_000_000 },
        }),
      ).rejects.toBeInstanceOf(FullCloudGradeRefusedError);
    } finally {
      spy.mockRestore();
    }

    // The refusal fired before any decode and before the multi-gigabyte buffer.
    expect(decode).not.toHaveBeenCalled();
    expect(sizes.every((n) => n < (MAX_SAMPLE_POINTS + 1) * 3)).toBe(true);
  });

  it('carries a user-facing refusal (headline + note) on the error', async () => {
    const huge: SampleNode[] = [
      { id: '0-0-0-0', depth: 0, pointCount: MAX_SAMPLE_POINTS + 1, byteSize: 10 },
    ];
    let caught: unknown;
    try {
      await runFullCloudGrade({ nodes: huge, decodeNode: vi.fn(), grade: () => null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FullCloudGradeRefusedError);
    const refusal = (caught as FullCloudGradeRefusedError).refusal;
    expect(refusal.headline).toMatch(/exceeds the safe decode budget/i);
    expect(refusal.note).toMatch(/safe ceiling/i);
  });

  it('REFUSES a 3M-point node (above the 2M ceiling) before the sample allocation', async () => {
    // A node coarser than the 2,000,000-point sample target: it sits below the
    // former 8M ceiling but above the current one, so the peak-memory fix must
    // decline it. The planner always selects at least one node, so this single
    // node is the whole plan; the guard fires before positions is sized.
    expect(MAX_SAMPLE_POINTS).toBe(2_000_000);
    const coarse: SampleNode[] = [
      { id: '0-0-0-0', depth: 0, pointCount: 3_000_000, byteSize: 10 },
    ];
    const decode = vi.fn();
    const RealF32 = Float32Array;
    const sizes: number[] = [];
    const spy = vi.spyOn(globalThis, 'Float32Array').mockImplementation(((arg: number) => {
      if (typeof arg === 'number') sizes.push(arg);
      return new RealF32(arg as number);
    }) as never);
    try {
      await expect(
        runFullCloudGrade({
          nodes: coarse,
          decodeNode: decode,
          grade: () => null,
          options: { maxPoints: 2_000_000 },
        }),
      ).rejects.toBeInstanceOf(FullCloudGradeRefusedError);
    } finally {
      spy.mockRestore();
    }
    expect(decode).not.toHaveBeenCalled();
    expect(sizes.every((n) => n < 3_000_000 * 3)).toBe(true);
  });

  it('grades a normal-sized node fine (the ceiling does not block real work)', async () => {
    const normal: SampleNode[] = [
      { id: '0-0-0-0', depth: 0, pointCount: 3, byteSize: 10 },
    ];
    const out = await runFullCloudGrade({
      nodes: normal,
      decodeNode: async () => new Float32Array(9), // 3 pts, matches header
      grade: (pos) => pos.length,
      options: { maxPoints: 2_000_000 },
    });
    expect(out.grade).toBe(9);
    expect(out.coverage.scope).toBe('exhaustive');
  });
});
