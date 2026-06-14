/**
 * wallGraph.ts
 *
 * Stage 3.8 of the floor-plan extraction pipeline: the WALL GRAPH — the
 * v0.4.6 hardening pass that turns the centerline skeleton (centerline.ts)
 * from a pixel soup into an explicit topological model {nodes, edges}:
 *
 *   NODES — skeleton JUNCTIONS (cells with ≥ 3 skeleton neighbours, clustered
 *   8-connectedly because Zhang-Suen junctions smear over 2–3 cells) and
 *   ENDPOINTS (free wall ends, 1 neighbour). A skeleton loop with neither
 *   (a closed room traced as one ring) gets a synthetic 'loop' node so every
 *   skeleton cell belongs to exactly one edge.
 *
 *   EDGES — the skeleton paths between nodes. Each edge carries
 *     - its STRAIGHTENED centerline polyline (Douglas-Peucker on the raw
 *       cell path via vectorize's simplifyChain, then an open-chain axis
 *       snap when the plan's dominant axes are known — node anchors stay
 *       FIXED so edges meeting at a junction keep meeting there);
 *     - its MEAN HALF-THICKNESS, measured by a chamfer distance transform of
 *       the wall mask the graph describes (one thickness per edge — a wall
 *       run has one thickness; per-cell wobble is raster noise);
 *     - its OBSERVED FRACTION against the raw pre-close mask (how much of
 *       the run is backed by actual returns vs morphological interpolation).
 *
 *   RE-EXTRUSION — the graph paints a fresh wall mask: each edge's polyline
 *   is rasterised at its own constant half-thickness, and every node paints
 *   a join disc at the largest incident thickness so corners CLOSE cleanly
 *   (an L or T meeting of two strips leaves no notch). Path points are
 *   MASS-RECENTRED (sub-cell) before painting — the integer skeleton of an
 *   even-width strip sits half a cell off the true medial axis — and the
 *   paint radius is (meanDist − 0.5) cells, which together reproduce the
 *   measured width exactly for both parities: the reconstruction neither
 *   fattens a wall beyond the evidence nor recedes its faces (the sheet's
 *   overall W × D must keep agreeing with the Space panel).
 *
 * WHY a graph instead of more mask passes: per-edge thickness, straight wall
 * lines, and clean corner joins are properties OF the wall network's
 * topology; the mask alone can't express "this run, that thickness". The
 * graph is also the substrate the room detector (roomDetect.ts) floods
 * against. HONESTY: nodes and edges come from the skeleton of traced
 * returns; the re-extrusion only redistributes measured wall mass along the
 * measured centerline — it invents no runs the scan never saw.
 *
 * Pure data, deterministic. No DOM.
 */

import type { OccupancyGrid } from './occupancyGrid';
import { chamferDistanceCells, MAX_WALL_HALF_M } from './centerline';
import { simplifyChain, SNAP_TOL_DEG } from './vectorize';

/** Edge polylines simplify at this many cells of DP tolerance — the same
 * order as the ring tracer's SIMPLIFY_CELLS, so graph walls and traced walls
 * straighten alike. */
export const EDGE_SIMPLIFY_CELLS = 1.25;

export type WallNodeKind = 'junction' | 'endpoint' | 'loop';

export interface WallGraphNode {
  readonly id: number;
  /** Anchor position (plan metres) — junction-cluster centroid / cell centre. */
  readonly x: number;
  readonly y: number;
  readonly kind: WallNodeKind;
  /** Skeleton cell indices forming the node (a junction smears over cells). */
  readonly cells: ReadonlyArray<number>;
}

