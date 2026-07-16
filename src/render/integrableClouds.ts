/**
 * Which loaded clouds a point-integration walk — volume cut/fill, profile,
 * terrain/DTM, lasso — is allowed to feed into its estimator.
 *
 * The rule matches the picker exactly: a walk integrates only the clouds the
 * user could place its vertices on, which is the visible, unlocked set. A hidden
 * layer stays off the estimate the way it is off the screen, and a locked
 * reference layer that is excluded from picking is excluded from the integration
 * too — otherwise a volume drawn while soloing one epoch would silently absorb
 * the other epoch's points behind it.
 *
 * Kept as one pure predicate so every walk shares the decision instead of each
 * re-deriving it (and drifting from `_pickDetailed`).
 */
export interface IntegrableEntry {
  /** The mesh that draws this cloud; `visible` mirrors the layer toggle. */
  mesh: { visible: boolean };
  /** Locked layers are excluded from picking and measuring. */
  locked?: boolean;
}

/** Whether one entry is eligible to feed an integration walk. */
export function isIntegrable(entry: IntegrableEntry): boolean {
  return entry.mesh.visible && !entry.locked;
}

/** The subset of `entries` an integration walk may feed to its estimator. */
export function integrableClouds<T extends IntegrableEntry>(entries: Iterable<T>): T[] {
  const out: T[] = [];
  for (const entry of entries) if (isIntegrable(entry)) out.push(entry);
  return out;
}
