/**
 * methodRegistry.ts — the single catalogue of scientific methods the viewer runs.
 *
 * A number in a report or an export ("RMSEz 0.14 m", "VRM 0.03", "QL2") is only
 * as trustworthy as the method that produced it and the revision of that method.
 * Before this registry those methods were named ad-hoc in free-text version
 * strings (`metricVersion: 'v0.4.1'`, `method: 'holdout-cross-validation'`) that
 * could drift apart and pointed at no citation. This gives every algorithm ONE
 * stable identifier and an integer version, so provenance can say exactly which
 * method (and which revision of it) stands behind a figure, and a reader can
 * trace it to the paper that specifies it.
 *
 * Versioning contract: the `version` integer is bumped when the method's
 * BEHAVIOUR changes in a way that could move its numbers — a new threshold, a
 * corrected estimator, a different formula. A pure refactor that leaves the
 * output identical does NOT bump it. The id never changes once published.
 *
 * Pure data: no DOM, no three.js, no I/O. Safe to import from any layer.
 */

/** A category grouping for the method catalogue. */
export type MethodCategory =
  | 'ground'
  | 'terrain'
  | 'validation'
  | 'registration'
  | 'volume'
  | 'dtm';

/** A lightweight reference to a registered method at its current version. */
export interface MethodRef {
  readonly id: string;
  readonly version: number;
}

/** A full catalogue entry. */
export interface MethodEntry extends MethodRef {
  /** Human name for the method. */
  readonly name: string;
  /** One-line description of what it computes. */
  readonly summary: string;
  /**
   * Primary literature citation (author, year, and DOI where one exists), or a
   * short honest note when the method is an internal composition with no single
   * paper. Never fabricated.
   */
  readonly citation: string;
  readonly category: MethodCategory;
}

/**
 * The catalogue. Keys ARE the ids (kept in sync by {@link METHOD_REGISTRY}'s
 * own shape and the registry test). Ids are namespaced `olv.<area>.<method>`.
 */