export interface WallGraphEdge {
  /** Endpoint node ids ('a' may equal 'b': a loop or lollipop run). */
  readonly a: number;
  readonly b: number;
  /** Straightened centerline polyline, node anchor → node anchor, metres. */
  readonly path: ReadonlyArray<readonly [number, number]>;
  /** Centerline length of the straightened polyline, metres. */
  readonly lengthM: number;
  /** Mean half-thickness along the edge's skeleton cells, metres (capped at
   * {@link MAX_WALL_HALF_M} like every wall-thickness claim). */
  readonly halfThicknessM: number;
  /** Fraction of the edge's skeleton cells whose 3×3 neighbourhood is backed
   * by raw (pre-close) returns — 1 when no raw mask was supplied. */
  readonly observedFrac: number;
  /** The raw skeleton cell indices the edge was traced from. */
  readonly cells: ReadonlyArray<number>;
}

export interface WallGraph {
  readonly nodes: ReadonlyArray<WallGraphNode>;
  readonly edges: ReadonlyArray<WallGraphEdge>;
}

export interface WallGraphOptions {
  /** Dominant-axis direction for the open-chain snap; null/undefined = none. */
  readonly snapThetaRad?: number | null;
  /** Raw pre-close mask (same grid frame) for per-edge observed fractions. */
  readonly raw?: OccupancyGrid | null;
}

/** 8-neighbour skeleton-cell indices of cell i (bounds-checked). */
function skelNeighbours(mask: Uint8Array, cols: number, rows: number, i: number): number[] {
  const r = (i / cols) | 0;
  const c = i - r * cols;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= rows) continue;
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const cc = c + dc;
      if (cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (mask[j]) out.push(j);
    }
  }
  return out;
}

/**
 * Open-chain axis snap (the chain twin of vectorize's snapRingToAxes):
 * rotate into the axis frame, classify each segment horizontal / vertical /
 * other within `tolDeg`, pin h-segment vertices to a shared y and v-segment
 * vertices to a shared x, rotate back. The chain ENDPOINTS never move — they
 * are node anchors shared with other edges, and dragging them would open
 * gaps at junctions — so end segments adopt the END VERTEX's coordinate as
 * their line instead of the segment mean. A single-segment chain is left
 * untouched (both ends are anchors; there is nothing free to snap).
 */
export function snapChainToAxes(
  chain: ReadonlyArray<readonly [number, number]>,
  thetaRad: number,
  tolDeg = SNAP_TOL_DEG,
  fixStart = true,
  fixEnd = true,
): Array<readonly [number, number]> {
  const n = chain.length;
  if (n < 2 || (n < 3 && fixStart && fixEnd)) return chain.slice();
  const cosT = Math.cos(-thetaRad), sinT = Math.sin(-thetaRad);
  const pts: Array<[number, number]> = chain.map(([x, y]) => [
    x * cosT - y * sinT,
    x * sinT + y * cosT,
  ]);
  const tol = (tolDeg * Math.PI) / 180;
  const nSeg = n - 1;
  const cls = new Array<'h' | 'v' | 'o'>(nSeg);
  const target = new Float64Array(nSeg);
  for (let i = 0; i < nSeg; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    let ang = Math.atan2(y2 - y1, x2 - x1);
    if (ang < 0) ang += Math.PI;
    if (ang >= Math.PI) ang -= Math.PI;
    const dH = Math.min(ang, Math.PI - ang);
    const dV = Math.abs(ang - Math.PI / 2);
    if (dH <= tol) {
      cls[i] = 'h';
      // End segments next to a FIXED anchor take that vertex's coordinate as
      // their line (the anchor cannot move); free ends and interior segments
      // settle on the segment mean.
      target[i] =
        i === 0 && fixStart ? y1 : i === nSeg - 1 && fixEnd ? y2 : (y1 + y2) / 2;
    } else if (dV <= tol) {
      cls[i] = 'v';
      target[i] =
        i === 0 && fixStart ? x1 : i === nSeg - 1 && fixEnd ? x2 : (x1 + x2) / 2;
    } else {
      cls[i] = 'o';
      target[i] = 0;
    }
  }
  const cosB = Math.cos(thetaRad), sinB = Math.sin(thetaRad);
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i < n; i++) {
    let [x, y] = pts[i];
    // A FIXED end never moves; a FREE end follows its only segment's line
    // (that's the whole point — a tilted jamb stub straightens onto the run).
    const movable =
      (i > 0 && i < n - 1) || (i === 0 && !fixStart) || (i === n - 1 && !fixEnd);
    if (movable) {
      // x pinned by adjacent v-segments, y by h-segments (both adjacent →
      // average, like the ring snapper's corner rule). Ends have one side.
      const p = i - 1, s = i;
      const hasP = i > 0, hasS = i < n - 1;
      if (hasP && hasS && cls[p] === 'v' && cls[s] === 'v') x = (target[p] + target[s]) / 2;
      else if (hasP && cls[p] === 'v') x = target[p];
      else if (hasS && cls[s] === 'v') x = target[s];
      if (hasP && hasS && cls[p] === 'h' && cls[s] === 'h') y = (target[p] + target[s]) / 2;
      else if (hasP && cls[p] === 'h') y = target[p];
      else if (hasS && cls[s] === 'h') y = target[s];
    }
    out.push([x * cosB - y * sinB, x * sinB + y * cosB]);
  }
  // Drop interior vertices the snap made (near-)duplicate.
  const dedup: Array<readonly [number, number]> = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const last = dedup[dedup.length - 1];
    const isLast = i === out.length - 1;
    if (isLast || Math.hypot(out[i][0] - last[0], out[i][1] - last[1]) > 1e-9) dedup.push(out[i]);
  }
  return dedup;
}

