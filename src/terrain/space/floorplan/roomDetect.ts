/**
 * roomDetect.ts
 *
 * Stage 3.9 of the floor-plan extraction pipeline: ROOM SEGMENTATION on the
 * wall-graph-reconstructed wall mask (wallGraph.ts).
 *
 * METHOD — flood fill, not planar faces of the graph. Real scans are GAPPY:
 * a planar-face decomposition needs a closed embedding (every face bounded
 * by explicit half-edges), and a single unscanned wall run leaves a face
 * unbounded — the whole decomposition collapses. Flood fill degrades
 * gracefully instead: the free space is flooded against the wall mask plus
 * CLOSED DOORWAY SPANS (each classified door's jamb-to-jamb segment is
 * painted as a temporary barrier — a door separates the rooms it connects),
 * the component touching the grid border is the exterior, and every other
 * component is a candidate room.
 *
 * HONESTY RULES, by construction:
 *   - door-separated rooms stay DISTINCT (door spans are barriers — region
 *     merging through classified doorways stays OFF);
 *   - 'unknown' gaps are NOT closed: an open-plan space whose dividing run
 *     was never scanned floods into ONE region — claiming two rooms there
 *     would fabricate the very wall the scan failed to see;
 *   - a room leaking to the exterior through an unscanned boundary run is
 *     NOT claimed as a room at all (it floods into the border component) —
 *     no synthetic enclosure.
 *
 * Per room: the region's outer boundary polygon (traced + simplified with
 * the existing vectorize machinery), its area measured by CELL COUNT of the
 * region mask (robust against polygon simplification), and a label anchor at
 * the region's pole of inaccessibility (the chamfer-distance maximum) so the
 * "Room N · area" label sits inside even an L-shaped room.
 *
 * Pure data, deterministic. No DOM.
 */

import type { OccupancyGrid } from './occupancyGrid';
import { chamferDistanceCells, type PlanGap } from './centerline';
import { traceMaskBoundaries, simplifyRing, ringSignedArea, type Ring } from './vectorize';

/**
 * Minimum honest room area, m². WHY raised from the old 1.0 m²: on a real
 * open industrial interior the ~96 m² floor LEAKS to the exterior boundary
 * (an unscanned boundary run, or the open plan genuinely reaching the grid
 * edge) and is classified exterior, so the only "rooms" the flood finds are
 * the tiny sealed pockets BETWEEN wall fragments — 1–3 m² flood pockets.
 * Labelling a 1.0 m² pocket "Room 5" makes the sheet look broken. A real
 * habitable room (even a small WC / utility cupboard) is ~4 m²+; anything
 * smaller is a wall-fragment sliver or a furniture-island pocket, not a room.
 * Sub-threshold pockets are DROPPED (not numbered), never demoted to a label.
 */
export const ROOM_MIN_AREA_M2 = 4.0;
/**
 * "Could not segment" guard. WHY: even after the min-area floor, a leaking
 * open plan can still surface a couple of mid-size pockets that together
 * cover only a sliver of the real floor. If the kept rooms cover less than
 * this fraction of the scanned floor area, the segmentation did NOT capture
 * the building — printing "2 rooms · 9 m²" on a 96 m² floor is a fabricated
 * room schedule. Below this fraction we report the honest outcome
 * ('open-space' or 'unsegmented') instead of a fake room list.
 */
export const ROOM_COVERAGE_MIN_FRAC = 0.35;
/**
 * Open-space detection: when segmentation is judged unreliable (coverage
 * below {@link ROOM_COVERAGE_MIN_FRAC}) BUT a single dominant interior region
 * covers at least this fraction of the floor, the floor is essentially ONE
 * connected space — present it honestly as "Open space · ~N m²" rather than
 * "could not segment". Below this, no single region dominates either, so the
 * honest outcome is 'unsegmented' (rooms could not be reliably separated).
 */
export const OPEN_SPACE_MIN_FRAC = 0.55;
/** At most this many rooms are reported (largest first) — a noisy mask can
 * fragment into dozens of pockets; a sheet with 24+ labels is unreadable. */
