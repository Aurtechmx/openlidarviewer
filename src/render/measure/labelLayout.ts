/**
 * labelLayout.ts
 *
 * Anti-overlap placement for measurement labels. Given each label's preferred
 * screen anchor and rendered size, it nudges overlapping labels apart
 * vertically so every value stays readable. Pure — unit-tested in Node.
 */

/** A label's preferred centre and measured size, in screen pixels. */
export interface LabelBox {
  /** Preferred centre x. */
  x: number;
  /** Preferred centre y. */
  y: number;
  /** Rendered width. */
  width: number;
  /** Rendered height. */
  height: number;
}

/** A resolved label position, with whether it was moved off its anchor. */
export interface PlacedLabel {
  x: number;
  y: number;
  /** True when the label moved far enough to want a leader line to its anchor. */
  displaced: boolean;
}

/** Vertical gap kept between stacked labels, in pixels. */
const GAP = 2;
/** Movement beyond this many pixels earns a leader line back to the anchor. */
const LEADER_THRESHOLD = 6;
/**
 * Hard ceiling on collision-resolution passes per label (v0.4.5 hardening).
 * The push-down loop terminates on well-behaved inputs (each move lifts `y`
 * strictly past one occupied bottom, and the occupied set is finite), but
 * this routine runs INSIDE the per-frame render loop with one box per
 * measurement label — a degenerate box (a non-finite anchor from a vertex
 * projected at the camera plane, or a sub-ULP float boundary where the
 * assignment cannot advance `y`) would otherwise stall the whole tab, which
 * a user reads as a crash. Past the cap, labels simply overlap — a cosmetic
 * fallback, never a hang.
 */
const MAX_PASSES = 64;

/** Grid cell size used to find the labels a box can touch. */
const CELL_W = 64;
const CELL_H = 24;

/**
 * How far off screen an anchor may be and still be laid out, in pixels. A
 * projected vertex can be finite and astronomically far away (a crafted camera
 * pose or vertex), and a label there is not on screen in any frame. Cell loops
 * over such a box never finish: past 2^53 a counter stops changing when it is
 * incremented. 1e6 px is hundreds of viewports, far beyond anything drawn.
 */
export const LABEL_COORD_LIMIT = 1e6;
/** The largest label box laid out; a box beyond it is not a label. */
const LABEL_SIZE_LIMIT = 8192;
/** Cell indices are clamped here, so the loops are bounded whatever reaches them. */
const MAX_CELL = 1 << 20;

/** Whether an anchor is within the range the layout works in. False for NaN and Infinity. */
export function isLabelCoordDrawable(x: number, y: number): boolean {
  return Math.abs(x) <= LABEL_COORD_LIMIT && Math.abs(y) <= LABEL_COORD_LIMIT;
}

function cellIndex(v: number, size: number): number {
  const c = Math.floor(v / size);
  return c < -MAX_CELL ? -MAX_CELL : c > MAX_CELL ? MAX_CELL : c === c ? c : 0;
}

/** A placed label, as the collision test sees it. */
interface Occupied {
  /** Insertion order: the test visits candidates in this order, as a linear scan would. */
  seq: number;
  top: number;
  bottom: number;
  x: number;
  halfW: number;
  /** Visit stamp, so a label spanning several cells is collected once per query. */
  stamp: number;
}

/**
 * Uniform grid over the placed labels. A box is only tested against the labels
 * in the cells it overlaps, rather than against every label placed so far.
 */
class OccupiedGrid {
  private readonly cells = new Map<number, Occupied[]>();
  private seq = 0;
  private stamp = 0;

  /** One number per cell, so a visit allocates nothing. Indices are clamped to +/-MAX_CELL. */
  private static key(cx: number, cy: number): number {
    return (cx + MAX_CELL) * (2 * MAX_CELL + 1) + (cy + MAX_CELL);
  }

  add(top: number, bottom: number, x: number, halfW: number): void {
    const o: Occupied = { seq: this.seq++, top, bottom, x, halfW, stamp: 0 };
    // The vertical extent is widened by GAP: a box within GAP of a label counts as touching it.
    const [c0, c1, r0, r1] = OccupiedGrid.span(x - halfW, x + halfW, top - GAP, bottom + GAP);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cy = r0; cy <= r1; cy++) {
        const k = OccupiedGrid.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(o);
        else this.cells.set(k, [o]);
      }
    }
  }

  /**
   * The earliest-placed label after `after` (by insertion order) that overlaps
   * the box horizontally and vertically, or null. Only the grid cells the box
   * covers are visited.
   */
  firstOverlap(
    x: number,
    halfW: number,
    y: number,
    halfH: number,
    after: number,
  ): Occupied | null {
    const top = y - halfH;
    const bottom = y + halfH;
    const [c0, c1, r0, r1] = OccupiedGrid.span(x - halfW, x + halfW, top, bottom);
    const stamp = ++this.stamp;
    let best: Occupied | null = null;
    for (let cx = c0; cx <= c1; cx++) {
      for (let cy = r0; cy <= r1; cy++) {
        const list = this.cells.get(OccupiedGrid.key(cx, cy));
        if (!list) continue;
        for (const o of list) {
          if (o.stamp === stamp || o.seq <= after) continue;
          o.stamp = stamp;
          if (best && o.seq > best.seq) continue;
          if (!(Math.abs(x - o.x) < halfW + o.halfW)) continue;
          if (top < o.bottom + GAP && bottom > o.top - GAP) best = o;
        }
      }
    }
    return best;
  }

  private static span(left: number, right: number, top: number, bottom: number): [number, number, number, number] {
    return [
      cellIndex(left, CELL_W),
      cellIndex(right, CELL_W),
      cellIndex(top, CELL_H),
      cellIndex(bottom, CELL_H),
    ];
  }
}

