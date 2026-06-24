/**
 * fullCloudGradeRunner.test.ts — the full-cloud grade orchestration seam.
 *
 * Decode and grade are injected (live streaming I/O and the terrain pipeline are
 * browser/heavy and stay out of this layer), so these tests pin the deterministic
 * orchestration: plan → coverage → ordered assembly → one back-scaled grade, plus
 * the honest exhaustive-vs-sampled coverage and cooperative cancellation.
 */

import { describe, it, expect, vi } from 'vitest';
import { runFullCloudGrade } from '../src/render/streaming/fullCloudGradeRunner';
import type { SampleNode } from '../src/render/streaming/samplingPlan';
import { gradeSampleDensity } from '../src/render/streaming/sampleGrade';

/** Three nodes, 100 pts each (300 total). byteSize is irrelevant to these tests. */
function nodes(): SampleNode[] {
  return [
    { id: '0-0-0-0', depth: 0, pointCount: 100, byteSize: 1000 },
    { id: '1-0-0-0', depth: 1, pointCount: 100, byteSize: 1000 },
    { id: '1-1-0-0', depth: 1, pointCount: 100, byteSize: 1000 },
  ];
}

/** A decode that returns one identifiable XYZ triple per node (id → marker value). */
function markerDecode(marker: Record<string, number>) {
  return async (id: string): Promise<Float32Array> => {
    const v = marker[id];
    return Float32Array.of(v, v, v);
  };
}

describe('runFullCloudGrade — orchestration', () => {
  it('exhaustive plan: grades with scale 1 and reports the exact coverage', async () => {
    const grade = vi.fn((_pos: Float32Array, scale: number) => ({ scale }));
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 }),
      grade,
      // budget above the 300 total → every node selected → exhaustive
      options: { maxPoints: 10_000 },
    });
    expect(out.coverage.scope).toBe('exhaustive');
    expect(out.coverage.coveragePercent).toBe(100);
    expect(out.coverage.samplePointScale).toBe(1);
    expect(grade).toHaveBeenCalledTimes(1);
    expect(grade.mock.calls[0][1]).toBe(1); // scale passed through
  });

  it('sampled plan: back-scales density and marks the grade as sampled', async () => {
    // maxPoints 100 → only the root node (100 pts) is decoded; 100 of 300 = 33%.
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 }),
      grade: (_pos, scale) => scale,
      options: { maxPoints: 100 },
    });
    expect(out.coverage.scope).toBe('sampled');
    expect(out.coverage.coveragePercent).toBe(33);
    expect(out.coverage.samplePointScale).toBeCloseTo(3, 5); // 300/100
    expect(out.grade).toBeCloseTo(3, 5);
    expect(out.coverage.note).toMatch(/representative octree sample/i);
  });

  it('assembles decoded chunks in deterministic plan order', async () => {
    // Root first (shallow), then the two depth-1 nodes by id. Markers prove order.
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 10, '1-0-0-0': 20, '1-1-0-0': 30 }),
      grade: (pos) => Array.from(pos),
      options: { maxPoints: 10_000 },
    });
    // each node contributed one [v,v,v] triple, in shallow→deep, id-sorted order
    // (the grade is `Array.from(pos)`, so it proves both order AND length).
    expect(out.grade).toEqual([10, 10, 10, 20, 20, 20, 30, 30, 30]);
  });

  it('assembles correctly when a node decodes MORE points than its header count (grow path)', async () => {
    // The buffer is pre-sized from the plan's per-node header counts; a node that
    // decodes extra points must grow the buffer, not truncate. Root header says
    // 100 pts but decodes 2 triples; the others decode 1 each — order preserved.
    const decode = async (id: string): Promise<Float32Array> =>
      id === '0-0-0-0' ? Float32Array.of(1, 1, 1, 9, 9, 9) : (async () => {
        const v = { '1-0-0-0': 2, '1-1-0-0': 3 }[id]!;
        return Float32Array.of(v, v, v);
      })();
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: decode,
      grade: (pos) => Array.from(pos),
      options: { maxPoints: 10_000 },
    });
    expect(out.grade).toEqual([1, 1, 1, 9, 9, 9, 2, 2, 2, 3, 3, 3]);
  });

  it('grades only the decoded span when nodes decode FEWER points than their header count', async () => {
    // header counts total 300, but each node decodes a single triple → the grade
    // must see exactly 9 floats, not a zero-padded 900-float buffer.
    const out = await runFullCloudGrade({
      nodes: nodes(),
      decodeNode: markerDecode({ '0-0-0-0': 5, '1-0-0-0': 6, '1-1-0-0': 7 }),
      grade: (pos) => pos.length,
      options: { maxPoints: 10_000 },
    });
    expect(out.grade).toBe(9);
  });

  it('EQUIVALENCE: the streamed-into-one-buffer grade equals grading a manual concat', async () => {
    // The memory optimisation (decode straight into a pre-sized buffer, release
    // each chunk) must not change the result. Build varied-size chunks, grade via
    // the runner with the REAL gradeSampleDensity, and compare field-for-field to
    // grading a hand-concatenated buffer of the same points in the same order.
    const big: SampleNode[] = [
      { id: '0-0-0-0', depth: 0, pointCount: 2, byteSize: 1 },
      { id: '1-0-0-0', depth: 1, pointCount: 3, byteSize: 1 },
      { id: '1-1-0-0', depth: 1, pointCount: 1, byteSize: 1 },
    ];
    // Deterministic, finite points; a couple of non-finite to exercise validity.
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
});