export const METHOD_REGISTRY: Readonly<Record<string, MethodEntry>> = {
  'olv.ground.smrf': {
    id: 'olv.ground.smrf',
    version: 1,
    name: 'Simple Morphological Filter (SMRF) ground extraction',
    summary:
      'Grid-native progressive morphological opening that separates ground from ' +
      'object returns on a rasterised surface.',
    citation: 'Pingel, Clarke & McBride (2013), doi:10.1016/j.isprsjprs.2012.12.002',
    category: 'ground',
  },
  'olv.terrain.slope-horn': {
    id: 'olv.terrain.slope-horn',
    version: 1,
    name: 'Horn slope & aspect',
    summary:
      'Slope (rise/run tangent) and downslope aspect from a 3×3 finite-difference ' +
      'stencil on the DTM grid.',
    citation: 'Horn (1981), doi:10.1109/PROC.1981.11918',
    category: 'terrain',
  },
  'olv.terrain.vrm': {
    id: 'olv.terrain.vrm',
    version: 1,
    name: 'Vector Ruggedness Measure (VRM)',
    summary:
      'Slope-independent terrain ruggedness from the dispersion of unit normal ' +
      'vectors over a moving window.',
    citation: 'Sappington, Longshore & Thompson (2007), doi:10.2193/2005-723',
    category: 'terrain',
  },
  'olv.terrain.tpi': {
    id: 'olv.terrain.tpi',
    version: 1,
    name: 'Topographic Position Index (TPI) & slope-position classes',
    summary:
      'Elevation minus the local window mean, with the six-class slope-position ' +
      'scheme for landform classification.',
    citation: 'Weiss (2001), TPI poster / Jenness (2006) implementation',
    category: 'terrain',
  },
  // Id is a stable legacy token (predates the geodesic upgrade) kept so existing
  // exports/sessions stamped `olv.dtm.idw-fill@1` stay resolvable; the shipped
  // fill is geodesic — an Euclidean IDW prefill only SEEDS it — so the name and
  // summary describe the actual algorithm, not just the prefill.
  'olv.dtm.idw-fill': {
    id: 'olv.dtm.idw-fill',
    version: 1,
    name: 'DTM rasterisation with geodesic-distance void fill',
    summary:
      'Bins ground returns to a grid, then fills interior voids by geodesic-distance ' +
      'propagation from measured cells (an Euclidean IDW prefill seeds a provisional ' +
      'surface, refined along in-surface geodesic distance), tracking measured vs interpolated cells.',
    citation: 'Internal composition (geodesic-distance void fill with an IDW prefill); no single source method.',
    category: 'dtm',
  },
  'olv.validation.holdout-rmse': {
    id: 'olv.validation.holdout-rmse',
    version: 2,
    name: 'Hold-out vertical accuracy (ASPRS-2014-style)',
    summary:
      'Withholds ground points from the surface fit, re-runs ground ' +
      'classification on the training points only (classify-inside-fold, so a ' +
      'withheld point never helps decide its own ground membership), and ' +
      'reports RMSEz plus NVA/VVA-style figures using the ASPRS 2014 formulas ' +
      '— hold-out, not independent checkpoints.',
    citation: 'ASPRS (2014) Positional Accuracy Standards, formulas only (hold-out basis)',
    category: 'validation',
  },
  'olv.validation.spatial-block': {
    id: 'olv.validation.spatial-block',
    version: 2,
    name: 'Spatial-block cross-validation',
    summary:
      'Blocks the extent at a fixed data-anchored origin, holds out whole blocks, ' +
      'and reports RMSE/MAE with a block-bootstrap confidence interval — a less ' +
      'optimistic estimate than random hold-out under spatial autocorrelation.',
    citation: 'Roberts et al. (2017), doi:10.1111/ecog.02881 (spatial block CV)',
    category: 'validation',
  },
  'olv.validation.reliability-wilson': {
    id: 'olv.validation.reliability-wilson',
    version: 1,
    name: 'Measured-cell reliability (Wilson interval)',
    summary:
      'Empirical fraction of measured cells within tolerance, with a Wilson score ' +
      'confidence interval; interpolated cells are reported as model support, not ' +
      'measured reliability.',
    citation: 'Wilson (1927), doi:10.1080/01621459.1927.10502953 (score interval)',
    category: 'validation',
  },
  'olv.registration.icp-planar': {
    id: 'olv.registration.icp-planar',
    version: 1,
    name: 'Planar rigid ICP (yaw + 3-D translation)',
    summary:
      'Coarse epoch alignment solving a yaw rotation about world-up plus a full 3-D ' +
      'translation via the closed-form planar least-squares fit, with a reported ' +
      'RMS residual and a refusal gate.',
    citation: 'Besl & McKay (1992), doi:10.1109/34.121791; Umeyama (1991) planar LS',
    category: 'registration',
  },
  'olv.volume.stockpile': {
    id: 'olv.volume.stockpile',
    version: 1,
    name: 'Stockpile cut-fill volume with 1σ band',
    summary:
      'Cut-fill prism volume of a footprint above a fitted base plane, with a ' +
      'propagated 1σ volume uncertainty of area·σ(thickness)/√N.',
    citation: 'Internal composition (prismatic cut-fill); standard earthworks method.',
    category: 'volume',
  },
};

/** Look up a method entry by id, or `null` when the id is not registered. */
export function method(id: string): MethodEntry | null {
  return METHOD_REGISTRY[id] ?? null;
}

/** True when `id` names a registered method. */
export function isMethodId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(METHOD_REGISTRY, id);
}

/**
 * A `{ id, version }` reference for a registered method — the shape a provenance
 * record embeds. Throws for an unknown id: a record must never reference a
 * method the registry does not define.
 */
export function methodRef(id: string): MethodRef {
  const entry = METHOD_REGISTRY[id];
  if (!entry) throw new Error(`Unknown method id: ${id}`);
  return { id: entry.id, version: entry.version };
}

/** The stable tag form, e.g. `"olv.validation.spatial-block@2"`. */
export function methodTag(ref: MethodRef): string {
  return `${ref.id}@${ref.version}`;
}
