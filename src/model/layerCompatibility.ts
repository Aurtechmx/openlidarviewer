/**
 * layerCompatibility.ts — what a layer has PROVEN about its spatial frame.
 *
 * The frame used to treat "no definite mismatch" as compatible, which quietly
 * inverted the burden of proof: a cloud with no declared CRS (PLY, OBJ, GLB,
 * XYZ, PCD, unresolved E57) mounted into the shared frame and was merged into
 * terrain, profile, volume and lasso estimators beside a georeferenced scan.
 * Having an origin is not evidence of sharing a coordinate system, and a
 * combined estimate over two unrelated frames is not a weak result — it is a
 * meaningless one that looks like a number.
 *
 * Four states rather than a boolean, because the middle case is real and
 * common: two scans can genuinely share a horizontal CRS while their heights
 * cannot be put on a common reference (orthometric vs ellipsoidal differ by
 * tens of metres; metres vs feet by a factor of three). That pair should align
 * in X/Y — the alignment is true — and must not be aligned or compared in Z.
 */

/** What a layer has proven about its relationship to the project frame. */
export type LayerCompatibility =
  /** Horizontal AND vertical references both proven to match. */
  | 'verified'
  /** Horizontal proven; the vertical reference is undeclared or differs. */
  | 'horizontal-only'
  /** No declared CRS — compatibility cannot be established either way. */
  | 'unknown'
  /** Proven to be a different frame. */
  | 'incompatible';

/** The facts a classification is drawn from. Declared metadata only. */
export interface CompatibilityInput {
  readonly id: string;
  /** EPSG code of the horizontal CRS, when the source declared one. */
  readonly epsg?: number;
  /** Display name of the horizontal CRS, used only when no code exists. */
  readonly crsName?: string;
  /** Vertical datum identifier as declared, or null when undeclared. */
  readonly verticalDatum?: string | null;
}

/**
 * A stable key for the horizontal frame, or null when nothing was declared.
 *
 * The EPSG code is authoritative; a display name is a fallback that only ever
 * matches another identical name. Two layers with no declaration share a
 * `null` key, which is deliberately NOT a match — see the classifier.
 */
function horizontalKey(l: CompatibilityInput): string | null {
  if (l.epsg !== undefined && Number.isFinite(l.epsg)) return `epsg:${l.epsg}`;
  const name = l.crsName?.trim();
  return name ? `name:${name.toLowerCase()}` : null;
}

/**
 * Classify every layer against the set's reference frame.
 *
 * A single layer is always `verified`: it IS the frame, so there is nothing
 * unproven about it, and the single-scan path stays exactly as it was.
 *
 * With more than one layer, the reference is the most common declared
 * horizontal key (first-seen breaks ties). A layer that declares nothing is
 * `unknown` — never silently adopted into the reference — and the whole set
 * is demoted to `horizontal-only` when the reference itself cannot state a
 * vertical datum, because then no pair has an agreed height reference.
 */
export function classifyLayerCompatibility(
  layers: readonly CompatibilityInput[],
): Map<string, LayerCompatibility> {
  const out = new Map<string, LayerCompatibility>();
  if (layers.length === 0) return out;
  if (layers.length === 1) {
    out.set(layers[0].id, 'verified');
    return out;
  }

  const declared = layers
    .map((l) => ({ l, key: horizontalKey(l) }))
    .filter((e): e is { l: CompatibilityInput; key: string } => e.key !== null);

  if (declared.length === 0) {
    // Nobody declared anything. No layer can be proven compatible with any
    // other, so none of them may join a shared estimate.
    for (const l of layers) out.set(l.id, 'unknown');
    return out;
  }

  // The reference is the most common declared horizontal key. Ties are broken
  // by the KEY itself, not by first-seen order: with no majority — four layers
  // in four different CRSs, or the ordinary two-layer disagreement — whichever
  // happened to be listed first became "the project" and the rest turned
  // incompatible, so the same files classified differently on reorder. The
  // choice among tied keys is arbitrary either way; what matters is that it is
  // a property of the data rather than of the array. A property test found
  // this after the same defect had been fixed one level down, in the vertical
  // reference.
  const counts = new Map<string, number>();
  for (const { key } of declared) counts.set(key, (counts.get(key) ?? 0) + 1);
  let referenceKey = '';
  let best = -1;
  for (const key of [...counts.keys()].sort()) {
    const n = counts.get(key) ?? 0;
    if (n > best) {
      best = n;
      referenceKey = key;
    }
  }

  // The project's vertical reference is established by UNANIMITY among the
  // layers sharing the horizontal frame, never by whichever one happens to be
  // first. Taking it from the first match made the same three files classify
  // differently on reorder — an undeclared layer leading dropped everyone to
  // horizontal-only, a declared one leading verified two of them. Load order
  // is not evidence about datums, and a verdict that moves when inputs are
  // reordered cannot be published. Unresolved therefore means unresolved for
  // the whole group: the same answer in any order.
  const group = declared.filter((e) => e.key === referenceKey);
  const groupVerticals = group.map((e) => e.l.verticalDatum?.trim() || null);
  const referenceVertical =
    groupVerticals.length > 0
    && groupVerticals.every((v) => v !== null && v === groupVerticals[0])
      ? groupVerticals[0]
      : null;

  for (const l of layers) {
    const key = horizontalKey(l);
    if (key === null) {
      out.set(l.id, 'unknown');
      continue;
    }
    if (key !== referenceKey) {
      out.set(l.id, 'incompatible');
      continue;
    }
    const vertical = l.verticalDatum?.trim() || null;
    // Both sides must state the SAME vertical datum. Undeclared is not
    // agreement — it is the absence of a claim, and heights derived across it
    // would be plausible and unfounded.
    const verticalAgrees =
      referenceVertical !== null && vertical !== null && vertical === referenceVertical;
    out.set(l.id, verticalAgrees ? 'verified' : 'horizontal-only');
  }
  return out;
}

/**
 * Whether a layer may be merged into a COMBINED estimator — terrain/DTM,
 * profile, cut/fill volume, lasso selection, reclassification, counts.
 *
 * Only `verified`. Everything else is either in a different frame or in an
 * unproven one, and merging those into a single estimate produces a figure
 * with no defined meaning. Refusing is the honest output; a warning beside a
 * computed number is not, because the number is what gets used.
 */
export function participatesInSharedAnalysis(c: LayerCompatibility): boolean {
  return c === 'verified';
}

/**
 * Whether a layer's Z may be rebased onto the project frame.
 *
 * `horizontal-only` layers align in X/Y and must keep their own vertical
 * origin: shifting Z onto a shared anchor asserts a common vertical datum
 * that was never established.
 */
export function alignsVertically(c: LayerCompatibility): boolean {
  return c === 'verified';
}

/** Whether a layer may be mounted into the shared frame at all (X/Y). */
export function alignsHorizontally(c: LayerCompatibility): boolean {
  return c === 'verified' || c === 'horizontal-only';
}

/** A short, plain statement of what a state means, for the layer panel. */
export function compatibilityNote(c: LayerCompatibility): string {
  switch (c) {
    case 'verified':
      return 'Shares the project’s horizontal and vertical reference.';
    case 'horizontal-only':
      return 'Shares the horizontal CRS; heights are on a different or undeclared vertical reference, so this layer is placed in X/Y only and is excluded from combined height, volume, surface and change results.';
    case 'unknown':
      return 'No declared CRS — compatibility with the project frame cannot be established, so this layer keeps its own frame and is excluded from combined results.';
    case 'incompatible':
      return 'A different coordinate reference system — kept in its own frame and excluded from combined results.';
  }
}
