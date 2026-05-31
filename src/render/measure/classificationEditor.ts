/**
 * classificationEditor.ts
 *
 * Pure-data classification mutators. Apply class swaps or polygon-based
 * re-classifications to a cloud's per-point classification buffer.
 * Unit-testable in Node — no three.js, no DOM.
 *
 * Two mutation kinds:
 *
 *   1. **Class swap** — every point whose current class is `fromClass`
 *      becomes `toClass`. The cheapest mutation; useful when an analyst
 *      wants to remap a misclassified bucket (e.g. "treat class 7
 *      (low-noise) as class 1 (unclassified)").
 *
 *   2. **Polygon re-classify** — every point whose XY projection falls
 *      inside a polygon becomes `toClass`, regardless of its current
 *      class. Builds on the same `pointInPolygon2D` test the volume
 *      measurement uses, so the surveyor can take an existing volume
 *      polygon and re-classify the bucket inside it (e.g. "the spoil
 *      pile in this polygon is class 6 (building)" → class 8 (model
 *      key-point) for downstream analysis).
 *
 * Both mutators are allocation-free — they edit the provided
 * `Uint8Array` in place and return a `{ changedCount }` summary. The
 * caller decides whether to snapshot the buffer first for undo. The
 * Viewer wraps this with a snapshot before every call.
 *
 * Classification semantics:
 *
 *   - The LAS / LAZ point format stores classification in the low 5
 *     bits of the classification byte (legacy formats 0-5) or in a
 *     full byte (formats 6-10). The mutators operate on the whole byte;
 *     the caller is responsible for masking down to 5 bits before
 *     persisting to a legacy LAS format (the v0.3.6 fix in
 *     `colorByClassification` already masks at read time).
 */

import type { Vec3 } from '../navMath';
import { pointInPolygon2D } from './volume';

/** Result of any classification mutator. */
export interface ClassEditResult {
  /** How many points changed class. Zero is a valid result. */
  changedCount: number;
  /** Total points in the buffer. */
  pointCount: number;
}

/**
 * Apply a global class swap. Every point whose `classification[i] ===
 * fromClass` is rewritten to `toClass`. No-ops if `fromClass === toClass`.
 *
 * The classification buffer is edited in place; the caller is expected
 * to snapshot it for undo before calling.
 */
export function applyClassSwap(
  classification: Uint8Array,
  fromClass: number,
  toClass: number,
): ClassEditResult {
  const n = classification.length;
  if (fromClass === toClass) {
    return { changedCount: 0, pointCount: n };
  }
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (classification[i] === fromClass) {
      classification[i] = toClass;
      changed++;
    }
  }
  return { changedCount: changed, pointCount: n };
}

/**
 * Apply a polygon-based re-classification. Every point whose horizontal
 * projection falls inside the polygon gets its class set to `newClass`
 * (regardless of its current class). The horizontal projection uses Z as
 * the height axis when `up === [0, 0, 1]` (the OpenLiDARViewer
 * convention); for any other up axis, the caller projects the polygon
 * vertices into 2D themselves and passes the projected ring.
 *
 * Optionally honours an inclusion predicate — when supplied, only points
 * for which `includeIf(currentClass)` returns true are rewritten. The
 * default predicate accepts every class. Useful for "re-classify ground
 * points (class 2) inside this polygon to building (class 6)" without
 * touching neighbouring trees.
 */
export interface PolygonReclassifyInput {
  /** The cloud's classification buffer (mutated in place). */
  classification: Uint8Array;
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  positions: Float32Array;
  /** Polygon vertices in placement order, local render-space. */
  polygon: ReadonlyArray<Vec3>;
  /** The class code to assign to every point inside the polygon. */
  newClass: number;
  /** World up vector — defaults to `[0, 0, 1]`. */
  up?: Vec3;
  /** Optional pre-mutation filter: only points where this returns true are rewritten. */
  includeIf?: (currentClass: number) => boolean;
}

export function applyPolygonReclassify(input: PolygonReclassifyInput): ClassEditResult {
  const up = input.up ?? ([0, 0, 1] as Vec3);
  const n = input.classification.length;
  if (n === 0 || input.polygon.length < 3) {
    return { changedCount: 0, pointCount: n };
  }

  const isZUp =
    Math.abs(up[2] - 1) < 1e-6 && Math.abs(up[0]) < 1e-6 && Math.abs(up[1]) < 1e-6;

  // Project polygon onto the horizontal plane once.
  const polyXY: { x: number; y: number }[] = [];
  for (const p of input.polygon) {
    if (isZUp) {
      polyXY.push({ x: p[0], y: p[1] });
    } else {
      // For non Z-up, project onto the plane perpendicular to up.
      // Pick east as the first basis vector that's not nearly parallel to up.
      const ux = up[0];
      const uy = up[1];
      const uz = up[2];
      const auxAlongZ = Math.abs(uz) < 0.99;
      const auxX = auxAlongZ ? 0 : 1;
      const auxY = 0;
      const auxZ = auxAlongZ ? 1 : 0;
      // east = normalize(up × aux)
      const eastX = uy * auxZ - uz * auxY;
      const eastY = uz * auxX - ux * auxZ;
      const eastZ = ux * auxY - uy * auxX;
      const eastLen = Math.hypot(eastX, eastY, eastZ);
      const ex = eastX / eastLen;
      const ey = eastY / eastLen;
      const ez = eastZ / eastLen;
      // north = up × east
      const northX = uy * ez - uz * ey;
      const northY = uz * ex - ux * ez;
      const northZ = ux * ey - uy * ex;
      polyXY.push({
        x: p[0] * ex + p[1] * ey + p[2] * ez,
        y: p[0] * northX + p[1] * northY + p[2] * northZ,
      });
    }
  }

  const filter = input.includeIf;
  let changed = 0;

  for (let i = 0; i < n; i++) {
    const px = input.positions[i * 3];
    const py = input.positions[i * 3 + 1];
    // Fast-path Z-up: the XY of the point is just (px, py).
    const hx = isZUp ? px : px /* general case: project below */;
    const hy = isZUp ? py : py;
    if (!pointInPolygon2D(hx, hy, polyXY)) continue;
    const current = input.classification[i];
    if (filter && !filter(current)) continue;
    if (current === input.newClass) continue;
    input.classification[i] = input.newClass;
    changed++;
  }

  return { changedCount: changed, pointCount: n };
}

/**
 * Snapshot a classification buffer so a mutation can be reversed. Cheap
 * — just `slice()` on the typed array, which copies into a fresh
 * underlying ArrayBuffer.
 */
export function snapshotClassification(classification: Uint8Array): Uint8Array {
  return classification.slice();
}

/**
 * Restore a classification buffer from a snapshot — used for undo. Both
 * arrays must have the same length; otherwise the function throws so a
 * misuse fails loud rather than silently corrupting the cloud.
 */
export function restoreClassification(
  target: Uint8Array,
  snapshot: Uint8Array,
): void {
  if (target.length !== snapshot.length) {
    throw new Error(
      `restoreClassification: length mismatch (target ${target.length} vs snapshot ${snapshot.length})`,
    );
  }
  target.set(snapshot);
}