/**
 * Build the wall graph from the (normalised) wall mask and its pruned
 * skeleton. The thickness transform is computed HERE, on the mask the graph
 * describes — not reused from the pre-normalisation chamfer — so an
 * echo-collapsed wall reports its collapsed thickness, not the echo's.
 */
export function buildWallGraph(
  grid: OccupancyGrid,
  skeleton: Uint8Array,
  opts: WallGraphOptions = {},
): WallGraph {
  const { cols, rows, cellX, cellY, originX, originY } = grid;
  const cellM = Math.max(cellX, cellY);
  const n = cols * rows;
  const dist = chamferDistanceCells(grid.mask, cols, rows);

  // ── Degrees ──
  const deg = new Int8Array(n);
  for (let i = 0; i < n; i++) if (skeleton[i]) deg[i] = skelNeighbours(skeleton, cols, rows, i).length;

  const world = (i: number): [number, number] => {
    const r = (i / cols) | 0;
    const c = i - r * cols;
    return [originX + (c + 0.5) * cellX, originY + (r + 0.5) * cellY];
  };

  // ── Nodes: junction clusters (≥3 neighbours, 8-connected) + endpoints ──
  const nodeOf = new Int32Array(n).fill(-1);
  const nodes: WallGraphNode[] = [];
  const addNode = (cells: number[], kind: WallNodeKind): WallGraphNode => {
    let sx = 0, sy = 0;
    for (const c of cells) {
      const [x, y] = world(c);
      sx += x;
      sy += y;
      nodeOf[c] = nodes.length;
    }
    const node: WallGraphNode = {
      id: nodes.length,
      x: sx / cells.length,
      y: sy / cells.length,
      kind,
      cells,
    };
    nodes.push(node);
    return node;
  };
  {
    const stack: number[] = [];
    for (let start = 0; start < n; start++) {
      if (!skeleton[start] || deg[start] < 3 || nodeOf[start] >= 0) continue;
      const cluster: number[] = [];
      nodeOf[start] = -2; // provisional mark so the DFS terminates
      stack.push(start);
      while (stack.length > 0) {
        const i = stack.pop() as number;
        cluster.push(i);
        for (const j of skelNeighbours(skeleton, cols, rows, i)) {
          if (deg[j] >= 3 && nodeOf[j] === -1) { nodeOf[j] = -2; stack.push(j); }
        }
      }
      addNode(cluster, 'junction');
    }
    for (let i = 0; i < n; i++) {
      if (skeleton[i] && deg[i] === 1 && nodeOf[i] === -1) addNode([i], 'endpoint');
    }
  }

  // ── Edges: walk corridors (degree-2 chains) between node cells ──
  const visited = new Uint8Array(n); // corridor cells consumed by a walk
  interface RawEdge { a: number; b: number; cells: number[] }
  const rawEdges: RawEdge[] = [];
  const directSeen = new Set<number>(); // node-cell↔node-cell adjacency dedupe
  for (const node of nodes) {
    for (const s of node.cells) {
      for (const j of skelNeighbours(skeleton, cols, rows, s)) {
        if (nodeOf[j] >= 0) {
          // Direct node–node adjacency (within one cluster is not an edge).
          if (nodeOf[j] === node.id) continue;
          const key = Math.min(s, j) * n + Math.max(s, j);
          if (directSeen.has(key)) continue;
          directSeen.add(key);
          rawEdges.push({ a: node.id, b: nodeOf[j], cells: [s, j] });
          continue;
        }
        if (visited[j]) continue;
        // Corridor walk: follow degree-≤2 cells until the next node cell.
        const cells: number[] = [s];
        let prev = s;
        let cur = j;
        let terminal = -1;
        for (let steps = 0; steps < n; steps++) {
          visited[cur] = 1;
          cells.push(cur);
          const nb = skelNeighbours(skeleton, cols, rows, cur).filter((k) => k !== prev);
          // Prefer terminating on a node cell (a corridor can graze two).
          const nodeNb = nb.find((k) => nodeOf[k] >= 0);
          if (nodeNb !== undefined) {
            terminal = nodeOf[nodeNb];
            cells.push(nodeNb);
            break;
          }
          const next = nb.find((k) => !visited[k]);
          if (next === undefined) break; // dead end (shouldn't happen: ends are nodes)
          prev = cur;
          cur = next;
        }
        if (terminal >= 0) rawEdges.push({ a: node.id, b: terminal, cells });
      }
    }
  }

  // ── Pure loops: skeleton cycles that touched no node (a closed wall ring
  //    with no junction or free end) get a synthetic anchor node. ──
  for (let start = 0; start < n; start++) {
    if (!skeleton[start] || visited[start] || nodeOf[start] >= 0 || deg[start] !== 2) continue;
    const anchor = addNode([start], 'loop');
    const cells: number[] = [start];
    visited[start] = 1;
    let prev = start;
    let cur = skelNeighbours(skeleton, cols, rows, start)[0];
    for (let steps = 0; steps < n && cur !== undefined && cur !== start; steps++) {
      visited[cur] = 1;
      cells.push(cur);
      const nb = skelNeighbours(skeleton, cols, rows, cur).filter((k) => k !== prev && !visited[k]);
      prev = cur;
      cur = nb[0] ?? skelNeighbours(skeleton, cols, rows, prev).find((k) => k === start) ?? -1;
      if (cur === -1) break;
    }
    cells.push(start); // close the loop on its anchor
    rawEdges.push({ a: anchor.id, b: anchor.id, cells });
  }

  // ── Per-edge attributes + straightening ──
  const raw = opts.raw && opts.raw.cols === cols && opts.raw.rows === rows ? opts.raw : null;
  const observedAt = (i: number): boolean => {
    if (!raw) return true;
    const r = (i / cols) | 0;
    const c = i - r * cols;
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= cols) continue;
        if (raw.mask[rr * cols + cc]) return true;
      }
    }
    return false;
  };

  /**
   * Sub-cell recentring of a skeleton path point: the integer skeleton of an
   * EVEN-width strip must sit on one of the two middle rows (half a cell off
   * the true medial axis), so a naive re-extrusion recedes one wall face by a
   * full cell — and the sheet's overall W × D would drift from the Space
   * panel's. The fix: shift each path point along the LOCAL PERPENDICULAR to
   * the wall-mass centroid (sampled from the mask within the measured
   * half-thickness), restoring the lost half cell. Shift capped at ±1 cell —
   * this recovers quantisation, it never relocates a wall. The per-cell
   * offsets are SMOOTHED along the path (±2-cell box) before applying:
   * sampling near a jamb or junction sees asymmetric mass and would tilt the
   * end of an otherwise straight run; the parity shift this pass exists for
   * is constant along the run, so averaging keeps it and drops the noise.
   */
  const recentreOffset = (
    cellIdx: number,
    tx: number,
    ty: number,
    reachCells: number,
  ): { pxn: number; pyn: number; off: number } => {
    const tl = Math.hypot(tx, ty);
    if (!(tl > 0)) return { pxn: 0, pyn: 0, off: 0 };
    const pxn = -ty / tl, pyn = tx / tl; // unit perpendicular
    const r0 = (cellIdx / cols) | 0;
    const c0 = cellIdx - r0 * cols;
    const K = Math.max(1, Math.ceil(reachCells) + 1);
    let sumT = 0, sumW = 0;
    for (let t = -K; t <= K; t++) {
      const cc = c0 + Math.round(pxn * t);
      const rr = r0 + Math.round(pyn * t);
      if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
      if (grid.mask[rr * cols + cc]) { sumT += t; sumW++; }
    }
    if (sumW === 0) return { pxn, pyn, off: 0 };
    return { pxn, pyn, off: Math.max(-1, Math.min(1, sumT / sumW)) };
  };

  const theta = opts.snapThetaRad ?? null;
  const edges: WallGraphEdge[] = [];
  for (const e of rawEdges) {
    if (e.cells.length < 2) continue;
    let distSum = 0;
    let observed = 0;
    for (const c of e.cells) {
      distSum += dist[c];
      if (observedAt(c)) observed++;
    }
    const meanDist = distSum / e.cells.length;
    const halfThicknessM = Math.min(Math.max(0.5, meanDist) * cellM, MAX_WALL_HALF_M);
    // Polyline: mass-recentred cell centres (see recentreOffset), with the
    // offsets box-smoothed (±2) along the path. Tangents from ±1 neighbours.
    const offs = e.cells.map((c, k) => {
      const prev = e.cells[Math.max(0, k - 1)];
      const next = e.cells[Math.min(e.cells.length - 1, k + 1)];
      const [pxw, pyw] = world(prev);
      const [nxw, nyw] = world(next);
      return recentreOffset(c, nxw - pxw, nyw - pyw, meanDist);
    });
    let pts: Array<readonly [number, number]> = e.cells.map((c, k) => {
      const [wx, wy] = world(c);
      let sum = 0, cnt = 0;
      for (let w = Math.max(0, k - 2); w <= Math.min(offs.length - 1, k + 2); w++) {
        sum += offs[w].off;
        cnt++;
      }
      const off = cnt > 0 ? sum / cnt : 0;
      return [wx + offs[k].pxn * off * cellX, wy + offs[k].pyn * off * cellY];
    });
    // NOTE on junction joins: the path STARTS on a node cell (e.cells[0] is
    // a cluster member), so edges of one junction already begin within a
    // cell of each other, and extrusion paints a join disc at the node — the
    // joint closes in the RASTER. The vector ends are therefore left FREE
    // for the axis snap (fixing them to the cluster centroid was measured to
    // drag whole runs half a cell off their wall — the centroid of an L
    // cluster sits off both centerlines).
    pts = simplifyChain(pts, EDGE_SIMPLIFY_CELLS * cellM);
    if (theta != null) {
      pts = snapChainToAxes(pts, theta, SNAP_TOL_DEG, false, false);
    }
    let lengthM = 0;
    for (let i = 1; i < pts.length; i++) {
      lengthM += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    edges.push({
      a: e.a,
      b: e.b,
      path: pts,
      lengthM,
      halfThicknessM,
      observedFrac: e.cells.length > 0 ? observed / e.cells.length : 1,
      cells: e.cells,
    });
  }

  return { nodes, edges };
}

