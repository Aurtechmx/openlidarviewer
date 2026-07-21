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
import {
  participatesInSharedAnalysis,
  type LayerCompatibility,
} from '../model/layerCompatibility';

export interface IntegrableEntry {
  /** The mesh that draws this cloud; `visible` mirrors the layer toggle. */
  mesh: { visible: boolean };
  /** Locked layers are excluded from picking and measuring. */
  locked?: boolean;
  /**
   * What this layer has PROVEN about sharing the project's frame. Absent is
   * treated as `verified` so the single-scan path — which has no set to be
   * classified against — is unchanged.
   */
  compatibility?: LayerCompatibility;
}

/**
 * Whether one entry is eligible to feed an integration walk.
 *
 * Visibility and lock decide what the user is working with; compatibility
 * decides whether the points are even in the same space. Both matter: a
 * visible layer in an unproven frame contributes coordinates that mean
 * something else, and an estimator cannot average across that. Refusing is
 * the honest result — a warning printed beside a computed figure is not,
 * because the figure is what leaves the building.
 */
export function isIntegrable(entry: IntegrableEntry): boolean {
  if (!entry.mesh.visible || entry.locked) return false;
  return participatesInSharedAnalysis(entry.compatibility ?? 'verified');
}

/** The subset of `entries` an integration walk may feed to its estimator. */
export function integrableClouds<T extends IntegrableEntry>(entries: Iterable<T>): T[] {
  const out: T[] = [];
  for (const entry of entries) if (isIntegrable(entry)) out.push(entry);
  return out;
}
