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
  | 'classification'
  | 'ground'
  | 'terrain'
  | 'contour'
  | 'validation'
  | 'registration'
  | 'volume'
  | 'change'
  | 'dtm'
  | 'feature'
  | 'provenance';

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
  /**
   * The source module(s) that implement this method — the machine-readable hop
   * from a method id to the code that realises it, so the chain reads
   * claim → method → version → source → test → study without a human grep.
   * Repo-relative `src/…` paths; the registry test asserts each one exists.
   */
  readonly implementation: readonly string[];
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
    implementation: ['src/terrain/ground/groundFilter.ts'],
  },
  'olv.class.derived-heuristic': {
    id: 'olv.class.derived-heuristic',
    version: 3,
    name: 'Derived point classification (heuristic)',
    summary:
      'Unsupervised ASPRS-aligned point classification for clouds with no producer ' +
      'classification: grid-minimum surface, progressive morphological opening, ' +
      'height above ground, then per-cell roughness with optional RGB-greenness and ' +
      'multi-return cues. v3 adds a structural-verticality rescue: a tall vegetation ' +
      'candidate whose eigen neighbourhood is a planar vertical face is reclassified ' +
      'as a building wall. Coarse and heuristic, not a producer classification.',
    citation:
      'Zhang et al. (2003), doi:10.1109/TGRS.2003.810682 (progressive morphological ' +
      'filter); Amolins et al. (2008) roughness separation; Weinmann et al. (2015) ' +
      'eigenvalue shape features; internal composition of the cues.',
    category: 'classification',
    implementation: ['src/render/class/deriveClassification.ts'],
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
    implementation: ['src/terrain/ground/terrainDerivatives.ts'],
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
    implementation: ['src/terrain/complexity/vectorRuggedness.ts'],
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
    implementation: ['src/terrain/complexity/terrainPositionIndex.ts'],
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
    implementation: ['src/terrain/ground/surfaceFromRaster.ts', 'src/terrain/ground/geodesicFill.ts'],
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
    implementation: ['src/terrain/validate/holdoutRmse.ts', 'src/terrain/validate/trainOnlyReclassify.ts'],
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
    implementation: ['src/terrain/validate/spatialBlockHoldout.ts'],
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
    implementation: ['src/terrain/validate/reliabilitySplit.ts'],
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
    implementation: ['src/registration/planarIcp.ts'],
  },
  'olv.registration.epoch-horizontal-icp': {
    id: 'olv.registration.epoch-horizontal-icp',
    version: 1,
    name: 'Repeat-epoch horizontal alignment (yaw + XY, Z locked)',
    summary:
      'The transform applied to align repeat epochs: the yaw and translation from ' +
      'the planar ICP solver, with the vertical component constrained to zero so a ' +
      'real elevation change between epochs is preserved rather than absorbed into ' +
      'the fit. Describes the applied product; the generic solver it wraps is ' +
      'olv.registration.icp-planar.',
    citation: 'Besl & McKay (1992), doi:10.1109/34.121791; Umeyama (1991) planar LS',
    category: 'registration',
    implementation: ['src/terrain/change/alignEpochs.ts', 'src/terrain/change/icpRegister.ts'],
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
    implementation: ['src/render/measure/stockpileVolume.ts'],
  },
  'olv.volume.stockpile-area-grid': {
    id: 'olv.volume.stockpile-area-grid',
    version: 2,
    name: 'Area-weighted stockpile volume (grid integration)',
    summary:
      'Cut-fill volume by integrating over a regular horizontal grid: each cell ' +
      'contributes its polygon-clipped area times a robust (median) surface height ' +
      'above the base, so a density gradient in the cloud does not bias the result. ' +
      'Unobserved cells reduce reported coverage rather than reading as zero. ' +
      'Distinct from olv.volume.stockpile, which is the point-sample estimator. ' +
      'v2 excludes cells whose centre falls outside a concave footprint and ' +
      'evaluates a tilted base at each clipped cell polygon centroid; v1 summed ' +
      'every bounding-region cell against a cell-centre base, so a v1 figure does ' +
      'not carry the v2 meaning.',
    citation:
      'Internal composition (area-weighted DEM-of-difference integration; ' +
      'Sutherland & Hodgman (1974) polygon clipping); standard earthworks method.',
    category: 'volume',
    implementation: ['src/render/measure/stockpileAreaGrid.ts'],
  },
  // Legacy id: the net figure this describes is the ABOVE-LoD thresholded
  // gain-minus-loss (see changeDetection.ts's `netVolumeM3`). Kept resolvable
  // for existing exports/sessions; `.raw-net` below is the corrected successor
  // and should be preferred for new net-volume figures.
  'olv.change.dtm-difference': {
    id: 'olv.change.dtm-difference',
    version: 1,
    name: 'DTM-of-difference cut/fill (thresholded gain/loss/net)',
    summary:
      'Per-cell two-epoch elevation difference, classified against a Level-of-Detection ' +
      'threshold; gain and loss volumes sum only above-LoD cells, and net is gain minus ' +
      'loss over that same thresholded subset.',
    citation: 'Anderson (2019), pubs.usgs.gov/publication/70202166 (LoD thresholding for gross change)',
    category: 'change',
    implementation: ['src/terrain/change/changeDetection.ts', 'src/terrain/change/compareDtms.ts'],
  },
  'olv.change.dtm-difference.raw-net': {
    id: 'olv.change.dtm-difference.raw-net',
    version: 1,
    name: 'DTM-of-difference cut/fill (raw net + thresholded gross)',
    summary:
      'Same per-cell two-epoch difference as olv.change.dtm-difference, but reports the ' +
      'net volume as a raw sum over ALL comparable cells (no LoD threshold), alongside the ' +
      'LoD-thresholded gross gain/loss for erosion/deposition reporting. Thresholding is ' +
      'correct for gross change (noise inflates both sides) but biases the net, since ' +
      'uncorrelated sub-LoD error of opposite sign would otherwise cancel and instead gets ' +
      'zeroed out asymmetrically.',
    citation: 'Anderson (2019), pubs.usgs.gov/publication/70202166 (thresholded gross vs raw net)',
    category: 'change',
    implementation: ['src/terrain/change/changeDetection.ts', 'src/terrain/change/compareDtms.ts'],
  },
  'olv.topology.linkage-record': {
    id: 'olv.topology.linkage-record',
    version: 1,
    name: 'Source acquisition topology linkage record',
    summary:
      'Records, for a cloud that carried a source acquisition grid, whether a grid ' +
      'cell still resolves to the display record the loader decoded it from, and ' +
      'names the reason when it no longer does. A record about the pipeline, not a ' +
      'computation over the scene: it produces no figure.',
    citation:
      'Internal composition (provenance record over the loader-recorded cell-to-record index); no single source method.',
    category: 'provenance',
    implementation: ['src/science/sourceTopology.ts'],
  },
  'olv.feature.building-footprint': {
    id: 'olv.feature.building-footprint',
    version: 1,
    name: 'Building footprint candidate extraction',
    summary:
      'Building-classified points are rasterised to a binary occupancy grid, grouped ' +
      'into 8-connected components above a noise-area floor, and each component is ' +
      'traced to an outline. A footprint is a derived candidate over classified points, ' +
      'not a surveyed or detected building.',
    citation:
      'Internal composition of connected-component labelling over an occupancy grid and boundary tracing; no single source method.',
    category: 'feature',
    implementation: ['src/features/buildingFootprints.ts', 'src/features/footprintTrace.ts'],
  },
  'olv.feature.conductor-fit': {
    id: 'olv.feature.conductor-fit',
    version: 1,
    name: 'Conductor centreline and sag fit',
    summary:
      'Wire-classified points are fitted to a horizontal centreline (principal direction) ' +
      'and a vertical parabolic profile along it — the small-sag approximation to a ' +
      'catenary. Reports span, sag and fit residual as a derived candidate, not a ' +
      'calibrated catenary.',
    citation:
      'Parabolic small-sag approximation to the catenary; standard overhead-line result. Internal least-squares implementation.',
    category: 'feature',
    implementation: ['src/features/conductors.ts'],
  },
  'olv.contour.analytical': {
    id: 'olv.contour.analytical',
    version: 1,
    name: 'Analytical iso-contour geometry',
    summary:
      'Exact iso-contours extracted from the terrain grid by linear interpolation ' +
      'along cell edges, emitted without cartographic simplification.',
    citation:
      'Internal implementation of grid iso-contour extraction by edge linear interpolation; no single source method. Cross-checked against GDAL gdal_contour.',
    category: 'contour',
    implementation: ['src/terrain/contour/contoursAt.ts'],
  },
  'olv.contour.generalize.dp': {
    id: 'olv.contour.generalize.dp',
    version: 1,
    name: 'Douglas–Peucker contour simplification',
    summary:
      'Per-feature Douglas–Peucker line simplification of the analytical contours ' +
      'at a fixed tolerance, recording per-feature displacement statistics.',
    citation: 'Douglas & Peucker (1973), The Canadian Cartographer 10(2):112–122',
    category: 'contour',
    implementation: ['src/terrain/contourStudio/contourGeometryProduct.ts'],
  },
  'olv.contour.generalize': {
    id: 'olv.contour.generalize',
    version: 1,
    name: 'Uniform contour generalization',
    summary:
      'Cartographic generalization at one uniform Douglas–Peucker tolerance across ' +
      'every feature, run through the Douglas–Peucker primitive.',
    citation:
      'Douglas & Peucker (1973), The Canadian Cartographer 10(2):112–122 (uniform-tolerance application)',
    category: 'contour',
    implementation: ['src/terrain/contourStudio/contourGeometryProduct.ts'],
  },
  'olv.contour.generalize.terrain-adaptive': {
    id: 'olv.contour.generalize.terrain-adaptive',
    version: 1,
    name: 'Terrain-adaptive contour generalization',
    summary:
      'Cartographic generalization whose Douglas–Peucker tolerance is scaled per ' +
      'feature by measurement confidence and feature scale — smoothing measured, ' +
      'long contours more and low-confidence or small closed features less.',
    citation:
      'Internal composition (per-feature Douglas–Peucker tolerance scaled by terrain confidence and feature scale); no single source method.',
    category: 'contour',
    implementation: ['src/terrain/contourStudio/contourAdaptiveGeneralize.ts'],
  },
};

