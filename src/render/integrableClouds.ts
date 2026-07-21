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
 * decides whether the points are even in the same space. Both matter when
 * layers are merged: a visible layer in an unproven frame contributes
 * coordinates that mean something else, and an estimator cannot average
 * across that. Refusing is the honest result — a warning printed beside a
 * computed figure is not, because the figure is what leaves the building.
 *
 * This is the per-entry question, which assumes the entry would be COMBINED
 * with others. {@link integrableClouds} applies the single-layer carve-out.
 */
export function isIntegrable(entry: IntegrableEntry): boolean {
  if (!entry.mesh.visible || entry.locked) return false;
  return participatesInSharedAnalysis(entry.compatibility ?? 'verified');
}

/** The subset of `entries` an integration walk may feed to its estimator. */
export function integrableClouds<T extends IntegrableEntry>(entries: Iterable<T>): T[] {
  // Eligibility is decided in two stages, because the compatibility question
  // only exists when layers are COMBINED. First take everything the user is
  // working with — visible and unlocked. If that is a single layer, it is
  // analysed in its own frame and there is no cross-frame relationship to
  // prove; gating it made the tool refuse to measure one file because of a
  // relationship it was not using. Only when several layers would be merged
  // into one estimator does each have to have proven it shares the frame.
  const available: T[] = [];
  for (const entry of entries) {
    if (entry.mesh.visible && !entry.locked) available.push(entry);
  }
  if (available.length <= 1) return available;
  return available.filter((e) => participatesInSharedAnalysis(e.compatibility ?? 'verified'));
}
