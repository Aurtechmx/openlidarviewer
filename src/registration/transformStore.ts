/**
 * transformStore.ts — a layer's placement transform, held non-destructively in
 * Float64.
 *
 * A registration result is a rigid transform, not a rewrite of the points. This
 * holds that transform SEPARATELY from the source buffer: the points are never
 * mutated, the transform is composed in Float64 (so repeated placement does not
 * accumulate Float32 drift), undo restores the exact previous placement, and
 * reset returns to identity — the original coordinates are always recoverable.
 * Baking (writing transformed coordinates into an exported LAS) is an explicit,
 * separate action a caller opts into, never a side effect of placing a layer.
 * Pure state; no IO.
 */

export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [Vec3, Vec3, Vec3];

export interface RigidTransform {
  readonly R: Mat3;
  readonly t: Vec3;
}

export const IDENTITY: RigidTransform = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };

export class TransformStore {
  /** Stack of composed placements; [0] is always identity (the original). */
  private readonly _stack: RigidTransform[] = [IDENTITY];
  private _baked = false;

  /** The current composed placement (top of the stack). */
  current(): RigidTransform {
    return this._stack[this._stack.length - 1];
  }

  /** Push a new placement by composing `next` onto the current one (Float64). */
  apply(next: RigidTransform): void {
    this._stack.push(compose(next, this.current()));
  }

  /** Undo the last placement, restoring the exact previous one. No-op at origin. */
  undo(): void {
    if (this._stack.length > 1) this._stack.pop();
  }

  /** Return to identity; the source coordinates are unchanged and recoverable. */
  reset(): void {
    this._stack.length = 1;
  }

  /** How many placements sit above the original. */
  get depth(): number {
    return this._stack.length - 1;
  }

  /** Apply the current placement to a source point (source is never mutated). */
  place(p: Vec3): Vec3 {
    const { R, t } = this.current();
    return [
      R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
      R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
      R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
    ];
  }

  /** Whether the placement has been baked into exported coordinates. */
  get isBaked(): boolean {
    return this._baked;
  }

  /**
   * Mark the current placement as baked (the caller is about to write
   * transformed coordinates to an export). Baking does not touch the source;
   * it only records that an export carries the transform. Explicit and one-way
   * for a given export — the store itself remains non-destructive.
   */
  bake(): RigidTransform {
    this._baked = true;
    return this.current();
  }
}

/** Compose two rigid transforms: (a ∘ b)(p) = a(b(p)). Float64 throughout. */
export function compose(a: RigidTransform, b: RigidTransform): RigidTransform {
  const R = matMul(a.R, b.R);
  const t: Vec3 = [
    a.R[0][0] * b.t[0] + a.R[0][1] * b.t[1] + a.R[0][2] * b.t[2] + a.t[0],
    a.R[1][0] * b.t[0] + a.R[1][1] * b.t[1] + a.R[1][2] * b.t[2] + a.t[1],
    a.R[2][0] * b.t[0] + a.R[2][1] * b.t[1] + a.R[2][2] * b.t[2] + a.t[2],
  ];
  return { R, t };
}

function matMul(a: Mat3, b: Mat3): Mat3 {
  const o: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return o as unknown as Mat3;
}