/**
 * Look up a method entry by id, or `null` when the id is not registered.
 *
 * The own-property check is load-bearing, not defensive style: a plain index
 * into an object literal resolves `__proto__`, `toString` and `constructor` on
 * the prototype chain, so those ids returned a truthy non-entry — and
 * {@link methodRef} then handed back `{id: undefined, version: undefined}`,
 * which tags as `undefined@undefined`. Two different unregistered ids composed
 * to one method tag and therefore to one record fingerprint.
 */
export function method(id: string): MethodEntry | null {
  return isMethodId(id) ? METHOD_REGISTRY[id] : null;
}

/** True when `id` names a registered method. */
export function isMethodId(id: string): boolean {
  return Object.hasOwn(METHOD_REGISTRY, id);
}

/**
 * A `{ id, version }` reference for a registered method — the shape a provenance
 * record embeds. Throws for an unknown id: a record must never reference a
 * method the registry does not define.
 */
export function methodRef(id: string): MethodRef {
  const entry = method(id);
  if (!entry) throw new Error(`Unknown method id: ${id}`);
  return { id: entry.id, version: entry.version };
}

/** The stable tag form, e.g. `"olv.validation.spatial-block@2"`. */
export function methodTag(ref: MethodRef): string {
  return `${ref.id}@${ref.version}`;
}