export const MAX_ROOMS = 16;
/** Doorway barrier half-width, cells — wide enough that the 4-connected
 * flood can never slip diagonally past a painted span. */
const DOOR_BARRIER_R_CELLS = 1.1;
/** Room polygons simplify at the same tolerance as wall rings. */
const ROOM_SIMPLIFY_CELLS = 1.25;

export interface RoomRegion {
  /** Outer boundary polygon of the room region, plan metres (CCW). */
  readonly ring: Ring;
  /** Room area from the region's CELL COUNT (not the simplified polygon). */
  readonly areaM2: number;
  /** Label anchor: the region's pole of inaccessibility, plan metres. */
  readonly label: readonly [number, number];
  /** Region size in cells (diagnostics / tests). */
  readonly cellCount: number;
}

/**
 * Honest segmentation outcome (consumed by the sheet / panel so they never
 * print a fake room schedule):
 *   - 'rooms'       — the kept rooms cover enough of the floor to be a real
 *                     room schedule (≥ {@link ROOM_COVERAGE_MIN_FRAC});
 *   - 'open-space'  — segmentation unreliable, but ONE dominant region covers
 *                     most of the floor: present as "Open space · ~N m²";
 *   - 'unsegmented' — segmentation unreliable and no region dominates: rooms
 *                     could not be reliably separated from the wall returns.
 */
export type RoomSegmentation = 'rooms' | 'open-space' | 'unsegmented';

export interface RoomDetection {
  /**
   * Detected rooms, largest first. EMPTY when {@link segmentation} is
   * 'open-space' or 'unsegmented' — the sheet must NOT number flood pockets
   * as rooms when the floor was not actually partitioned by the scan.
   */
  readonly rooms: ReadonlyArray<RoomRegion>;
  /** How many classified doorway spans were closed as room separators. */
  readonly closedDoorways: number;
  /** The honest segmentation outcome (see {@link RoomSegmentation}). */
  readonly segmentation: RoomSegmentation;
  /**
   * Area of the single largest enclosed interior region, m² — the "open
   * space" figure when {@link segmentation} is 'open-space' (else 0). Always
   * the largest candidate's area, even when it fell below the room min-area.
   */
  readonly dominantRegionAreaM2: number;
  /**
   * Fraction of the supplied floor area covered by the kept rooms (diagnostic
   * — drives the open-plan vs unsegmented decision). 0 when no floor area was
   * supplied (the coverage guard then cannot fire and rooms are kept as-is).
   */
  readonly roomCoverageFrac: number;
}

/**
 * Segment the interior into rooms: flood-fill of the free space bounded by
 * the wall mask plus the classified doorways' jamb-to-jamb spans (see the
 * module doc for the honesty rules).
 *
 * @param floorAreaM2 the scanned floor area, m² — used ONLY to detect the
 *   "could not segment" / open-plan case (the coverage guard). Pass null when
 *   no floor area is known: the guard is then skipped and the kept rooms are
 *   reported as-is (back-compat with the pure flood-fill behaviour).
 * @param opts.minRoomAreaM2 override the architectural min-room-area floor
 *   ({@link ROOM_MIN_AREA_M2}). Exists so the flood-fill MECHANICS can be
 *   tested on small synthetic grids; production always uses the default.
 */