/**
 * Re-extrude a wall mask FROM the graph: each edge paints its straightened
 * centerline at its own constant half-thickness, each node paints a join
 * disc at the largest incident edge thickness (clean corner closure at L /
 * T / + junctions — no notches where strips meet at an angle).
 *
 * The paint radius is (meanDist − 0.5) cells against CELL CENTRES. A strip T
 * cells thick reads meanDist = (T+1)/2 (odd T, skeleton on the middle row)
 * or T/2 (even T, mass-recentred onto the row boundary), and in BOTH cases
 * the farthest covered cell centre lies exactly (meanDist − 0.5) from the
 * recentred centerline — painted width = T. The reconstruction reproduces
 * the measured thickness, never fattens it.
 */
export function extrudeWallGraph(graph: WallGraph, grid: OccupancyGrid): OccupancyGrid {
  const { cols, rows, cellX, cellY, originX, originY } = grid;
  const cellM = Math.max(cellX, cellY);
  const mask = new Uint8Array(cols * rows);

  /** Paint all cells whose CENTRE is within rCells of segment a–b (cell frame). */
  const paintSegment = (
    ax: number, ay: number, bx: number, by: number, rCells: number,
  ): void => {
    // Work in continuous cell coordinates (cell centre i = i + 0.5).
    const ac = (ax - originX) / cellX - 0.5, ar = (ay - originY) / cellY - 0.5;
    const bc = (bx - originX) / cellX - 0.5, br = (by - originY) / cellY - 0.5;
    const pad = Math.ceil(rCells) + 1;
    const c0 = Math.max(0, Math.floor(Math.min(ac, bc)) - pad);
    const c1 = Math.min(cols - 1, Math.ceil(Math.max(ac, bc)) + pad);
    const r0 = Math.max(0, Math.floor(Math.min(ar, br)) - pad);
    const r1 = Math.min(rows - 1, Math.ceil(Math.max(ar, br)) + pad);
    const dx = bc - ac, dy = br - ar;
    const len2 = dx * dx + dy * dy;
    const r2 = rCells * rCells + 1e-9;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let t = len2 > 0 ? ((c - ac) * dx + (r - ar) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = ac + t * dx - c, py = ar + t * dy - r;
        if (px * px + py * py <= r2) mask[r * cols + c] = 1;
      }
    }
  };

  // Per-node join radius = the largest incident edge half-paint radius.
  const nodeR = new Float64Array(graph.nodes.length);
  for (const e of graph.edges) {
    // halfThicknessM = meanDist·cellM ⇒ paint radius (meanDist − 0.5) cells
    // reproduces width 2·meanDist − 1 (see the function doc). Floor at 0.49
    // so even a 1-cell wall paints its own centreline row.
    const rCells = Math.max(0.49, e.halfThicknessM / cellM - 0.5);
    // Join discs get +0.5 cell: edges of one junction start on cluster cells
    // up to a cell apart (and the cluster centroid sits between cell
    // centres), so the disc must out-reach the edge radius to bridge them.
    if (rCells + 0.5 > nodeR[e.a]) nodeR[e.a] = rCells + 0.5;
    if (rCells + 0.5 > nodeR[e.b]) nodeR[e.b] = rCells + 0.5;
    for (let i = 1; i < e.path.length; i++) {
      paintSegment(e.path[i - 1][0], e.path[i - 1][1], e.path[i][0], e.path[i][1], rCells);
    }
  }
  for (const node of graph.nodes) {
    // ENDPOINT nodes get no disc: there is nothing to join at a free wall
    // end, and a disc there would creep into the door gap the end flanks.
    if (node.kind === 'endpoint') continue;
    if (nodeR[node.id] > 0) paintSegment(node.x, node.y, node.x, node.y, nodeR[node.id]);
  }

  return { ...grid, mask };
}
