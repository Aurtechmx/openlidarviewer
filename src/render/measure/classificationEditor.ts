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
 * Reclassify an explicit set of point indices to `newClass`. Used by the
 * screen-lasso reclassify tool, where the selection is computed in screen space
 * (which points fell inside the drawn lasso) rather than from a horizontal
 * polygon. Out-of-range indices are skipped defensively. Edited in place; the
 * caller snapshots for undo (see `classEditHistory`).
 */
export function applyIndexReclassify(
  classification: Uint8Array,
  indices: readonly number[],
  newClass: number,
): ClassEditResult {
  const n = classification.length;
  let changed = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (i < 0 || i >= n) continue;
    if (classification[i] !== newClass) {
      classification[i] = newClass;
      changed++;
    }
  }
  return { changedCount: changed, pointCount: n };
}

/**
 * Apply a polygon-based re-classification. Every point whose horizontal
 * projection falls inside the polygon gets its class set to `newClass`
 * (regardless of its current class). When `up === [0, 0, 1]` (the
 * OpenLiDARViewer convention) the horizontal projection is world XY. For any
 * other `up`, the polygon vertices AND the points are projected onto the same
 * (east, north) orthonormal basis of the plane perpendicular to `up`, so the
 * height axis is ignored consistently — rotated, Y-up, tilted and non-origin
 * scans reclassify the geometrically correct points.
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

  // Build the horizontal basis ONCE. For the Z-up convention the horizontal
  // plane is world XY (east = X, north = Y). For any other up axis, project
  // onto the plane perpendicular to `up` using an (east, north) orthonormal
  // basis — and the points MUST use this same basis, not raw XY, or the
  // point-in-polygon test compares mismatched coordinate spaces.
  let ex = 1;
  let ey = 0;
  let ez = 0;
  let nx = 0;
  let ny = 1;
  let nz = 0;
  if (!isZUp) {
    const ux = up[0];
    const uy = up[1];
    const uz = up[2];
    // aux: a vector far from parallel to up, so up × aux is well-conditioned.
    const auxAlongZ = Math.abs(uz) < 0.99;
    const auxX = auxAlongZ ? 0 : 1;
    const auxY = 0;
    const auxZ = auxAlongZ ? 1 : 0;
    // east = normalize(up × aux)
    const eastX = uy * auxZ - uz * auxY;
    const eastY = uz * auxX - ux * auxZ;
    const eastZ = ux * auxY - uy * auxX;
    const eastLen = Math.hypot(eastX, eastY, eastZ) || 1;
    ex = eastX / eastLen;
    ey = eastY / eastLen;
    ez = eastZ / eastLen;
    // north = up × east (already unit: up and east are orthonormal)
    nx = uy * ez - uz * ey;
    ny = uz * ex - ux * ez;
    nz = ux * ey - uy * ex;
  }

  // Project the polygon ring onto the basis once.
  const polyXY: { x: number; y: number }[] = [];
  for (const p of input.polygon) {
    polyXY.push(
      isZUp
        ? { x: p[0], y: p[1] }
        : {
            x: p[0] * ex + p[1] * ey + p[2] * ez,
            y: p[0] * nx + p[1] * ny + p[2] * nz,
          },
    );
  }

  const filter = input.includeIf;
  const pos = input.positions;
  let changed = 0;

  for (let i = 0; i < n; i++) {
    const px = pos[i * 3];
    const py = pos[i * 3 + 1];
    const pz = pos[i * 3 + 2];
    // Z-up fast path: horizontal = (px, py). Otherwise project onto the same
    // (east, north) basis as the polygon, height included.
    const hx = isZUp ? px : px * ex + py * ey + pz * ez;
    const hy = isZUp ? py : px * nx + py * ny + pz * nz;
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
