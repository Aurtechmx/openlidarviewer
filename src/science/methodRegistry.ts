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
  | 'observation';

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
): MethodEntry {
  return { id, version: 1, name, summary, citation, category: 'simulation', implementation };
}

/**
 * The catalogue. Keys ARE the ids (kept in sync by {@link METHOD_REGISTRY}'s
 * own shape and the registry test). Ids are namespaced `olv.<area>.<method>`.
 */
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
  'olv.terrain.evidence.support': {
    id: 'olv.terrain.evidence.support',
    version: 1,
    name: 'DTM cell support raster (terrain evidence)',
    summary:
      'Per-cell support written beside the DEM on its grid: ground-return count, ' +
      'interpolation distance (8-connected steps to the nearest measured cell times ' +
      'the cell size) and the cell evidence state code. Describes support, not accuracy.',
    citation: 'Internal composition (export of the DTM cell-confidence grid and cell status); no single source method.',
    category: 'dtm',
    implementation: ['src/terrain/export/demEvidence.ts'],
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
    name: 'Stockpile cut-fill volume with model sensitivity band',
    summary:
      'Cut-fill prism volume of a footprint above a fitted base plane, with a ' +
      'model sensitivity band combining the independent-sample thickness term ' +
      'area·σ(thickness)/√N and a heuristic base-height term. The arithmetic is ' +
      'a standard deviation of that model; it is not calibrated coverage, ' +
      'because the thickness samples are spatially correlated and the base term ' +
      'is a spread rather than a measured error.',
    citation: 'Internal composition (prismatic cut-fill); standard earthworks method.',
    category: 'volume',
    implementation: ['src/render/measure/stockpileVolume.ts'],
  },
  'olv.volume.stockpile-area-grid': {
    id: 'olv.volume.stockpile-area-grid',
    version: 3,
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
      'not carry the v2 meaning. v3 is the lasso figure read with points flagged ' +
      'Withheld left out of its input (ASPRS LAS 1.4: not to be included in ' +
      'processing); Overlap points are kept. A v2 figure included them.',
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
  'olv.simulation.terrain-flow.d8': {
    id: 'olv.simulation.terrain-flow.d8',
    version: 1,
    name: 'D8 single-flow-direction routing',
    summary:
      'Routes each grid cell to whichever of its eight neighbours offers the steepest '
      + 'descent per unit of horizontal distance, measured in metres per axis so an '
      + 'anisotropic grid ranks diagonals correctly. Cells with no lower neighbour are '
      + 'reported as pits, flats or outlets rather than drained; ties break on a fixed '
      + 'neighbour order. A topographic routing graph, not a discharge field.',
    citation:
      "O'Callaghan & Mark (1984), Computer Vision, Graphics, and Image Processing 28(3), "
      + '323-344.',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/d8Flow.ts'],
  },
  // v2 seeds at the grid boundary only. v1 also seeded every cell beside
  // NoData, reading a survey hole as a drainage exit that D8 routes nothing
  // into, so a v1 figure does not carry the v2 meaning. That reading is the
  // declared `.gap-outlet` variant below.
  'olv.simulation.terrain-flow.priority-flood': {
    id: 'olv.simulation.terrain-flow.priority-flood',
    version: 2,
    name: 'Priority-Flood depression conditioning',
    summary:
      'Floods inward from the grid boundary, raising each cell reached from below '
      + 'to its spill level, and returns a second surface rather than modifying the '
      + 'DTM. NoData is a wall, as D8 reads it; cells NoData encloses are left as '
      + 'they are and counted. An optional increment above the spill parent breaks '
      + 'the resulting plateaux; increments lost to Float32 precision are counted '
      + 'and reported rather than assumed to have applied.',
    citation: 'Barnes, Lehman & Mulla (2014), doi:10.1016/j.cageo.2013.04.024',
    category: 'simulation',
    implementation: ['src/simulation/flowPulse/priorityFlood.ts'],
  },
  'olv.simulation.terrain-flow.priority-flood.gap-outlet': {
    id: 'olv.simulation.terrain-flow.priority-flood.gap-outlet',
    version: 1,
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
    version: 1,
    name: 'Depression inventory',
    summary:
      'Groups the cells Priority-Flood raised into 8-connected depressions and reports '
      + 'each one\'s cell count, area, deepest fill and rim (outlet) elevation, largest '
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
  'olv.simulation.terrain-access.local-step': terrainAccessMethod(
    'olv.simulation.terrain-access.local-step',
    'Local step-height metric',
    'Maximum absolute elevation discontinuity between a cell and its valid '
      + 'neighbours within a 3×3 footprint, plus the pairwise edge form used to '
      + 'gate one directed move. A geometric discontinuity measure, not a '
      + 'classification of what caused it.',
    'Internal composition (footprint-maximum finite difference); no single source method.',
    ['src/simulation/terrainAccess/localStep.ts'],
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
      + 'distance-scaled cost from declared, bounded utilization weights.',
    'Internal composition (declared multi-term utilization cost); no single source method.',
    ['src/simulation/terrainAccess/traversabilityCost.ts'],
  ),
  'olv.simulation.terrain-access.astar': terrainAccessMethod(
    'olv.simulation.terrain-access.astar',
    'Deterministic 8-connected A* over eligible terrain cells',
    'Least-cost route search with a planimetric-distance admissible '
      + 'heuristic and a fixed, documented tie-break (lower f, then lower h, '
      + 'then lower cell index), over cells the cost-map hard-eligibility pass '
      + 'accepted. Never expands a hard-blocked cell or a hard-blocked edge.',
    'Hart, Nilsson & Raphael (1968), doi:10.1109/TSSC.1968.300136 (A*)',
    ['src/simulation/terrainAccess/aStarTerrain.ts'],
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
      "same clip/DDA/hit-window primitives the O4 ledger traversal uses. incidence's normal is fit via symEig3 " +
      "over resident points (fitNormalFromResidentPoints) or supplied directly. Not yet wired into a run record " +
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
    'Coverage Gain (not implemented)',
      'Not implemented in v0.7. Reserves the id and version ahead of phase O10, which will generate ' +
      'candidate stations on a declared grid and score each against the evidence ledger by the declared ' +
      'per-state weights, incidence and redundancy terms. src/observation/coverageGain.ts holds the declared ' +
      'instrument-model and per-candidate term shapes only; no candidate generation or scoring exists yet. ' +
      'Not an information-theoretic quantity, and never named as one.',
    'Scott, Roth & Rivest (2003), doi:10.1145/641865.641868 (view-planning framing).',
    'src/observation/coverageGain.ts',
  ),
  'olv.observation.station-suggestion': observationMethod(
    'olv.observation.station-suggestion',
    'Next-station suggestion (not implemented)',
      'Not implemented in v0.7. Reserves the id and version ahead of phase O10, which will run greedy ' +
      'sequential selection over Coverage Gain candidates against a hypothetical copy of the ledger, never ' +
      'the canonical one. src/observation/stationSuggestion.ts holds the declared result shape and the ' +
      'ReachabilityProvider interface OB-GAIN-06 defines for v0.7 (no implementation of it exists, and the ' +
      'panel offers no "reachable" mode until one is registered with evidence).',
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