/**
 * Resolve label collisions. Labels are processed top-to-bottom; any label that
 * would overlap one already placed is pushed straight down until it is clear.
 * The input order is preserved in the returned array.
 *
 * Bounded by construction: boxes that are non-finite or lie farther than
 * `LABEL_COORD_LIMIT` off screen keep their preferred anchor and never join the
 * occupied set (they cannot meaningfully collide), cell indices are clamped, a
 * move must STRICTLY increase `y` to count (so a float boundary can never
 * re-trigger forever), and `MAX_PASSES` caps the work per label regardless.
 * Each box is tested only against the placed labels in the grid cells it
 * overlaps, so the cost follows local crowding instead of the label count.
 */
export function layoutLabels(boxes: LabelBox[]): PlacedLabel[] {
  // Process in y-sorted order, but remember original indices to restore order.
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].y - boxes[b].y);
  const placed: PlacedLabel[] = new Array<PlacedLabel>(boxes.length);
  const occupied = new OccupiedGrid();

  for (const i of order) {
    const box = boxes[i];
    const halfW = box.width / 2;
    const halfH = box.height / 2;
    let y = box.y;

    // Degenerate box — a vertex projected at/behind the camera plane can
    // yield a non-finite anchor. Leave it at its preferred spot and keep it
    // OUT of the occupied set so it can't poison later collision tests.
    // A finite anchor or size that is absurdly large is the same case: it is
    // not on screen, and a cell loop over it would not finish.
    const finite =
      isLabelCoordDrawable(box.x, box.y) &&
      halfW >= 0 && halfW <= LABEL_SIZE_LIMIT / 2 &&
      halfH >= 0 && halfH <= LABEL_SIZE_LIMIT / 2;
    if (!finite) {
      placed[i] = { x: box.x, y, displaced: false };
      continue;
    }

    // Push down past any horizontally-overlapping label already placed. A pass
    // walks the placed labels in the order they were placed, testing each at
    // the label's current height (a push lowers it for the rest of the pass).
    let moved = true;
    for (let pass = 0; moved && pass < MAX_PASSES; pass++) {
      moved = false;
      let after = -1;
      for (;;) {
        const o = occupied.firstOverlap(box.x, halfW, y, halfH, after);
        if (!o) break;
        after = o.seq;
        const next = o.bottom + GAP + halfH;
        // Strict-progress guard: only a real advance counts as a move.
        if (next > y) {
          y = next;
          moved = true;
        }
      }
    }

    occupied.add(y - halfH, y + halfH, box.x, halfW);
    placed[i] = {
      x: box.x,
      y,
      displaced: Math.abs(y - box.y) > LEADER_THRESHOLD,
    };
  }
  return placed;
}

/** Most labels the overlay draws in one frame; past it the nearest to the centre are kept. */
export const MAX_DRAWN_LABELS = 400;

/** A candidate for the per-frame label budget. */
export interface LabelCandidate {
  /** Projected screen position of the label's anchor. */
  x: number;
  y: number;
  /** Always drawn first: the measurement being drawn or dragged. */
  priority: boolean;
}

/**
 * Pick which labels to draw when there are more than `cap`. Priority labels
 * come first, then the rest by distance from the screen centre (`cx`, `cy`).
 * Returns the kept indices in their original order. With `cap` or fewer
 * candidates every index is kept, so ordinary scenes lay out exactly as before.
 */
export function selectLabelsToDraw(
  items: readonly LabelCandidate[],
  cap: number,
  cx: number,
  cy: number,
): number[] {
  if (items.length <= cap) return items.map((_, i) => i);
  const rank = items.map((it, i) => {
    const d = Math.hypot(it.x - cx, it.y - cy);
    return { i, priority: it.priority, d: Number.isFinite(d) ? d : Infinity };
  });
  rank.sort((a, b) => Number(b.priority) - Number(a.priority) || a.d - b.d || a.i - b.i);
  return rank
    .slice(0, cap)
    .map((r) => r.i)
    .sort((a, b) => a - b);
}
