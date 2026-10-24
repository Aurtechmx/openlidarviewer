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
  | 'provenance'
  /** A section line through the cloud: a height-vs-chainage estimate. */
  | 'profile'
  /** Points per unit of footprint area, and the spacing that follows from it. */
  | 'density'
  /** A declared model applied to a measured product, producing a simulated result. */
  | 'simulation'
  /** Ray-and-voxel scanner-visibility evidence (Observatory, docs/observatory/SPEC.md). */
  | 'observation'
  /** Bounds on numerical error in how the viewer represents or draws coordinates. */
  | 'precision';

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
 * Builds a `version: 1`, `category: 'simulation'` entry — the shape every
 * Terrain Access method shares. Factored out (Sonar flagged the four
 * hand-written entries as duplicated scaffolding) so the four call sites
 * below differ only in the fields that actually differ; `lint-method-
 * literals.mjs` recognises this call form and records `version: 1` for each
 * id it constructs, the same as it does for a literal entry.
 */
/** Observatory entries: version 1, category `observation`, one implementation file. */
function observationMethod(
  id: string,
  name: string,
  summary: string,
  citation: string,
  implementation: string,
): MethodEntry {
  return { id, version: 1, name, summary, citation, category: 'observation', implementation: [implementation] };
}

function terrainAccessMethod(
  id: string,
  name: string,
  summary: string,
  citation: string,
  implementation: readonly string[],
  version = 1,
): MethodEntry {
  return { id, version, name, summary, citation, category: 'simulation', implementation };
}

/**
 * The catalogue. Keys ARE the ids (kept in sync by {@link METHOD_REGISTRY}'s
 * own shape and the registry test). Ids are namespaced `olv.<area>.<method>`.
 */
/**
 * A version 1 DTM method whose rules are recorded in the EvidenceDEM attention
 * protocol, an internal composition with no single source method.
 */
function attentionProtocolMethod(
  id: string,
  name: string,
  summary: string,
  implementation: readonly string[],
): MethodEntry {
  return {
    id,
    version: 1,
    name,
    summary,
    citation: 'Internal composition (rules recorded in validation/protocols/evidencedem-attention-v1.md); no single source method.',
    category: 'dtm',
    implementation,
  };
}

