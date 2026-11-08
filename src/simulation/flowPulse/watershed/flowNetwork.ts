/**
 * flowNetwork.ts — where flow concentrates into lines, and their Strahler order.
 *
 * A cell is on the network when the area draining through it reaches a
 * threshold. The threshold is a drawing choice, not a measurement of where
 * water runs: it says "show the lines that drain at least this much", and the
 * network it gives is as fine or coarse as that number.
 *
 * The network is cut into segments. A segment starts at a head (an on-network
 * cell with no on-network donor) or at a confluence (a cell with two or more
 * on-network donors), and runs down the D8 receivers until the next cell is a
 * confluence or leaves the network. The step into a confluence belongs to the
 * segment that makes it, so the segment lengths add up to the whole network.
 * A step is `sqrt((dx·cellMetresX)² + (dy·cellMetresY)²)`, never a multiple of
 * one cell size, because the two axes can differ in metres.
 *
 * Strahler order (1957): heads are order 1. A segment whose upstream end has
 * two or more incoming segments of the highest order k is order k + 1;
 * otherwise it takes the highest incoming order. Order is worked out downstream
 * in dependency order, so a segment is settled only after every segment that
 * feeds it.
 *
 * Pure: no DOM. Reads the routed grid; changes nothing.
 */

import type { FlowGrid } from '../flowTypes';
import type { D8Result } from '../d8Flow';

/** Smallest contributing area, in m², that puts a cell on the network. */
export const DEFAULT_NETWORK_THRESHOLD_M2 = 2500;

export interface NetworkSegment {
  readonly id: number;
  /** Cell indices, upstream to downstream. */
  readonly cells: Int32Array;
  /** Strahler order. */
  readonly order: number;
  /** Sum of the D8 step lengths, in metres. */
  readonly lengthM: number;
  /** Id of the segment this one flows into, or -1. */
  readonly downstream: number;
}

export interface FlowNetwork {
  readonly thresholdM2: number;
  /** Per cell: 1 when the cell is on the network. */
  readonly onNetwork: Uint8Array;
  /** Ordered by the index of each segment's first cell. */
  readonly segments: readonly NetworkSegment[];
  /**
   * Per cell: length in metres of the step from this cell to its receiver, 0
   * where the cell has no on-network receiver. Lets {@link networkWithin}
   * measure a clipped network exactly.
   */
  readonly stepM: Float64Array;
}

export function buildFlowNetwork(
  grid: FlowGrid,
  routed: D8Result,
  areaM2: Float64Array,
  thresholdM2: number = DEFAULT_NETWORK_THRESHOLD_M2,
): FlowNetwork {
  const { cols, rows, cellMetresX, cellMetresY, valid } = grid;
  const n = cols * rows;
  const { receiver } = routed;

  const onNetwork = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (valid[i] === 1 && areaM2[i] >= thresholdM2) onNetwork[i] = 1;
  }

  // The receiver a network cell passes flow to along the network, or -1.
  const next = new Int32Array(n).fill(-1);
  const donors = new Uint16Array(n);
  const stepM = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (onNetwork[i] === 0) continue;
    const r = receiver[i];
    if (r < 0 || onNetwork[r] === 0) continue;
    next[i] = r;
    donors[r]++;
    const dCol = (r % cols) - (i % cols);
    const dRow = Math.floor(r / cols) - Math.floor(i / cols);
    stepM[i] = Math.hypot(dCol * cellMetresX, dRow * cellMetresY);
  }

  // Segments start at heads and confluences; a cell with one donor continues its donor's segment.
  const segmentOfHead = new Int32Array(n).fill(-1);
  const cellLists: number[][] = [];
  const lengths: number[] = [];
  for (let head = 0; head < n; head++) {
    if (onNetwork[head] === 0 || donors[head] === 1) continue;
    const cells: number[] = [];
    let length = 0;
    let cell = head;
    for (;;) {
      cells.push(cell);
      length += stepM[cell];
      const r = next[cell];
      if (r < 0 || donors[r] !== 1) break;
      cell = r;
    }
    segmentOfHead[head] = cellLists.length;
    cellLists.push(cells);
    lengths.push(length);
  }

  const count = cellLists.length;
  const downstream = new Int32Array(count).fill(-1);
  const incoming = new Int32Array(count);
  for (let s = 0; s < count; s++) {
    const cells = cellLists[s];
    const r = next[cells[cells.length - 1]];
    if (r >= 0) {
      downstream[s] = segmentOfHead[r];
      incoming[downstream[s]]++;
    }
  }

  // Strahler order, settling each segment once every segment feeding it is done.
  const order = new Int32Array(count);
  const maxIn = new Int32Array(count);
  const maxInCount = new Int32Array(count);
  const waiting = Int32Array.from(incoming);
  const ready: number[] = [];
  for (let s = 0; s < count; s++) if (waiting[s] === 0) ready.push(s);
  while (ready.length > 0) {
    const s = ready.pop()!;
    order[s] = maxIn[s] === 0 ? 1 : maxInCount[s] >= 2 ? maxIn[s] + 1 : maxIn[s];
    const d = downstream[s];
    if (d < 0) continue;
    if (order[s] > maxIn[d]) { maxIn[d] = order[s]; maxInCount[d] = 1; }
    else if (order[s] === maxIn[d]) maxInCount[d]++;
    if (--waiting[d] === 0) ready.push(d);
  }

  const segments: NetworkSegment[] = [];
  for (let s = 0; s < count; s++) {
    segments.push({
      id: s,
      cells: Int32Array.from(cellLists[s]),
      order: order[s],
      lengthM: lengths[s],
      downstream: downstream[s],
    });
  }
  return { thresholdM2, onNetwork, segments, stepM };
}

export interface NetworkWithin {
  readonly lengthM: number;
  /** Highest Strahler order among the segments that touch the mask; 0 when none do. */
  readonly maxOrder: number;
  readonly byOrder: ReadonlyMap<number, { segments: number; lengthM: number }>;
}

/**
 * The network inside a mask (a watershed, say). Each cell inside the mask
 * contributes the step it takes to its receiver, so a segment cut by the mask
 * edge is measured as far as it runs inside. A segment counts once for the
 * order it carries if at least one of its cells is inside.
 */
export function networkWithin(net: FlowNetwork, mask: Uint8Array): NetworkWithin {
  const byOrder = new Map<number, { segments: number; lengthM: number }>();
  let lengthM = 0;
  let maxOrder = 0;
  for (const seg of net.segments) {
    let inside = 0;
    let length = 0;
    for (let k = 0; k < seg.cells.length; k++) {
      const cell = seg.cells[k];
      if (mask[cell] === 0) continue;
      inside++;
      length += net.stepM[cell];
    }
    if (inside === 0) continue;
    const entry = byOrder.get(seg.order) ?? { segments: 0, lengthM: 0 };
    entry.segments++;
    entry.lengthM += length;
    byOrder.set(seg.order, entry);
    lengthM += length;
    if (seg.order > maxOrder) maxOrder = seg.order;
  }
  return { lengthM, maxOrder, byOrder };
}
