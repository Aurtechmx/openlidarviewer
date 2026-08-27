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
 *
 * One thing it does NOT do is sum the records' point counts for a source that
 * states no total of its own. A format that names tiles without counting their
 * points (3D Tiles) leaves the reader stamping one assumed figure per record to
 * govern decode admission; adding those up here would print a total the file
 * never stated. `gradeFullCloud` refuses instead, which is the same call the
 * streaming source makes when it returns null from `sourcePointCount`.
 */

import type { StreamingNode } from './StreamingNode';
import type { NodeDecodeMetadata } from './StreamingSource';
import type { StreamingNodeRecord } from '../../io/copc/copcTypes';
import type { ChunkDecoder } from '../../io/copc/copcChunkDecode';
import { renderLocalPositions } from '../../model/pointFrames';
import type { SamplingPlanOptions, SampleNode } from './samplingPlan';
import {
  runFullCloudGrade,
  type DecodeNodeFn,
  type FullCloudGradeRun,
  type GradeFn,
  type GradeProgress,
} from './fullCloudGradeRunner';
import { UNSTATED_POINT_TOTAL, type UnstatedPointTotal } from './fullCloudGrade';

/**
 * The minimal slice of a {@link StreamingSource} the grade adapter reads — node
 * enumeration, id lookup, chunk read, and decode metadata. Declared structurally
 * (rather than importing the whole `StreamingSource`) so the unit tests can
 * satisfy it with a light fake, and a real `StreamingPointCloud` / EPT source
 * satisfies it without any cast.
 */
export interface GradeNodeSource {
  /**
   * What the SOURCE states as its point total, or null when the format does not
   * state one. Read for one decision only: whether the per-node `pointCount`
   * values this adapter projects are measurements or decode-admission
   * estimates. COPC reads its total from the LAS header and EPT from
   * `ept.json`, so their node counts sum to a stated figure; a 3D Tiles
   * tileset states neither, and `TilesetStreamingSource` returns null rather
   * than summing the assumed per-tile counts it stamped on its records.
   */
  readonly sourcePointCount: number | null;
  readonly octree: {
    /** Every known node in the octree. */
    nodes(): StreamingNode[];
    /** Lookup a runtime node by its deterministic id. */
    readonly store: { get(id: string): StreamingNode | undefined };
    /**
     * Whether the hierarchy loaded whole. Gates the grade's "exact" claim:
     * `nodes()` returns only the LOADED nodes, so a grade that sampled every one
     * of them is still not exhaustive over the file when this is false.
     */
    readonly isComplete: boolean;
    /** Hierarchy load errors — read so the dropped-region count reaches the grade note. */
    readonly errors: readonly string[];
  };
  readNodeChunk(record: StreamingNodeRecord, signal?: AbortSignal): Promise<ArrayBuffer>;
  decodeMeta(record: StreamingNodeRecord): NodeDecodeMetadata;
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
  decoder: ChunkDecoder<NodeDecodeMetadata>,
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
    const positions = renderLocalPositions(decoded);
    if (positions.length % 3 !== 0) {
      throw new Error(
        `Full-cloud grade: node ${id} decoded ${positions.length} position floats, not a multiple of 3.`,
      );
    }
    return positions;
  };
}

/**
 * What {@link gradeFullCloud} returns: either a grade, or the reason there
 * cannot be one. A union rather than a nullable run, so a caller that renders
 * the result has to decide what the refusal says instead of falling through to
 * a figure.
 */
export type FullCloudGradeOutcome<G> =
  | { readonly kind: 'graded'; readonly run: FullCloudGradeRun<G> }
  | ({ readonly kind: 'unavailable' } & UnstatedPointTotal);

/**
 * Whether this source's per-node counts are measurements. A source that states
 * no point total stamped its records with a decode-admission estimate, so every
 * figure the grade derives from them (the coverage label, the coverage percent,
 * the density back-scale) would be fabricated.
 *
 * Null only. Zero is a real answer meaning an empty source and grades normally.
 */
function statesPointTotal(source: GradeNodeSource): boolean {
  return source.sourcePointCount != null;
}

/**
 * The full live grade in one call: enumerate the source's octree, plan a
 * representative sample within budget, decode it through `decoder`, and grade
 * the assembled points with `grade` (the terrain pipeline at the call site).
 *
 * This is the single entry the "Grade full cloud" UI action invokes — it owns
 * the adapter glue (enumerate + decode) so the panel only has to supply the
 * source, a decoder, the grade, and an optional progress/abort. A graded
 * outcome carries the honest coverage label (`run.coverage.label`, e.g.
 * "1.8M of 18.2M points (10%, sampled)") to render next to the verdict.
 *
 * A source that states no point total is refused BEFORE any node is read: its
 * record counts are decode-admission estimates, and this function is where they
 * would otherwise be summed into a printed total. Refusing here rather than at
 * the panel keeps the decision with the one module that reads the source
 * contract, and spares a decode whose result could not be reported.
 */
export function gradeFullCloud<G>(args: {
  readonly source: GradeNodeSource;
  readonly decoder: ChunkDecoder<NodeDecodeMetadata>;
  readonly grade: GradeFn<G>;
  readonly options?: SamplingPlanOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GradeProgress) => void;
}): Promise<FullCloudGradeOutcome<G>> {
  const { source, decoder, grade, options, signal, onProgress } = args;
  if (!statesPointTotal(source)) {
    return Promise.resolve({ kind: 'unavailable', ...UNSTATED_POINT_TOTAL });
  }
  return runFullCloudGrade({
    nodes: sampleNodesFromSource(source),
    decodeNode: makeDecodeNode(source, decoder),
    grade,
    options,
    signal,
    onProgress,
    // The whole point of grading the FULL cloud is the completeness claim, so
    // carry the octree's own truth: `nodes()` above is only what loaded, and a
    // sample of it is "exact" over the file solely when the hierarchy is whole.
    // `errors.length` rides along so a partial grade can name how many regions
    // were dropped instead of leaving that count write-only.
    completeness: {
      complete: source.octree.isComplete,
      errorCount: source.octree.errors.length,
    },
  }).then((run) => ({ kind: 'graded', run }) as const);
}