export const METHOD_REGISTRY: Readonly<Record<string, MethodEntry>> = {
  'olv.ground.smrf': {
    id: 'olv.ground.smrf',
    version: 1,
    name: 'SMRF-core progressive morphological ground extraction',
    summary:
      'Grid-native progressive morphological opening that separates ground from ' +
      'object returns on a rasterised surface. It implements the SUBSET of ' +
      'Pingel et al. (2013) the claim register scopes it to, without the ' +
      'net-cutting refinement pass, so it is not the full reference pipeline.',
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
    // v2: only cells inside the data footprint (the closing of the measured
    // cells by an 8-cell disc, plus voids the data encloses) are filled; v1
    // filled every void within the fill radius, outside the survey too.
    version: 2,
    name: 'DTM rasterisation with geodesic-distance void fill',
    summary:
      'Bins ground returns to a grid, then fills interior voids by geodesic-distance ' +
      'propagation from measured cells (an Euclidean IDW prefill seeds a provisional ' +
      'surface, refined along in-surface geodesic distance), tracking measured vs interpolated cells. ' +
      'Cells outside the data footprint are left as no data.',
    citation: 'Internal composition (geodesic-distance void fill with an IDW prefill); no single source method.',
    category: 'dtm',
    implementation: [
      'src/terrain/ground/surfaceFromRaster.ts',
      'src/terrain/ground/geodesicFill.ts',
      'src/terrain/ground/coverageFootprint.ts',
    ],
  },
  'olv.terrain.evidence.support': {
    id: 'olv.terrain.evidence.support',
    version: 2,
    name: 'DTM cell support raster (terrain evidence)',
    summary:
      'Per-cell support written beside the DEM on its grid: ground-return count, ' +
      'interpolation distance (8-connected steps to the nearest measured cell times ' +
      'the cell size), the cell evidence state code (v2 adds 5 edge affected and ' +
      '6 unresolved), straight-line distance to the nearest measured cell centre, ' +
      'the median absolute deviation of the cell\'s ground returns and the ' +
      '4-connected distance to the survey boundary. Describes support, not accuracy.',
    citation: 'Internal composition (export of the DTM cell-confidence grid and cell status); no single source method.',
    category: 'dtm',
    implementation: ['src/terrain/export/demEvidence.ts', 'src/terrain/ground/rasterizeDtm.ts'],
  },
  'olv.terrain.evidence.sensitivity': {
    id: 'olv.terrain.evidence.sensitivity',
    version: 1,
    name: 'DTM model sensitivity raster (terrain sensitivity)',
    summary:
      'Per-cell spread of the DTM height over a fixed four-member ensemble run on ' +
      'the same points and grid: the canonical configuration, ground filter slope ' +
      '0.15, ground filter slope 0.2, and inverse distance weighting void fill. ' +
      'Band 1 is the highest minus the lowest member height, band 2 the number of ' +
      'members with a height. Written only on request. Describes model sensitivity, ' +
      'not accuracy.',
    citation: 'Internal composition (ensemble recorded in validation/protocols/evidencedem-sensitivity-ensemble-v1.md); no single source method.',
    category: 'dtm',
    implementation: ['src/terrain/export/demSensitivity.ts', 'src/terrain/ground/surfaceFromRaster.ts'],
  },
  'olv.terrain.evidence.residual': attentionProtocolMethod(
    'olv.terrain.evidence.residual',
    'DTM leave-local-out reconstruction residual',
    'For each measured cell, the absolute difference between its height and the ' +
      'height rebuilt by the canonical geodesic void fill from its measured ' +
      '8-neighbours only, with the cell held out. Every measured cell up to 250,000, ' +
      'otherwise every k-th in row-major order. Shows how well neighbours predict a ' +
      'cell; not a measure of accuracy.',
    ['src/terrain/export/demAttention.ts', 'src/terrain/ground/geodesicFill.ts'],
  ),
  'olv.terrain.evidence.attention': {
    id: 'olv.terrain.evidence.attention',
    // v2: a measured cell the residual sampling skipped, that no other input
    // flags, is written NoData with reason 8 UNRESOLVED instead of level 0.
    version: 2,
    name: 'DTM attention raster (where to inspect first)',
    summary:
      'Per-cell attention level 0 to 3 and one dominant reason. Long interpolation, ' +
      'low support, edge affected, model sensitivity and reconstruction residual are ' +
      'each normalised to 0 to 1 by a fixed rule; the level is the highest score ' +
      'banded at 0.33, 0.67 and 1, and the reason is the input that set it. No ' +
      'weighted blend. A measured cell the residual sampling skipped, that no other ' +
      'input flags, is NoData with reason 8 (unresolved). Written only on request. ' +
      'The reason code table is part of this version. Describes where to look, not accuracy.',
    citation: 'Internal composition (rules recorded in validation/protocols/evidencedem-attention-v1.md, version 2 section); no single source method.',
    category: 'dtm',
    implementation: ['src/terrain/export/demAttention.ts'],
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
      'and reports RMSE/MAE with a block-bootstrap confidence interval. Whether it ' +
      'is a like-for-like contrast with random hold-out depends on the path: each ' +
      'figure records the ground classification it used, and they agree only when ' +
      'the source classification is trusted. Where they differ the contrast changes ' +
      'treatment as well as geometry, and neither is guaranteed the larger.',
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
    version: 3,
    name: 'Repeat-epoch horizontal alignment (local frames, observability-gated; yaw + XY applied)',
    summary:
      'The transform applied to align repeat epochs: the yaw and x/y translation from ' +
      'the planar ICP solver, with the fitted vertical component not applied. ' +
      'Describes the applied product; the generic solver it wraps is ' +
      'olv.registration.icp-planar. v3: epochs that declare one horizontal CRS keep ' +
      'their supplied coordinates and no registration is estimated (a rigid fit cannot ' +
      'separate a shift along a slope from a real height change, and discarding the ' +
      'fitted Z let x/y absorb real change); registration uncertainty is not quantified. ' +
      'Pairs without a common declared CRS are fitted only when, at every iteration and ' +
      'before damping, the point-to-plane information matrix of yaw, x, y and z has a ' +
      'smallest-to-largest eigenvalue ratio, and a conditional information on each ' +
      'horizontal direction, of at least 0.01 (yaw row scaled by the RMS lever arm); a ' +
      'plane or a single slope is refused as unobservable. v2 fitted common-CRS epochs ' +
      'too, so a +1 m uplift on a 0.5 slope applied a 0.40 m x shift. v2: epochs ' +
      'that declare one CRS start at the identity pose (no centroid or median warm start); each iteration minimises ' +
      'point-to-plane distances (target normals from a plane fit within 2 mean point ' +
      'spacings) over the pairs within 3 mean point spacings, estimated from the ' +
      'before sample, keeping the best 90 %; the overlap is measured at that same ' +
      'distance; the fit is withheld when the overlap is under 50 %, when its residual ' +
      'exceeds 0.75 spacings (or the caller limit, whichever is smaller), or when it ' +
      'moves the after sample by more than the correspondence distance (RMS). v1 ' +
      'started from the centroid, paired every point point-to-point, and measured ' +
      'the overlap at the caller residual limit, so epochs of different extent were ' +
      'shifted by a share of the footprint difference.',
    citation: 'Besl & McKay (1992), doi:10.1109/34.121791; Chen & Medioni (1992), doi:10.1016/0262-8856(92)90066-C (point-to-plane); Umeyama (1991) planar LS',
    category: 'registration',
    implementation: ['src/terrain/change/alignEpochs.ts', 'src/terrain/change/icpRegister.ts', 'src/terrain/change/rigidObservability.ts'],
  },
  'olv.volume.stockpile': {
    id: 'olv.volume.stockpile',
    version: 3,
    name: 'Stockpile cut-fill volume with model sensitivity band',
    summary:
      'Cut-fill volume of a footprint above a base plane, integrated over a ' +
      'regular horizontal grid: each cell holding at least one point contributes ' +
      'its footprint-clipped area times its median height above the base, so a ' +
      'densely sampled cell weighs no more than a sparse one; within-cell sampling ' +
      'and surface variation can still bias the estimate. Cells without points are ' +
      'never read as zero: inside the convex extent of the covered cells they ' +
      'take a surface interpolated from the nearest covered cells (inverse-' +
      'distance weighting); outside it they are excluded and their area ' +
      'reported. The interpolated share is reported with every volume; above ' +
      '25% the volume is low-confidence and above 50% it is withheld. The ' +
      'model sensitivity band combines a per-cell surface term ' +
      'sqrt(sum (A_c * NMAD_c / sqrt(n_c))^2) with a heuristic base-height term ' +
      'over the covered area (sample standard deviations, n-1). It is not ' +
      'calibrated coverage. v3 replaces the point-weighted sum ' +
      'sum(dz) * area / N of v1 and v2, which over-counted densely scanned ' +
      'areas, and the lasso footprint is the drawn lasso projected to the ' +
      'horizontal plane instead of the convex hull of the selection. v2 left LAS ' +
      'Withheld points out of the polygon Volume tool and records points read, ' +
      'Withheld excluded (or unknown) and points analysed, and keeps Overlap; ' +
      'v1 read every point. A v1 or v2 figure does not carry the v3 meaning.',
    citation: 'Internal composition (area-weighted prismatic cut-fill; Sutherland & Hodgman (1974) polygon clipping); standard earthworks method.',
    category: 'volume',
    implementation: ['src/render/measure/volume.ts', 'src/render/measure/stockpileVolume.ts', 'src/render/measure/polygonVolumeSample.ts', 'src/render/measure/lassoVolume.ts'],
  },
  'olv.volume.stockpile-area-grid': {
    id: 'olv.volume.stockpile-area-grid',
    version: 4,
    name: 'Area-weighted stockpile volume (grid integration)',
    summary:
      'Cut-fill volume by integrating over a regular horizontal grid: each cell ' +
      'contributes its polygon-clipped area times a robust (median) surface height ' +
      'above the base, so area weighting removes unequal weighting between cells; ' +
      'within-cell sampling and surface variation can still bias the estimate. ' +
      'Unobserved cells reduce reported coverage rather than reading as zero. ' +
      'From olv.volume.stockpile v3 the cut-fill tools integrate the same grid. ' +
      'v2 excludes cells whose centre falls outside a concave footprint and ' +
      'evaluates a tilted base at each clipped cell polygon centroid; v1 summed ' +
      'every bounding-region cell against a cell-centre base, so a v1 figure does ' +
      'not carry the v2 meaning. v3 is the lasso figure read with points flagged ' +
      'Withheld left out of its input (ASPRS LAS 1.4: not to be included in ' +
      'processing); Overlap points are kept. A v2 figure included them. v4 ' +
      'interpolates unsupported cells inside the convex extent of the covered ' +
      'cells by inverse-distance weighting (w = 1/d^2): within 8 cells of ' +
      'cover over the nearest square ring of cells holding any covered cell ' +
      'plus the next ring, deeper in a void over the first covered cell along ' +
      'each of the 8 grid directions plus the nearest covered cell, so the ' +
      'fill is linear in the grid size; it ' +
      'excludes and reports those outside it, and grades the figure by the ' +
      'interpolated share (over 25%: low confidence, over 50%: withheld); a v3 ' +
      'figure left every unsupported cell out.',
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
    version: 4,
    name: 'DTM-of-difference cut/fill (thresholded gain/loss/net)',
    summary:
      'Per-cell two-epoch elevation difference, classified against a Level-of-Detection ' +
      'threshold; gain and loss volumes sum only above-LoD cells, and net is gain minus ' +
      'loss over that same thresholded subset. v3: σreg comes only from an independent stable-area ' +
      'vertical assessment, never an alignment fit residual (none exists in the app yet, so it is ' +
      'unavailable); with some terms known and some missing the threshold is ' +
      'max(1.96·√(Σ known σ²), 0.1 m), labelled incomplete (a lower bound), and counts and ' +
      'detectable volumes say so; with no term known it is the assumed 0.1 m; and the grids must ' +
      'share origin and cell size to a few float64 ulps (capped at 1e-6 cell). v2 used the alignment ' +
      '3-D RMS as σreg and fell back to 0.1 m when any term was missing; v1 used the fixed 0.1 m. ' +
      'v4 compares a cell only where both DTMs hold a measured height (ground returns in the ' +
      'cell) and reports how many cells were left out because either surface there is ' +
      'interpolated or extrapolated, on a shared grid whose cell is at least twice the mean ' +
      'point spacing of the sparser epoch; v3 and earlier also differenced filled cells, ' +
      'including fills extrapolated past one epoch\'s footprint, on a cell of extent/256.',
    citation: 'Anderson (2019), pubs.usgs.gov/publication/70202166 (LoD thresholding for gross change); Wheaton et al. (2010), doi:10.1002/esp.1886 (propagated minimum LoD)',
    category: 'change',
    implementation: ['src/terrain/change/changeDetection.ts', 'src/terrain/change/compareDtms.ts'],
  },
  'olv.change.dtm-difference.raw-net': {
    id: 'olv.change.dtm-difference.raw-net',
    version: 4,
    name: 'DTM-of-difference cut/fill (raw net + thresholded gross)',
    summary:
      'Same per-cell two-epoch difference as olv.change.dtm-difference, but reports the ' +
      'net volume as a raw sum over ALL comparable cells (no LoD threshold), alongside the ' +
      'LoD-thresholded gross gain/loss for erosion/deposition reporting. Thresholding is ' +
      'correct for gross change (noise inflates both sides) but biases the net, since ' +
      'uncorrelated sub-LoD error of opposite sign would otherwise cancel and instead gets ' +
      'zeroed out asymmetrically. v2 thresholds the gross figures at the propagated minimum LoD ' +
      '(Wheaton et al. 2010) with the assumed 0.1 m fallback, and the net band\'s per-cell σ is ' +
      '√(σz_before² + σz_after²) when both are measured; v1 used the fixed 0.1 m. v3 applies the ' +
      'olv.change.dtm-difference@3 threshold rule (no fit residual as σreg; incomplete threshold ' +
      'never below the known terms; band σ = LoD/1.96 when incomplete) and grid-identity check; ' +
      'the raw net is unthresholded and unaffected. v4 sums only cells measured in both ' +
      'epochs (the olv.change.dtm-difference v4 cell rule); v3 also summed interpolated and ' +
      'extrapolated cells.',
    citation: 'Anderson (2019), pubs.usgs.gov/publication/70202166 (thresholded gross vs raw net); Wheaton et al. (2010), doi:10.1002/esp.1886 (propagated minimum LoD)',
    category: 'change',
    implementation: ['src/terrain/change/changeDetection.ts', 'src/terrain/change/compareDtms.ts'],
  },
  'olv.render.draw-precision-bound': {
    id: 'olv.render.draw-precision-bound',
    version: 1,
    name: 'Per-draw eye-space precision bound',
    summary:
      'Upper bound on the binary32 error of the eye-space point position modelView * vec4(p, 1.0) ' +
      'for one cloud at the current camera, under round-to-nearest arithmetic, compared with a 1 mm ' +
      'tolerance. A diagnostic, not a draw gate; NOT_TESTED on a draw path whose shader is not verified. ' +
      'Does not cover projection, the divide by w, or survey accuracy.',
    citation:
      'A. Urias, "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU"; ' +
      'checker spe_check.js SHA-256 53229a0e2682fb103097eaef028079a40b6fa1a5f0c78fbf1da2b0b3c4598b6b (vendored, MIT).',
    category: 'precision',
    // The checker itself is src/vendor/spe-check/ (spe_check.mjs, olv_preflight.mjs), reached through this module.
    implementation: ['src/science/drawPrecision.ts'],
  },
  'olv.render.draw-precision-lod': {
    id: 'olv.render.draw-precision-lod',
    version: 1,
    name: 'Certified level-of-detail selection for one draw',
    summary:
      'The single-node case of the per-draw controller: the whole draw is one node, and level k '
      + 'keeps one point per occupied cell of 1 mm * 2^k at the cell centre. Selects the coarsest level '
      + 'with sigma * H_k + B_k <= tau, where H_k bounds the two-way distance between the stored points '
      + 'and the level, sigma the model-view stretch and B_k the faithful-rounding eye-space bound. '
      + 'Selected and certified at a check; the level is not drawn. No camera regions, no multi-node selection.',
    citation:
      'A. Urias, "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU" (controller, single-node case).',
    category: 'precision',
    implementation: ['src/science/drawPrecisionLod.ts'],
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
  'olv.provenance.source-interpretation': {
    id: 'olv.provenance.source-interpretation',
    version: 1,
    name: 'Source interpretation and data basis record',
    summary:
      'Records the format probe interpretation level the source file was opened at ' +
      '(or that the probe did not run) and the part of the source a result was ' +
      'computed on: full read, display sample or resident streaming set. A record ' +
      'about the pipeline input, not a computation over the scene: it produces no figure.',
    citation:
      'Internal composition (provenance record over the loader interpretation level and the capability coverage); no single source method.',
    category: 'provenance',
    implementation: ['src/science/sourceInterpretation.ts'],
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
    // v2: derived levels sit on multiples of the interval in world elevation
    // (local origin added back) instead of in the recentred local frame.
    version: 2,
    name: 'Analytical iso-contour geometry',
    summary:
      'Exact iso-contours extracted from the terrain grid by linear interpolation ' +
      'along cell edges, emitted without cartographic simplification. Levels are ' +
      'multiples of the interval in world elevation when the local origin is known.',
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
      'every feature, followed by two iterations of Chaikin corner-cutting. The ' +
      'Chaikin pass moves vertices, so a generalized line is displaced from the ' +
      'analytical isoline by both steps and not by simplification alone.',
    citation:
      'Douglas & Peucker (1973), The Canadian Cartographer 10(2):112–122 (uniform-tolerance application); ' +
      'Chaikin (1974), Computer Graphics and Image Processing 3(4):346–349 (corner cutting)',
    category: 'contour',
    implementation: ['src/terrain/contour/contourShapeStyle.ts'],
  },
  'olv.contour.generalize.terrain-adaptive': {
    id: 'olv.contour.generalize.terrain-adaptive',
    version: 1,
    name: 'Terrain-adaptive contour generalization',
    summary:
      'Cartographic generalization whose Douglas–Peucker tolerance is scaled per ' +
      'feature by measurement confidence and feature scale — smoothing measured, ' +
      'long contours more and low-confidence or small closed features less — ' +
      'followed by the same two iterations of Chaikin corner-cutting the uniform ' +
      'variant applies.',
    citation:
      'Internal composition (per-feature Douglas–Peucker tolerance scaled by terrain confidence and feature scale, then Chaikin corner-cutting); no single source method.',
    category: 'contour',
    implementation: ['src/terrain/contour/contourShapeStyle.ts'],
  },
  'olv.density.scan-report': {
    id: 'olv.density.scan-report',
    version: 2,
    name: 'Scan report point density and spacing',
    summary:
      'Nominal areal density (points over the horizontal footprint of the ' +
      'extent) and the spacing sqrt(footprint / points) that follows from it. ' +
      'v2 leaves points carrying the LAS Withheld flag out of the count and ' +
      'records points counted, Withheld excluded (or unknown when the loaded ' +
      'cloud has no flags or the count is the file header total) and points ' +
      'analysed; Overlap points are kept. v1 counted every point.',
    citation: 'Internal composition (count over footprint); Withheld per ASPRS LAS 1.4 R15.',
    category: 'density',
    implementation: ['src/analysis/modules/scanReport.ts'],
  },
  'olv.profile.corridor-percentile': {
    id: 'olv.profile.corridor-percentile',
    version: 2,
    name: 'Corridor-percentile profile',
    summary:
      'Height-vs-chainage profile along a section line: the points within a ' +
      'horizontal corridor are binned by chainage and each bin is reduced to a ' +
      'type-7 percentile of its heights, after an optional class exclusion. v2 ' +
      'leaves points carrying the LAS Withheld flag out of the corridor and ' +
      'records points read, Withheld excluded (or unknown when a source has no ' +
      'flags) and points analysed; Overlap points are kept. v1 read every point, ' +
      'and a profile recorded without a method tag was sampled under v1.',
    citation:
      'Internal composition (corridor binning with a Hyndman & Fan (1996) type-7 ' +
      'quantile per bin); Withheld per ASPRS LAS 1.4 R15.',
    category: 'profile',
    implementation: [
      'src/render/measure/profileSampler.ts',
      'src/render/measure/profileSectionSeam.ts',
      'src/render/measure/profileSectionExtract.ts',
    ],
  },
  // v2 reads NoData that reaches the grid edge through NoData as ground outside
  // the survey: a cell beside it with no lower neighbour is an outlet, as at
  // the grid edge. v1 read all NoData as a wall, so a survey strip's own edge
  // reported its downhill cells as pits.
  'olv.simulation.terrain-flow.d8': {
    id: 'olv.simulation.terrain-flow.d8',
    version: 2,
    name: 'D8 single-flow-direction routing',
    summary:
      'Routes each grid cell to whichever of its eight neighbours offers the steepest '
      + 'descent per unit of horizontal distance, measured in metres per axis so an '
      + 'anisotropic grid ranks diagonals correctly. Cells with no lower neighbour are '
      + 'reported as pits, flats or outlets rather than drained; ties break on a fixed '
      + 'neighbour order. NoData the survey encloses is a wall; NoData that reaches the '
      + 'grid edge lies outside the survey, and a cell beside it drains out as at the '
      + 'grid edge. A topographic routing graph, not a discharge field.',
    citation:
      "O'Callaghan & Mark (1984), Computer Vision, Graphics, and Image Processing 28(3), "
      + '323-344.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/d8Flow.ts'],
  },
  // v6 conditions a Float64 copy of the surface, raising a filled cell one
  // Float64 step above the cell it was reached from, and orders the flood by
  // the spill level without that rise, first in first out within a level.
  // The v5 Float32 steps added up along a long flat (6.1e-5 m a cell at
  // 600 m) until its far end stood above a nearby exit only centimetres
  // higher than the true spill point, and D8 drained that end over it; the
  // flood, ordered by the raised heights, could also reach that exit first
  // and report its level as the flat's spill level. Spill levels now equal
  // those of a flood with no rise at all, whatever rise is asked for, and a
  // Float64 chain cannot climb to the next height a Float32 DTM can hold.
  // The conditioned surface changes; `fillEpsilon: 'float32-step'` is now
  // `'float64-step'`.
  // v5 raises a filled cell one Float32 step above the cell it was reached
  // from, the increment Barnes, Lehman & Mulla take with nextafter, instead of
  // a fixed 1 mm: the flood is ordered by the raised heights, and the larger
  // rise overstated spill levels by up to centimetres and let a few small
  // depressions spill over the wrong rim. The conditioned surface changes.
  // v4 also seeds the rim of NoData that reaches the grid edge, which lies
  // outside the survey, matching D8 v2; NoData the survey encloses stays a wall.
  // v3 counts a cell as filled only when its original height is strictly
  // below the spill level it was reached from (Barnes, Lehman & Mulla 2014):
  // cells lifted only by the epsilon gradient across a flat are reported as
  // flatCellsResolved, not as fill, and fill depth excludes the epsilon chain.
  // The conditioned surface itself is unchanged from v2.
  // v2 seeds at the grid boundary only. v1 also seeded every cell beside
  // NoData, reading a survey hole as a drainage exit that D8 routes nothing
  // into, so a v1 figure does not carry the v2 meaning. That reading is the
  // declared `.gap-outlet` variant below.
  'olv.simulation.terrain-flow.priority-flood': {
    id: 'olv.simulation.terrain-flow.priority-flood',
    version: 6,
    name: 'Priority-Flood depression conditioning',
    summary:
      'Floods inward from the edge of the survey (the grid boundary and NoData that '
      + 'reaches it), raising each cell reached from below to its spill level, and '
      + 'returns a second surface rather than modifying the DTM. NoData the survey '
      + 'encloses is a wall, as D8 reads it; cells NoData encloses are left as '
      + 'they are and counted. The flood is ordered by the spill level without any '
      + 'epsilon rise, first in, first out within a level. The conditioned surface '
      + 'is Float64 and each filled cell sits one Float64 step above the cell it was '
      + 'reached from, which breaks the resulting plateaux; along any flat shorter than '
      + '2^29 cells those steps stay below the next height a Float32 DTM can represent, '
      + 'so routing cannot drain a flat over an exit higher than its true spill point. A '
      + 'fixed increment can be asked for instead; it adds up the same way and can '
      + 'climb past a nearby higher exit, and increments too small to represent are '
      + 'counted and reported rather than assumed to have applied. Only a cell whose '
      + 'original height is strictly below its spill level counts as filled; a flat '
      + 'lifted by the epsilon alone is counted separately, and fill depth excludes the '
      + 'epsilon.',
    citation: 'Barnes, Lehman & Mulla (2014), doi:10.1016/j.cageo.2013.04.024',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/priorityFlood.ts'],
  },
  // v4 takes the v6 Float64 surface and spill-level flood order above.
  'olv.simulation.terrain-flow.priority-flood.gap-outlet': {
    id: 'olv.simulation.terrain-flow.priority-flood.gap-outlet',
    version: 4,
    name: 'Priority-Flood conditioning with NoData gaps as exits',
    summary:
      'The same flood, also seeded at every cell beside NoData, so a gap drains '
      + 'the ground around it rather than bounding it. A declared reading for gaps '
      + 'that are open water; over a survey hole it invents an exit.',
    citation: 'Barnes, Lehman & Mulla (2014), doi:10.1016/j.cageo.2013.04.024',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/priorityFlood.ts'],
  },
  'olv.simulation.terrain-flow.accumulation': {
    id: 'olv.simulation.terrain-flow.accumulation',
    version: 1,
    name: 'Flow accumulation over a D8 graph',
    summary:
      'Counts the cells draining through each cell, itself included, by draining cells '
      + 'in dependency order. Contributing area in square metres is a separate step '
      + 'that is withheld when the horizontal scale is unresolved. A cell count, not a '
      + 'discharge: no rainfall, infiltration or time enters it.',
    citation:
      "Accumulation over the D8 graph of O'Callaghan & Mark (1984); internal "
      + 'dependency-ordered implementation.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/flowAccumulation.ts'],
  },
  'olv.simulation.terrain-flow.catchment': {
    id: 'olv.simulation.terrain-flow.catchment',
    version: 1,
    name: 'Upstream catchment extraction',
    summary:
      'Every cell draining through a selected outlet, obtained by walking the D8 '
      + 'receiver graph backwards from it over donor lists built once per query.',
    citation:
      "Reverse traversal of the D8 graph of O'Callaghan & Mark (1984); internal "
      + 'implementation.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/flowAccumulation.ts'],
  },
  'olv.simulation.terrain-flow.depression-inventory': {
    id: 'olv.simulation.terrain-flow.depression-inventory',
    version: 2,
    name: 'Depression inventory',
    summary:
      'Groups the cells Priority-Flood filled (original height strictly below the spill '
      + 'level; a level flat is not a depression) into 8-connected depressions and reports '
      + 'each one\'s cell count, area, deepest fill (spill level minus original height) '
      + 'and rim (outlet) elevation, largest '
      + 'first. Without conditioning, lists each raw D8 sink as its own one-cell '
      + 'candidate rather than claiming an extent nothing measured. Sink count always '
      + 'describes the unconditioned surface, in both modes.',
    citation:
      'Internal composition (connected-component grouping over the cells registered by '
      + 'olv.simulation.terrain-flow.priority-flood, compared against the raw surface); '
      + 'no single published method.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/depressionInventory.ts'],
  },
  'olv.simulation.terrain-flow.rational-peak': {
    id: 'olv.simulation.terrain-flow.rational-peak',
    version: 1,
    name: 'Rational-method peak flow estimate',
    summary:
      'Steady-state peak flow Q = C · i · A from a user-set rainfall intensity i (mm/h '
      + 'converted to m/s by dividing by 3.6e6), a runoff coefficient C and the D8 '
      + 'contributing area A in square metres. Assumes uniform rain over the whole '
      + 'catchment lasting at least its time of concentration; C lumps every loss; no '
      + 'storage or timing. Withheld when the area has no metres; flagged above 0.8 km²; '
      + 'a lower bound where the catchment is edge-contaminated. Coefficient presets are '
      + 'midpoints of published ranges.',
    citation:
      'Kuichling (1889), Transactions of the ASCE 20, 1-56; FHWA HEC-22, 3rd ed. '
      + '(FHWA-NHI-10-009, 2009), Eq. 3-1, Table 3-1 (after ASCE 1960) and the 80 ha limit; '
      + 'Schwab, Fangmeier, Elliot & Frevert (1993), Soil and Water Conservation Engineering, '
      + 'for woodland.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/rationalDischarge.ts'],
  },
  'olv.simulation.terrain-flow.edge-contamination': {
    id: 'olv.simulation.terrain-flow.edge-contamination',
    version: 1,
    name: 'D8 edge contamination',
    summary:
      'Flags each cell whose D8 upslope area holds a survey-edge cell (grid border, or '
      + 'beside NoData that reaches it) that routes into the surface, so ground outside '
      + 'the survey may also drain through it; its contributing area is then a lower '
      + 'bound. Seeds are pushed downstream in dependency order; a catchment is '
      + 'contaminated exactly when its outlet cell is.',
    citation:
      'Edge-contamination criterion as in the WhiteboxTools EdgeContamination tool '
      + '(Lindsay 2016, Computers & Geosciences 95, 75-84, doi:10.1016/j.cageo.2016.07.003); '
      + 'internal D8 implementation.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/edgeContamination.ts'],
  },
  'olv.simulation.terrain-flow.flow-length': {
    id: 'olv.simulation.terrain-flow.flow-length',
    version: 1,
    name: 'D8 flow length to an outlet',
    summary:
      'Distance along each cell\'s D8 path to a selected outlet, summing the physical '
      + 'step between cell centres (one cell size orthogonally, √2 cell sizes diagonally '
      + 'on a square grid, hypot of the two axis lengths in general), in one pass up the '
      + 'reverse D8 tree from the outlet. A distance, not a travel time.',
    citation:
      "Downstream flow length over the D8 graph of O'Callaghan & Mark (1984); internal "
      + 'implementation.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/flowLength.ts'],
  },
  'olv.simulation.terrain-flow.pour-point-snap': {
    id: 'olv.simulation.terrain-flow.pour-point-snap',
    version: 1,
    name: 'Pour-point snapping',
    summary:
      'Moves a pointer-picked catchment outlet to the cell of highest upstream count '
      + 'within a square window of 2 cells, ties kept on the picked cell, then the '
      + 'nearest, then the lowest index; NoData is never chosen. A keyboard selection '
      + 'is exact and not snapped.',
    citation:
      'Highest-accumulation search within a fixed distance, as in the WhiteboxTools '
      + 'SnapPourPoints tool (Lindsay 2016, doi:10.1016/j.cageo.2016.07.003); internal '
      + 'implementation.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/pourPointSnap.ts'],
  },
  'olv.simulation.terrain-access.local-step': terrainAccessMethod(
    'olv.simulation.terrain-access.local-step',
    'Step height of a move',
    'The step one directed move is gated on: how far its rise falls outside the '
      + 'bracket of the one-sided rises just behind its start and just past its end '
      + 'along the same heading (that one rise where only one side has data, the Horn '
      + 'gradient at both ends where neither does). A diagonal move also takes the '
      + 'easier of its two paths through the corner cells, so it cannot pass between '
      + 'the cells of a one-cell berm or ditch. A plane of any slope has no step and a '
      + 'ledge reads its own height; v1 gated the raw height difference between the '
      + 'two cells, which on coarse cells limited grade. The 3×3 local relief is '
      + 'reported alongside, never gated. A geometric discontinuity measure, not a '
      + 'classification of what caused it.',
    'Internal composition (one-sided finite differences along the move); no single source method.',
    ['src/simulation/terrainAccess/localStep.ts'],
    2,
  ),
  'olv.simulation.terrain-access.directional-grade': terrainAccessMethod(
    'olv.simulation.terrain-access.directional-grade',
    'Directional longitudinal grade and cross slope',
    'Decomposes the Horn elevation gradient into the component along a '
      + 'declared physical heading (longitudinal grade) and the component '
      + 'perpendicular to it (cross slope), so a route experiences a cell\'s '
      + 'slope differently depending on the direction it crosses it in, rather '
      + 'than being screened against total slope regardless of heading.',
    'Vector decomposition of Horn (1981) slope/aspect; internal implementation.',
    ['src/simulation/terrainAccess/directionalGrade.ts'],
  ),
  'olv.simulation.terrain-access.cost-map': terrainAccessMethod(
    'olv.simulation.terrain-access.cost-map',
    'Terrain access hard eligibility and soft traversability cost',
    'Separates direction-independent hard blocks (NoData, ROI, minimum '
      + 'terrain support, ruggedness, above-ground obstruction evidence, '
      + 'vehicle-width clearance) from direction-dependent ones (longitudinal '
      + 'grade, cross slope, step height), and assigns eligible edges a '
      + 'distance-scaled cost from declared, bounded utilization weights. An '
      + 'edge\'s longitudinal grade is the largest of the directional Horn grade '
      + 'at either endpoint and the edge\'s own rise over run; its cross slope is '
      + 'the larger perpendicular Horn component of the two endpoints. A declared '
      + 'evidence-gap policy decides cells whose slope used a synthesised Horn '
      + 'neighbour (outer ring or beside a void) and, when the obstruction limit is '
      + 'evaluated, cells with no above-ground return: conservative blocks them, '
      + 'exploratory allows them and reports their share of the route. v4 gates and '
      + 'costs the step limit on the local-step v2 discontinuity, so grade enters the '
      + 'cost once and the grade limit is the only limit on slope.',
    'Internal composition (declared multi-term utilization cost); no single source method.',
    ['src/simulation/terrainAccess/traversabilityCost.ts', 'src/simulation/terrainAccess/footprintClearance.ts'],
    4,
  ),
  'olv.simulation.terrain-access.astar': terrainAccessMethod(
    'olv.simulation.terrain-access.astar',
    'Deterministic 8-connected A* over eligible terrain cells',
    'Least-cost route search with a planimetric-distance admissible '
      + 'heuristic and a fixed, documented tie-break (lower f, then lower h, '
      + 'then lower cell index), over cells the cost-map hard-eligibility pass '
      + 'accepted. Never expands a hard-blocked cell or a hard-blocked edge. '
      + 'v2 takes moves through the cost map\'s shared transition rule: a diagonal '
      + 'that cuts the corner of an unsupported cell, or sweeps the declared width '
      + 'over unsupported area mid-move, is refused, and width clearance is measured '
      + 'to cell rectangles.',
    'Hart, Nilsson & Raphael (1968), doi:10.1109/TSSC.1968.300136 (A*)',
    ['src/simulation/terrainAccess/aStarTerrain.ts'],
    2,
  ),
  // The seven ids below are registered EARLY, before their methods exist,
  // under the maintainer's Observatory decision-rule approval
  // (docs/observatory/SPEC.md §4 OB-INT-04; validation/protocols/v070-decision-rules.md).
  // Reserving the id and version-1 now means a later phase's first commit
  // cannot collide with a name or number someone already used informally.
  // Every summary below says plainly whether the method has code behind it
  // yet; none may be read as an implementation claim. Full narrative status,
  // assumptions and the phase that will implement each one are in
  // docs/observatory/methods.md, one section per id (the OB-INT-04 test in
  // tests/observatoryMethodDocs.test.ts checks every id below has one).
  'olv.observation.rays': observationMethod(
    'olv.observation.rays',
    'Observation ray builder',
      'The ray builder (buildGriddedSourceRays, buildUnstructuredSourceRays) is implemented and tested: one ' +
      'ray per grid cell for a gridded source, direction from the fitted angular parameterisation ' +
      '(acquisitionCoverage.ts), and one ray per posed unstructured record, direction normalize(hit - origin) ' +
      'in Float64 before recentring (phase O3). It is not yet reachable from a live scene: nothing in the ' +
      'production graph builds a ledger to traverse these rays with, which is traversal (O4).',
    'Internal composition (grid and posed-ray parameterisation); no single source method.',
    'src/observation/rays.ts',
  ),
  'olv.observation.ledger': observationMethod(
    'olv.observation.ledger',
    'Voxel evidence ledger and traversal',
      'The 3D DDA traversal (Amanatides & Woo), the domain/voxel key packing, the declared voxel- and ' +
      'work-step budget refusals, and the chunk-partition/merge accumulation (traverseRayChunks, ' +
      'mergePartialLedgers, checkVoxelDomainBudget, estimateTraversalBudget, runObservationLedger, all in ' +
      'src/observation/ledger.ts) are implemented and tested against F8 (the frozen Python DDA oracle), F9 ' +
      '(fieldDigest identical under permuted chunk order and 1/2/5 in-process partitions) and a dedicated ' +
      'budget-refusal test (phase O4). It is not yet reachable from a live scene: nothing in the production ' +
      'graph wires the ray builder (O3) to this traversal, which is a coordinator (O9), and states/conflict/ ' +
      'shadow (O5) are not built.',
    'Amanatides & Woo (1987), 3-D DDA traversal (no DOI listed for this Eurographics paper).',
    'src/observation/ledger.ts',
  ),
  'olv.observation.states': observationMethod(
    'olv.observation.states',
    'Observation state table',
      'The pure per-voxel decision function (deriveObservationState) mapping counters to one of nine ' +
      'observation states is implemented and tested against an independent oracle over 7,504 preregistered ' +
      'lattice rows (phase O1). It is not yet reachable from a live scene: nothing in the production graph ' +
      'builds an evidence ledger to call it with, which needs the ray builder and traversal (O3/O4).',
    'Internal composition of the state-transition rules (docs/observatory/SPEC.md §2.2-§2.4); no single source method.',
    'src/observation/stateTable.ts',
  ),
  'olv.observation.strength': observationMethod(
    'olv.observation.strength',
    'Observation strength components',
      "Phase O6: computes sources, angularSpread, incidence, rangeFit and consistency per SURFACE voxel, each " +
      "independently bounded and shown only as separate components (never a hidden composite without its " +
      "weights, OB-STR-02). sources and consistency read straight off an ObservationLedgerRow; angularSpread, " +
      "incidence and rangeFit come from accumulateStrengthHitSamples, which re-walks a chunk's rays with the " +
      "same clip/DDA/hit-window primitives the O4 ledger traversal uses. incidence's normal is the smallest-eigenvalue eigenvector " +
      "of the resident points' covariance (fitNormalFromResidentPoints, in incidence.ts, shared with Coverage Gain) or supplied directly. Not yet wired into a run record " +
      "or any presentation surface (O7/O9).",
    'Internal composition of the strength components (docs/observatory/SPEC.md §2.5); no single source method.',
    'src/observation/strength.ts',
  ),
  'olv.observation.shadow-frontier': observationMethod(
    'olv.observation.shadow-frontier',
    'Shadow frontier',
      'Phase O5: computeShadowFrontier walks the 6-adjacency of a classified field, over the aggregate field or ' +
      'any isolated source, finding SURFACE/OBSERVED_EMPTY voxels next to a SHADOWED, UNADDRESSED or ' +
      'NO_RETURN_PATH voxel. Scored against an independent Python oracle. Not yet reachable from a live scan; ' +
      'wiring to a real ledger and scene is a coordinator (O9).',
    'Curless & Levoy (1996), doi:10.1145/237170.237269 (line-of-sight carving; empty-vs-unseen framing).',
    'src/observation/shadowFrontier.ts',
  ),
  'olv.observation.coverage-gain': observationMethod(
    'olv.observation.coverage-gain',
    'Coverage Gain',
      'Phase O10: candidates on a declared grid over level SURFACE voxels with a clear column to instrument ' +
      'height, capped by an even stride; planning rays at bin centres of the declared angular step walked with ' +
      'the ledger clip and DDA, stopped by SURFACE and by PARTIAL at or above p_solid; every term of ' +
      'G(c) = sum w(state) vis inc - lambda_red redundant reported per candidate, with NOT_READ weighted 0 and ' +
      'counted. inc comes from incidence.ts, the incidence estimate strength also uses. Scored against a ' +
      'standard-library Python oracle on F11. Counts voxels a hypothetical station would newly address; not ' +
      'an information-theoretic quantity.',
    'Scott, Roth & Rivest (2003), doi:10.1145/641865.641868 (view-planning framing).',
    'src/observation/coverageGain.ts',
  ),
  'olv.observation.station-suggestion': observationMethod(
    'olv.observation.station-suggestion',
    'Next-station suggestion',
      'Phase O10: greedy sequential selection over Coverage Gain candidates for a declared station count. ' +
      'After each pick, the voxels its planning rays reach join a hypothetical covered set and every other ' +
      'candidate is re-scored against it; ties go to the lower candidate index and the pass stops when no gain ' +
      'is positive. The canonical ledger is only read, and a suggested station never becomes a source. ' +
      'ReachabilityProvider is an interface only (OB-GAIN-06); no reachable mode is offered.',
    'Scott, Roth & Rivest (2003), doi:10.1145/641865.641868 (view-planning framing; greedy sequential selection).',
    'src/observation/stationSuggestion.ts',
  ),
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
