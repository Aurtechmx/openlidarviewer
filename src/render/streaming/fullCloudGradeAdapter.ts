/**
 * fullCloudGradeAdapter.ts
 *
 * The live wiring the {@link runFullCloudGrade} seam asks for — and deliberately
 * does NOT import — turned into something concrete. {@link runFullCloudGrade}
 * takes an injected `decodeNode` (range read + worker decompress) and a list of
 * {@link SampleNode}; this module derives both from a live {@link StreamingSource}
 * (COPC or EPT) so it can grade the WHOLE cloud, not just the
 * view-driven nodes that happen to be resident.
 *
 * Why this is a thin adapter, not new machinery: a streaming source already
 * knows how to (a) enumerate every octree node (`octree.nodes()`), (b) range-read
 * one node's compressed chunk (`readNodeChunk`), and (c) describe how that chunk
 * decodes (`decodeMeta`). The only piece the render path drives differently is
 * WHICH nodes — the scheduler picks them by view priority, the grade picks them
 * by the breadth-first sampling plan. So all this module does is:
 *   1. project the octree's records into the planner's `SampleNode` shape, and
 *   2. close a `DecodeNodeFn` over the source + a `ChunkDecoder` that resolves a
 *      node id → its decoded local-space positions.
 *
 * Everything format-specific (COPC chunk records vs. EPT tile URLs) is already
 * behind the `StreamingSource` interface, so one adapter serves both formats.
 */

import type { StreamingNode } from './StreamingNode';
import type { StreamingNodeRecord } from '../../io/copc/copcTypes';
import type { ChunkDecodeMetadata, ChunkDecoder } from '../../io/copc/copcChunkDecode';
import type { SamplingPlanOptions, SampleNode } from './samplingPlan';
import {
  runFullCloudGrade,
  type DecodeNodeFn,
  type FullCloudGradeRun,
  type GradeFn,
  type GradeProgress,
} from './fullCloudGradeRunner';

/**
 * The minimal slice of a {@link StreamingSource} the grade adapter reads — node
 * enumeration, id lookup, chunk read, and decode metadata. Declared structurally
 * (rather than importing the whole `StreamingSource`) so the unit tests can
 * satisfy it with a light fake, and a real `StreamingPointCloud` / EPT source
 * satisfies it without any cast.
 */
export interface GradeNodeSource {
  readonly octree: {
    /** Every known node in the octree. */
    nodes(): StreamingNode[];
    /** Lookup a runtime node by its deterministic id. */
    readonly store: { get(id: string): StreamingNode | undefined };
  };
  readNodeChunk(record: StreamingNodeRecord, signal?: AbortSignal): Promise<ArrayBuffer>;
  decodeMeta(record: StreamingNodeRecord): ChunkDecodeMetadata;
}

/**
 * Project a streaming source's octree into the {@link SampleNode}[] the sampling
 * planner consumes. A pure read of the (already loaded) hierarchy — no I/O — so
 * it is cheap to call before deciding whether a full grade is even worth
 * offering. Order follows `octree.nodes()`; the planner re-sorts breadth-first.
 */
export function sampleNodesFromSource(source: GradeNodeSource): SampleNode[] {
  return source.octree.nodes().map((node) => ({
    id: node.record.id,
    depth: node.record.key.depth,
    pointCount: node.record.pointCount,
    byteSize: node.record.byteSize,
  }));
}

/**
 * Build the live {@link DecodeNodeFn} the runner injects: resolve a planned node
 * id to its decoded local-space XYZ triples by range-reading the compressed
 * chunk and handing it to `decoder` with the source's decode metadata.
 *
 * The returned function is cooperative on `signal` at both the range-read and
 * the decode (the COPC worker honours it). A node id absent from the store
 * yields an empty buffer rather than throwing, so a hierarchy that changed
 * under a long grade degrades to slightly-lower coverage instead of aborting —
 * the planner's ids always come from the same `sampleNodesFromSource` snapshot,
 * so in practice this is a guard, not a path.
 *
 * Note: `decoder.decode` TRANSFERS the chunk buffer to the worker; the buffer is
 * freshly read per node and never reused, so the transfer is safe.
 */
export function makeDecodeNode(
  source: GradeNodeSource,
  decoder: ChunkDecoder,
): DecodeNodeFn {
  return async (id: string, signal?: AbortSignal): Promise<Float32Array> => {
    const node = source.octree.store.get(id);
    if (!node) return new Float32Array(0);
    // Always a FRESH range read of the planned node — deliberately NOT the
    // render path's resident/cache buffers. The grade samples the breadth-first
    // PLAN (shallow nodes for even coverage), which is a different set than the
    // view-driven resident nodes; reusing the render cache here would both
    // sample the wrong nodes and risk transferring a buffer the renderer still
    // needs. The re-fetch of any node that happens to also be resident is the
    // intended cost, bounded by the sampling budget.
    const chunk = await source.readNodeChunk(node.record, signal);
    const decoded = await decoder.decode(chunk, source.decodeMeta(node.record), signal);
    // Invariant: positions are XYZ triples. The runner's `decodedPoints`
    // accounting and the grade both assume `length % 3 === 0`; a decoder that
    // ever broke this would silently skew density, so fail loud instead.
    if (decoded.positions.length % 3 !== 0) {
      throw new Error(
        `Full-cloud grade: node ${id} decoded ${decoded.positions.length} position floats, not a multiple of 3.`,
      );
    }
    return decoded.positions;
  };
}

/**
 * The full live grade in one call: enumerate the source's octree, plan a
 * representative sample within budget, decode it through `decoder`, and grade
 * the assembled points with `grade` (the terrain pipeline at the call site).
 *
 * This is the single entry the "Grade full cloud" UI action invokes — it owns
 * the adapter glue (enumerate + decode) so the panel only has to supply the
 * source, a decoder, the grade, and an optional progress/abort. The returned
 * {@link FullCloudGradeRun} carries the honest coverage label
 * (`run.coverage.label`, e.g. "1.8M of 18.2M points (10%, sampled)") to render
 * next to the verdict.
 */
export function gradeFullCloud<G>(args: {
  readonly source: GradeNodeSource;
  readonly decoder: ChunkDecoder;
  readonly grade: GradeFn<G>;
  readonly options?: SamplingPlanOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GradeProgress) => void;
}): Promise<FullCloudGradeRun<G>> {
  const { source, decoder, grade, options, signal, onProgress } = args;
  return runFullCloudGrade({
    nodes: sampleNodesFromSource(source),
    decodeNode: makeDecodeNode(source, decoder),
    grade,
    options,
    signal,
    onProgress,
  });
}
