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
  /**
   * Whether this layer was actually mounted into the shared project frame.
   *
   * Compatibility says two layers COULD share a frame; mounting is what puts
   * them there. The two came apart when multi-layer rebasing became
   * switchable — with the mount off, two `verified` layers still passed the
   * compatibility gate while sitting at their own origins, and a combined
   * estimator would have averaged points a kilometre apart as neighbours.
   * Absent counts as mounted, so callers that predate the distinction are
   * unaffected.
   */
  mounted?: boolean;
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
  return available.filter(
    (e) => participatesInSharedAnalysis(e.compatibility ?? 'verified') && e.mounted !== false,
  );
}

/**
 * Whether an open streaming source may be merged into a combined estimator.
 *
 * Streaming resident nodes used to be appended to terrain, profile, volume and
 * count walks unconditionally, so a streamed scan joined a static one with
 * nothing proved about their frames — the same defect the static gate closes,
 * in the source type it did not reach.
 *
 * `staticIntegrableCount` is how many static clouds the walk has already
 * accepted. Zero means the stream is the only source, so nothing is being
 * combined and it is analysed in its own frame, exactly as a lone static layer
 * is. Otherwise it has to have proven it shares the frame.
 */
export function streamingMayCombine(
  staticIntegrableCount: number,
  streamingCompatibility: LayerCompatibility | null,
  streamingMounted: boolean,
): boolean {
  if (streamingCompatibility === null) return false;
  // The stream alone: nothing is being combined, so there is no second origin
  // for it to disagree with.
  if (staticIntegrableCount === 0) return true;
  // Sharing a CRS is not sharing a coordinate space. Static points are local
  // to `cloud.origin` and resident streaming nodes are local to
  // `streaming.renderOrigin` — independent numbers. Two sources can agree
  // exactly on CRS and vertical datum, both classify `verified`, and still
  // have local arrays that mean places a kilometre apart. The static path
  // already demands an actual mount; this one was judged on compatibility
  // alone, so the requirement covered one source type and not the other.
  return participatesInSharedAnalysis(streamingCompatibility) && streamingMounted;
}

/** ASPRS class 2. Class 0 means "created, never classified" — not ground. */
const ASPRS_GROUND = 2;

/**
 * Whether a source classification actually classifies any point as ground.
 *
 * "Classified ground" is a claim about the FILE. The provenance flag used to
 * ask whether the viewer had ATTACHED a derived classification, so a LAS
 * carrying an array of all zeros — class 0, "created, never classified" — had
 * attached nothing, read as not-derived, and was announced as classified
 * ground while the same scan's report said `unclassified (0.0 % coverage)`.
 * An array full of zeros is the absence of a classification, not one.
 */
export function sourceClassifiesGround(cls: ArrayLike<number> | undefined | null): boolean {
  if (!cls) return false;
  for (let i = 0; i < cls.length; i++) if (cls[i] === ASPRS_GROUND) return true;
  return false;
}

/**
 * Which classification a terrain gather may hand to a NEW analytical
 * computation. Two independent reasons to withhold an array that exists:
 *
 *   ALIGNMENT. A class array whose length does not match the point count maps
 *   codes to the wrong points, and every downstream product — bare-earth
 *   selection, contours, volumes, export provenance — is then wrong in a way
 *   nothing downstream can detect.
 *
 *   FRAME. A DERIVED classification restates physical metre thresholds in the
 *   source frame's units, so its codes only mean what they say in the frame
 *   they were derived under. Marking prior RESULTS stale does not address this:
 *   the array is an INPUT, and `terrainAnalysisRunner` captures `crsRevision`
 *   when a run STARTS, so a run begun after the frame change compares the new
 *   revision against itself and passes. Withholding the input closes it.
 *
 * Withholding is not deletion. The codes stay on the cloud for the legend, the
 * class colours and the user's editing work; the analysis proceeds as it would
 * for an unclassified scan until a re-derive under the current frame restores
 * them. A producer's classification is never withheld on frame grounds.
 */
/** The read surface this needs from a cloud. */
export interface ClassifiedSource {
  readonly classification?: ArrayLike<number>;
  readonly classificationIsDerived: boolean;
  readonly derivedClassificationFrameInvalid: boolean;
}

/**
 * The classification `cloud` may contribute to an analysis over a position
 * buffer of `positionsLength` floats (three per point), or undefined when it
 * has none, when the array is misaligned, or when derived codes belong to a
 * replaced frame.
 */
export function analysisClassification(
  cloud: ClassifiedSource,
  positionsLength: number,
): ArrayLike<number> | undefined {
  if (cloud.classificationIsDerived && cloud.derivedClassificationFrameInvalid) return undefined;
  const cls = cloud.classification;
  return cls?.length === positionsLength / 3 ? cls : undefined;
}