export function detectRooms(
  walls: OccupancyGrid,
  doorways: ReadonlyArray<PlanGap>,
  floorAreaM2: number | null = null,
  opts: { readonly minRoomAreaM2?: number } = {},
): RoomDetection {
  const { cols, rows, cellX, cellY, originX, originY } = walls;
  const n = cols * rows;
  const cellArea = cellX * cellY;

  // ── Barrier mask: walls + closed doorway spans ──
  const barrier = walls.mask.slice();
  let closedDoorways = 0;
  for (const g of doorways) {
    if (g.kind !== 'door') continue; // unknown gaps are never sealed
    closedDoorways++;
    // Paint cells within DOOR_BARRIER_R_CELLS of the jamb-to-jamb segment.
    const ac = (g.a[0] - originX) / cellX - 0.5, ar = (g.a[1] - originY) / cellY - 0.5;
    const bc = (g.b[0] - originX) / cellX - 0.5, br = (g.b[1] - originY) / cellY - 0.5;
    const pad = Math.ceil(DOOR_BARRIER_R_CELLS) + 1;
    const c0 = Math.max(0, Math.floor(Math.min(ac, bc)) - pad);
    const c1 = Math.min(cols - 1, Math.ceil(Math.max(ac, bc)) + pad);
    const r0 = Math.max(0, Math.floor(Math.min(ar, br)) - pad);
    const r1 = Math.min(rows - 1, Math.ceil(Math.max(ar, br)) + pad);
    const dx = bc - ac, dy = br - ar;
    const len2 = dx * dx + dy * dy;
    const r2 = DOOR_BARRIER_R_CELLS * DOOR_BARRIER_R_CELLS;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let t = len2 > 0 ? ((c - ac) * dx + (r - ar) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = ac + t * dx - c, py = ar + t * dy - r;
        if (px * px + py * py <= r2) barrier[r * cols + c] = 1;
      }
    }
  }

  // ── Label free cells: 0 = unlabelled, 1 = exterior, ≥2 = room candidate.
  //    4-connected — a diagonal touch between regions through a wall corner
  //    must NOT merge rooms. ──
  const label = new Int32Array(n);
  const stack: number[] = [];
  const flood = (start: number, id: number): number => {
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      size++;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      if (c > 0 && !barrier[i - 1] && label[i - 1] === 0) { label[i - 1] = id; stack.push(i - 1); }
      if (c < cols - 1 && !barrier[i + 1] && label[i + 1] === 0) { label[i + 1] = id; stack.push(i + 1); }
      if (r > 0 && !barrier[i - cols] && label[i - cols] === 0) { label[i - cols] = id; stack.push(i - cols); }
      if (r < rows - 1 && !barrier[i + cols] && label[i + cols] === 0) { label[i + cols] = id; stack.push(i + cols); }
    }
    return size;
  };
  // Exterior: every free border cell (the grid is fitted to the wall bbox, so
  // anything reaching the border is outside the building or leaked there).
  for (let c = 0; c < cols; c++) {
    const top = c, bottom = (rows - 1) * cols + c;
    if (!barrier[top] && label[top] === 0) flood(top, 1);
    if (!barrier[bottom] && label[bottom] === 0) flood(bottom, 1);
  }
  for (let r = 0; r < rows; r++) {
    const left = r * cols, right = r * cols + cols - 1;
    if (!barrier[left] && label[left] === 0) flood(left, 1);
    if (!barrier[right] && label[right] === 0) flood(right, 1);
  }
  // Interior components.
  interface Cand { id: number; cells: number }
  const cands: Cand[] = [];
  let nextId = 2;
  for (let i = 0; i < n; i++) {
    if (barrier[i] || label[i] !== 0) continue;
    cands.push({ id: nextId, cells: flood(i, nextId) });
    nextId++;
  }

  // Dominant interior region: the single largest enclosed candidate (BEFORE
  // the min-area filter), used by the open-space test below — an open plan
  // floods into one big region that this captures even when no room schedule
  // is reported.
  const dominantCells = cands.reduce((mx, c) => Math.max(mx, c.cells), 0);
  const dominantRegionAreaM2 = dominantCells * cellArea;

  // ── Rooms: large-enough interior regions, largest first ──
  const minRoomAreaM2 = opts.minRoomAreaM2 ?? ROOM_MIN_AREA_M2;
  const minCells = Math.max(4, Math.round(minRoomAreaM2 / cellArea));
  const kept = cands.filter((c) => c.cells >= minCells).sort((a, b) => b.cells - a.cells).slice(0, MAX_ROOMS);
  const rooms: RoomRegion[] = [];
  for (const cand of kept) {
    const regionMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (label[i] === cand.id) regionMask[i] = 1;
    const regionGrid: OccupancyGrid = { ...walls, mask: regionMask };
    // Outer boundary only — a furniture island inside the room punches a hole
    // in the region, but the ROOM is its outer extent.
    let best: Ring | null = null;
    let bestA = 0;
    for (const ring of traceMaskBoundaries(regionGrid)) {
      const a = ringSignedArea(ring);
      if (a > bestA) { bestA = a; best = ring; }
    }
    if (!best) continue;
    const ring = simplifyRing(best, ROOM_SIMPLIFY_CELLS * Math.max(cellX, cellY));
    // Pole of inaccessibility: the chamfer-distance maximum of the region —
    // a label anchored there sits inside even an L / U shaped room.
    const d = chamferDistanceCells(regionMask, cols, rows);
    let li = -1, ld = -1;
    for (let i = 0; i < n; i++) if (regionMask[i] && d[i] > ld) { ld = d[i]; li = i; }
    const lr = (li / cols) | 0;
    const lc = li - lr * cols;
    rooms.push({
      ring,
      areaM2: cand.cells * cellArea,
      label: [originX + (lc + 0.5) * cellX, originY + (lr + 0.5) * cellY],
      cellCount: cand.cells,
    });
  }

  // ── Honesty guard: did segmentation actually capture the building? ──
  // The kept rooms are a real schedule only when they cover enough of the
  // scanned floor. On a leaking open plan the rooms are micro-pockets between
  // wall fragments that together cover a sliver of the floor — reporting them
  // as a numbered schedule fabricates partitions the scan never saw. When a
  // floor area is supplied and coverage falls short, we suppress the room list
  // and report the honest outcome instead (open-space when one region
  // dominates the floor, else unsegmented).
  const roomAreaM2 = rooms.reduce((acc, r) => acc + r.areaM2, 0);
  const roomCoverageFrac =
    floorAreaM2 != null && floorAreaM2 > 0 ? roomAreaM2 / floorAreaM2 : 0;

  const dominantFrac = floorAreaM2 != null && floorAreaM2 > 0 ? dominantRegionAreaM2 / floorAreaM2 : 0;
  // Were the rooms actually PARTITIONED (≥2 rooms, or a closed doorway split
  // one space into rooms)? An unpartitioned interior is not a "room schedule".
  const partitioned = rooms.length >= 2 || closedDoorways > 0;

  let segmentation: RoomSegmentation = 'rooms';
  if (floorAreaM2 != null && floorAreaM2 > 0) {
    if (roomCoverageFrac < ROOM_COVERAGE_MIN_FRAC) {
      // The kept rooms cover only a sliver of the floor — NOT a real schedule.
      // WHY: on a leaking open plan the open floor floods to the exterior, so
      // the only enclosed regions are micro-pockets between wall fragments
      // (the user's 96 m² floor / 8.3 m² of pockets). Numbering those "Room
      // 1..5" fabricates partitions. If ONE enclosed region nonetheless
      // dominates the floor (≥ OPEN_SPACE_MIN_FRAC), the interior is
      // essentially one connected space → present "Open space"; otherwise the
      // floor leaked away entirely and nothing reliable was segmented.
      segmentation = dominantFrac >= OPEN_SPACE_MIN_FRAC ? 'open-space' : 'unsegmented';
    } else if (!partitioned && dominantFrac >= OPEN_SPACE_MIN_FRAC) {
      // ONE region with no interior partition that covers most of the floor is
      // honestly a single OPEN SPACE, not "Room 1" of a multi-room schedule —
      // present "Open space · ~N m²". Anything genuinely partitioned (≥2 rooms
      // or a real doorway split) stays a 'rooms' schedule.
      segmentation = 'open-space';
    }
  }

  // Suppress the numbered room list for the non-'rooms' outcomes: the sheet /
  // panel must not number flood pockets (unsegmented) nor call one connected
  // space "Room 1" (open-space). The open-space AREA travels separately.
  const reportedRooms = segmentation === 'rooms' ? rooms : [];

  return {
    rooms: reportedRooms,
    closedDoorways,
    segmentation,
    dominantRegionAreaM2,
    roomCoverageFrac,
  };
}
