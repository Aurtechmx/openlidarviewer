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

/**
 * Resolve label collisions. Labels are processed top-to-bottom; any label that
 * would overlap one already placed is pushed straight down until it is clear.
 * The input order is preserved in the returned array.
 *
 * Bounded by construction: non-finite boxes keep their preferred anchor and
 * never join the occupied set (NaN/Infinity cannot meaningfully collide), a
 * move must STRICTLY increase `y` to count (so a float boundary can never
 * re-trigger forever), and `MAX_PASSES` caps the work per label regardless.
 */
export function layoutLabels(boxes: LabelBox[]): PlacedLabel[] {
  // Process in y-sorted order, but remember original indices to restore order.
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].y - boxes[b].y);
  const placed: PlacedLabel[] = new Array<PlacedLabel>(boxes.length);
  const occupied: { top: number; bottom: number; x: number; halfW: number }[] = [];

  for (const i of order) {
    const box = boxes[i];
    const halfW = box.width / 2;
    const halfH = box.height / 2;
    let y = box.y;

    // Degenerate box — a vertex projected at/behind the camera plane can
    // yield a non-finite anchor. Leave it at its preferred spot and keep it
    // OUT of the occupied set so it can't poison later collision tests.
    const finite =
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(halfW) &&
      Number.isFinite(halfH);
    if (!finite) {
      placed[i] = { x: box.x, y, displaced: false };
      continue;
    }

    // Push down past any horizontally-overlapping label already placed.
    let moved = true;
    for (let pass = 0; moved && pass < MAX_PASSES; pass++) {
      moved = false;
      for (const o of occupied) {
        const overlapsX = Math.abs(box.x - o.x) < halfW + o.halfW;
        if (!overlapsX) continue;
        const top = y - halfH;
        const bottom = y + halfH;
        if (top < o.bottom + GAP && bottom > o.top - GAP) {
          const next = o.bottom + GAP + halfH;
          // Strict-progress guard: only a real advance counts as a move.
          if (next > y) {
            y = next;
            moved = true;
          }
        }
      }
    }

    occupied.push({ top: y - halfH, bottom: y + halfH, x: box.x, halfW });
    placed[i] = {
      x: box.x,
      y,
      displaced: Math.abs(y - box.y) > LEADER_THRESHOLD,
    };
  }
  return placed;
}
