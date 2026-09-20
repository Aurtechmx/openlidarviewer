/**
 * visibilityReasons.ts
 *
 * Why a streamed node is not drawn, kept as separate reasons rather than as
 * one boolean.
 *
 * Two systems already decide whether a node draws and a third is arriving. The
 * replace frontier hides a coarse parent a refinement has superseded. The draw
 * frustum hides a node the camera is not looking at. A lifecycle step hides a
 * mesh that is mid-teardown. Each is independently right, and each was writing
 * `mesh.visible` directly, so whichever ran last won: a node the frustum had
 * just hidden would reappear the moment the frontier recomputed, and a parent
 * the frontier had hidden would return the moment the camera moved.
 *
 * So the reasons are stored apart and combined in one place. A node draws when
 * nothing objects, which makes adding a fourth reason a matter of adding a
 * field rather than of finding every writer.
 *
 * Nothing here evicts. A node hidden for any reason stays resident, keeps its
 * decoded chunk, and stays readable by the tools that read chunks directly.
 * Residency is a cache decision and visibility is a presentation one, and the
 * whole point of separating them is that a camera turn must not cost a
 * re-stream.
 *
 * Pure: no three.js, no scene, no side effects. The caller owns the meshes.
 */

/** Why a node might not draw. Absent means the reason does not apply. */
export interface NodeVisibilityReasons {
  /** A REPLACE frontier superseded this node, or withheld it pending one. */
  readonly replaceHidden?: boolean;
  /** The draw frustum does not contain this node's bounds. */
  readonly frustumHidden?: boolean;
  /** The mesh is mid-teardown or otherwise not drawable this frame. */
  readonly lifecycleHidden?: boolean;
}

/** Nothing objects. */
export const VISIBLE: NodeVisibilityReasons = {};

/**
 * Whether a node draws.
 *
 * Every reason is a veto, so a node draws only when all of them decline to
 * hide it. Written as an explicit conjunction rather than a loop over keys: a
 * loop would silently absorb a typo'd field name as a reason that never fires,
 * which is the failure this file exists to prevent.
 */
export function isDrawn(reasons: NodeVisibilityReasons | undefined): boolean {
  if (!reasons) return true;
  return (
    reasons.replaceHidden !== true
    && reasons.frustumHidden !== true
    && reasons.lifecycleHidden !== true
  );
}

/** The reason that is keeping a node hidden, or null when it draws. */
export function hidingReason(
  reasons: NodeVisibilityReasons | undefined,
): keyof NodeVisibilityReasons | null {
  if (!reasons) return null;
  if (reasons.replaceHidden === true) return 'replaceHidden';
  if (reasons.frustumHidden === true) return 'frustumHidden';
  if (reasons.lifecycleHidden === true) return 'lifecycleHidden';
  return null;
}

/**
 * Per-node reasons, with one place that decides what draws.
 *
 * Each setter touches ONE reason and leaves the others as they were, which is
 * the property the direct-assignment version could not have. `apply` is the
 * only thing that reaches a mesh.
 */
export class VisibilityReasonStore {
  private readonly _reasons = new Map<string, NodeVisibilityReasons>();

  /** The reasons recorded for a node. */
  reasonsFor(id: string): NodeVisibilityReasons {
    return this._reasons.get(id) ?? VISIBLE;
  }

  /** Whether a node draws under everything recorded so far. */
  drawn(id: string): boolean {
    return isDrawn(this._reasons.get(id));
  }

  /** Set one reason for one node, leaving the rest alone. */
  set(id: string, reason: keyof NodeVisibilityReasons, hidden: boolean): void {
    const current = this._reasons.get(id) ?? VISIBLE;
    if (current[reason] === hidden) return;
    const next = { ...current, [reason]: hidden };
    this._reasons.set(id, next);
  }

  /**
   * Set one reason across a whole population from a hidden set.
   *
   * `ids` is every node the reason has an opinion about, so a node that has
   * left the set is cleared rather than left hidden forever. A frontier that
   * shrinks must un-hide what it no longer covers.
   */
  setFromHiddenSet(
    ids: Iterable<string>,
    reason: keyof NodeVisibilityReasons,
    hidden: ReadonlySet<string>,
  ): void {
    for (const id of ids) this.set(id, reason, hidden.has(id));
  }

  /** Drop a node's reasons entirely, for a mesh that no longer exists. */
  forget(id: string): void {
    this._reasons.delete(id);
  }

  /** Every node with a recorded reason. */
  ids(): Iterable<string> {
    return this._reasons.keys();
  }

  /** Forget everything. */
  clear(): void {
    this._reasons.clear();
  }
}
