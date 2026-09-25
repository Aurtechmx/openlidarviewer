/**
 * Canonical digests of the scientific results, over a fixed synthetic scene,
 * for the presentation-invariance matrix (tests/presentationInvariance.test.ts).
 *
 * Every result is computed through the same pure entry points the viewer
 * calls, with the same host inputs it threads in:
 *
 *   DTM        sampleStridedTerrain → computeTerrainCore → dtmProductDigest
 *              (the gather in Viewer.gatherTerrainPositions)
 *   stockpile  computeLassoVolume → deriveVolumeRecord → lassoStockpileResult
 *              (Viewer.computeLassoVolume + the main.ts commit path)
 *   profile    createProfileSectionSeam().sampleSeries / .section
 *   density    scanReport.run → the 'Density' row
 *
 * Presentation state is resolved through the app's own policy functions
 * (qualitySettingsFor, and the frame budget governor through the same
 * GovernorWiring the render loop installs under `?governor=on`) and then
 * applied where the app applies it: the streaming point budget decides which nodes are resident,
 * the camera pose builds the lasso projector, and the lasso projector is
 * sized in CSS pixels (canvas.clientWidth/clientHeight), as the Viewer does.
 */
import { PointCloud } from '../../src/model/PointCloud';
import { encodeExtendedClassificationFlags } from '../../src/lasSemantics';
import { sha256Hex } from '../../src/terrain/export/sha256';
import { dtmProductDigest } from '../../src/science/dtmProductDigest';
import { computeTerrainCore } from '../../src/terrain/contour/analyseContours';
import {
  sampleStridedTerrain,
  type KeyedTerrainStreamBuffer,
  type TerrainStreamBuffer,
} from '../../src/render/terrainStreamSample';
import {
  computeLassoVolume,
  lassoVisibilityFilters,
  makeLassoProjector,
  type StreamingLassoPart,
} from '../../src/render/measure/lassoVolumeCompute';
import { deriveVolumeRecord } from '../../src/render/measure/measureDerivations';
import { POINT_SAMPLE_VOLUME_METHOD } from '../../src/render/measure/volume';
import { lassoStockpileResult } from '../../src/render/measure/stockpilePresenter';
import {
  createProfileSectionSeam,
  type ProfileSeamLayer,
  type ProfileSeamResidentNode,
} from '../../src/render/measure/profileSectionSeam';
import {
  streamingIsComplete,
  type StreamingCoverage,
} from '../../src/render/measure/profileSectionSnapshot';
import { scanReport } from '../../src/analysis/modules/scanReport';
import {
  midQualityPosition,
  qualitySettingsFor,
  QUALITY_MIN,
  type QualityDevice,
} from '../../src/render/quality/qualityPolicy';
import type { FrameBudgetInput, FrameBudgetPolicy } from '../../src/render/perf/frameBudgetGovernor';
import { GOVERNOR_WINDOW, GovernorWiring } from '../../src/render/perf/governorWiring';
import type { Vec3, VolumeRecord } from '../../src/render/measure/types';

// ── Canonical hashing ─────────────────────────────────────────────────────

/** Key-sorted JSON; non-finite numbers and typed arrays spelled out, so nothing collapses to null. */

/** Locale-independent order, so a digest reads the same on every machine. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return `#${String(v)}`;
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      return Array.from(v as unknown as ArrayLike<number>, (n) => (Number.isFinite(n) ? n : `#${String(n)}`));
    }
    if (v instanceof Map) return Object.fromEntries([...v.entries()].sort(([a], [b]) => byCodeUnit(String(a), String(b))));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort(byCodeUnit).filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
    }
    return v;
  });
}

export function digestOf(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

// ── Fixture ───────────────────────────────────────────────────────────────

const WITHHELD = encodeExtendedClassificationFlags({ withheld: true });
const OVERLAP = encodeExtendedClassificationFlags({ overlap: true });
const WITHHELD_OVERLAP = encodeExtendedClassificationFlags({ withheld: true, overlap: true });

/** A Withheld point sits 30 units above the surface, so any leak moves every result. */
export const WITHHELD_LIFT = 30;

interface Patch {
  positions: Float32Array;
  classification: Uint8Array;
  flags: Uint8Array;
}

/** A 1-unit grid over [x0, x0+nx) × [0, ny) with a mound at (cx, cy). */
function patch(x0: number, nx: number, ny: number, cx: number, cy: number, keep: (i: number, j: number) => boolean): Patch {
  const pos: number[] = [];
  const cls: number[] = [];
  const flg: number[] = [];
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!keep(i, j)) continue;
      const x = x0 + i;
      const y = j;
      const r = Math.hypot(x - cx, y - cy);
      let z = Math.max(0, 6 - r * 0.6) + 0.05 * Math.sin(x * 0.7) * Math.cos(y * 0.5);
      const withheld = k % 11 === 0;
      const overlap = k % 5 === 0;
      if (withheld) z += WITHHELD_LIFT;
      pos.push(x, y, z);
      cls.push(r > 10 ? 2 : 1);
      flg.push(withheld && overlap ? WITHHELD_OVERLAP : withheld ? WITHHELD : overlap ? OVERLAP : 0);
      k++;
    }
  }
  return { positions: new Float32Array(pos), classification: new Uint8Array(cls), flags: new Uint8Array(flg) };
}

/** One streaming node: real buffers plus the nominal size the scheduler admits it on. */
export interface FixtureNode {
  readonly key: string;
  readonly depth: number;
  /** The point count the node is admitted against the resident budget with. */
  readonly nominalPoints: number;
  readonly patch: Patch;
}

export interface FixtureScene {
  readonly cloud: PointCloud;
  readonly staticPatch: Patch;
  /** Empty for the static-only scene. */
  readonly nodes: readonly FixtureNode[];
}

/** Static layer over x ∈ [0, 40), y ∈ [0, 40), mound at (20, 20). */
function staticCloud(): { cloud: PointCloud; p: Patch } {
  const p = patch(0, 40, 40, 20, 20, () => true);
  const cloud = new PointCloud({
    positions: p.positions,
    classification: p.classification,
    classificationFlags: p.flags,
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'invariance-fixture',
  });
  return { cloud, p };
}

export function staticScene(): FixtureScene {
  const { cloud, p } = staticCloud();
  return { cloud, staticPatch: p, nodes: [] };
}

/**
 * The static layer plus a streamed neighbour over x ∈ [40, 80): a root node
 * holding every 4th point, and four quadrant children holding the rest.
 * Nominal sizes are chosen so the Speed and Balanced budgets admit different
 * node sets (root only vs root + two children).
 */
export function streamingScene(): FixtureScene {
  const { cloud, p } = staticCloud();
  const root = patch(40, 40, 40, 60, 20, (i, j) => (i + j * 40) % 4 === 0);
  const child = (qx: number, qy: number): Patch =>
    patch(40, 40, 40, 60, 20, (i, j) => (i + j * 40) % 4 !== 0 && (i >= 20 ? 1 : 0) === qx && (j >= 20 ? 1 : 0) === qy);
  const nodes: FixtureNode[] = [
    { key: '0-0-0-0', depth: 0, nominalPoints: 1_000_000, patch: root },
    { key: '1-0-0-0', depth: 1, nominalPoints: 700_000, patch: child(0, 0) },
    { key: '1-1-0-0', depth: 1, nominalPoints: 700_000, patch: child(1, 0) },
    { key: '1-0-1-0', depth: 1, nominalPoints: 700_000, patch: child(0, 1) },
    { key: '1-1-1-0', depth: 1, nominalPoints: 700_000, patch: child(1, 1) },
  ];
  return { cloud, staticPatch: p, nodes };
}

// ── Presentation state ────────────────────────────────────────────────────

export type BudgetSetting = 'low' | 'default';
export type GovernorSetting = 'nominal' | 'stressed';
export type PoseId = 'A' | 'B';

export interface PresentationSettings {
  readonly dpr: number;
  readonly edl: boolean;
  readonly budget: BudgetSetting;
  readonly governor: GovernorSetting;
  readonly pose: PoseId;
}

/** What the renderer ends up with after the app's policies resolve the settings. */
export interface ResolvedPresentation {
  readonly settings: PresentationSettings;
  readonly streamingPointBudget: number;
  readonly policy: FrameBudgetPolicy;
  /** Backing-store pixel ratio after the quality ceiling and governor pressure. */
  readonly backingPixelRatio: number;
  readonly edlDrawn: boolean;
  /** Drawn fraction of each point mesh after the governor's v2 point budget. */
  readonly drawnPointFraction: number;
  /** Canvas CSS size: what `canvas.clientWidth/clientHeight` return. Unchanged by DPR. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly pose: PoseId;
}

const DEVICE: QualityDevice = { tier: 'high', isMobile: false, backend: 'webgl2' };

export const GOVERNOR_INPUT: Record<GovernorSetting, FrameBudgetInput> = {
  nominal: {
    phase: 'full-refine', tweening: false, recentMedianMs: 8, recentHighMs: 10,
    pendingGpuNodes: 0, streamingBacklog: 0, continuityPending: false, mobileTier: false,
  },
  stressed: {
    phase: 'moving', tweening: true, recentMedianMs: 45, recentHighMs: 70,
    pendingGpuNodes: 6, streamingBacklog: 12, continuityPending: true, mobileTier: false,
  },
};

/**
 * The wired governor after a window of frames matching `input`: the recorder
 * feeds the frame times (median and high as stated), the upload queue reports
 * the pending nodes, and one more frame resolves the policy with them.
 */
export function wiredGovernor(input: FrameBudgetInput): GovernorWiring {
  const g = new GovernorWiring(input.mobileTier);
  for (let i = 0; i < GOVERNOR_WINDOW - 1; i++) g.frameMs(input.recentMedianMs);
  g.frameMs(input.recentHighMs);
  g.frame(input.phase, input.tweening);
  g.uploadLimits({ maxNodes: 8 }, input.pendingGpuNodes);
  g.frame(input.phase, input.tweening);
  return g;
}

export function resolvePresentation(s: PresentationSettings): ResolvedPresentation {
  const q = qualitySettingsFor(s.budget === 'low' ? QUALITY_MIN : midQualityPosition(), DEVICE);
  const gov = wiredGovernor(GOVERNOR_INPUT[s.governor]);
  const ratio = Math.min(s.dpr, q.maxPixelRatio);
  return {
    settings: s,
    streamingPointBudget: q.streamingPointBudget,
    policy: gov.policy,
    backingPixelRatio: gov.dpr(ratio, Math.min(ratio, 0.5), ratio),
    edlDrawn: s.edl && gov.edl(),
    drawnPointFraction: gov.policy.pointBudgetFraction,
    cssWidth: 1200,
    cssHeight: 800,
    pose: s.pose,
  };
}

/**
 * The resident node set the budget admits: coarse-to-fine, then by key, while
 * the nominal total fits. The root is always admitted.
 */
export function residentNodes(scene: FixtureScene, budget: number): FixtureNode[] {
  const order = [...scene.nodes].sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: FixtureNode[] = [];
  let used = 0;
  for (const n of order) {
    if (out.length > 0 && used + n.nominalPoints > budget) continue;
    out.push(n);
    used += n.nominalPoints;
  }
  return out;
}

export function coverageOf(scene: FixtureScene, resident: readonly FixtureNode[]): StreamingCoverage | null {
  if (scene.nodes.length === 0) return null;
  return { knownNodeCount: scene.nodes.length, residentNodeCount: resident.length, hierarchyComplete: true };
}

// ── Camera ────────────────────────────────────────────────────────────────

/** A top-down orthographic camera: centre, half-height of the view, height above the scene. */
const POSES: Record<PoseId, { cx: number; cy: number; halfH: number; height: number }> = {
  A: { cx: 40, cy: 20, halfH: 45, height: 120 },
  B: { cx: 33, cy: 27, halfH: 70, height: 200 },
};

function poseMatrices(pose: PoseId, aspect: number): { view: number[]; proj: number[] } {
  const { cx, cy, halfH, height } = POSES[pose];
  // matrixWorldInverse of a camera at (cx, cy, height) looking down -Z, up +Y.
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -cx, -cy, -height, 1];
  const t = halfH, b = -halfH, r = halfH * aspect, l = -r, n = 0.1, f = 1000;
  const proj = [
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ];
  return { view, proj };
}

// ── Results ───────────────────────────────────────────────────────────────

export interface DtmOutcome {
  readonly digest: string;
  /** The gather's declared basis. */
  readonly residentOnly: boolean;
  readonly sampled: boolean;
  readonly withheldExcluded: boolean | null;
  readonly withheldExcludedCount: number;
}

/** The terrain gather the Viewer runs, then the core, then the product digest. */
export function dtmOutcome(scene: FixtureScene, rp: ResolvedPresentation): DtmOutcome {
  const resident = residentNodes(scene, rp.streamingPointBudget);
  const staticBuffers: TerrainStreamBuffer[] = [{
    pos: scene.staticPatch.positions, cls: scene.staticPatch.classification, flags: scene.staticPatch.flags,
  }];
  const streamingBuffers: KeyedTerrainStreamBuffer[] = resident.map((n) => ({
    key: n.key, pos: n.patch.positions, cls: n.patch.classification, flags: n.patch.flags,
  }));
  let total = scene.staticPatch.positions.length / 3;
  let streamingPoints = 0;
  for (const b of streamingBuffers) { total += b.pos.length / 3; streamingPoints += b.pos.length / 3; }
  const sample = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 300_000, true);
  if (!sample) throw new Error('empty terrain gather');
  const core = computeTerrainCore(sample.positions, {
    cellSizeM: 2,
    crs: 'EPSG:32613',
    horizontalEpsg: 32613,
    classification: sample.classification,
  });
  // The Viewer's residency rule: resident-only while any streaming point is in
  // the walk and the resident set does not span every known node.
  const cov = coverageOf(scene, resident);
  const residentOnly = streamingPoints > 0 && !(cov && streamingIsComplete(cov) === true);
  return {
    digest: dtmProductDigest(core.dtm),
    residentOnly,
    sampled: sample.sampled,
    withheldExcluded: sample.withheldExcluded,
    withheldExcludedCount: sample.withheldExcludedCount,
  };
}

export interface StockpileOutcome {
  readonly digest: string;
  readonly record: VolumeRecord;
  readonly streamingContributed: boolean;
  readonly selectedCount: number;
  /** Highest selected elevation: a Withheld point would sit above WITHHELD_LIFT. */
  readonly maxSelectedZ: number;
}

/** Lasso footprint in world XY; projected to screen through the pose's camera. */
export const STATIC_LASSO_WORLD: ReadonlyArray<readonly [number, number]> = [
  [12.5, 12.5], [27.5, 12.5], [27.5, 27.5], [12.5, 27.5],
];
/** Straddles the static layer and the streamed neighbour. */
export const STRADDLE_LASSO_WORLD: ReadonlyArray<readonly [number, number]> = [
  [30.5, 10.5], [69.5, 10.5], [69.5, 29.5], [30.5, 29.5],
];

export function stockpileOutcome(
  scene: FixtureScene,
  rp: ResolvedPresentation,
  lassoWorld: ReadonlyArray<readonly [number, number]>,
): StockpileOutcome {
  const { view, proj } = poseMatrices(rp.pose, rp.cssWidth / rp.cssHeight);
  const project = makeLassoProjector(view, proj, rp.cssWidth, rp.cssHeight);
  const lasso = lassoWorld.map(([x, y]) => {
    const s = project(x, y, 0);
    if (!s) throw new Error('lasso vertex behind camera');
    return { x: s.x, y: s.y };
  });
  const resident = residentNodes(scene, rp.streamingPointBudget);
  const streamingParts: StreamingLassoPart[] = resident.map((n) => ({
    positions: n.patch.positions,
    flags: n.patch.flags,
    filters: (stride: number) => lassoVisibilityFilters(null, null, stride),
  }));
  const out = computeLassoVolume({
    host: {
      project,
      integrable: [['static', { cloud: scene.cloud, placement: null }]],
      streamingParts,
      wasReduced: () => false,
      visibilityFor: (_e, stride) => lassoVisibilityFilters(null, null, stride),
      worldUp: [0, 0, 1],
    },
    lasso,
    referencePercentile: 0.05,
  });
  if (!out) throw new Error('lasso selected nothing');
  const ps = deriveVolumeRecord(out.result, out.referenceZ, POINT_SAMPLE_VOLUME_METHOD);
  const { record } = lassoStockpileResult(ps, {
    polygon: out.polygon3D,
    positions: out.selectedPositions,
    lin: 1,
    withheld: out.withheld,
    options: {
      sourceReduced: out.anySourceReduced,
      densityUnitKnown: true,
      vert: 1,
      streamingContributed: out.streamingContributed,
      walkSampled: out.budget.downsample,
      streamingCoverage: coverageOf(scene, resident),
    },
  }, 1);
  const selection = [...out.selectionByCloudId.entries()].map(([id, idx]) => [id, [...idx]]);
  return {
    digest: digestOf({ record, selection, selectedCount: out.selectedCount, referenceZ: out.referenceZ }),
    record,
    streamingContributed: out.streamingContributed,
    selectedCount: out.selectedCount,
    maxSelectedZ: maxZ(out.selectedPositions),
  };
}

function maxZ(p: Float32Array): number {
  let m = -Infinity;
  for (let i = 2; i < p.length; i += 3) if (p[i] > m) m = p[i];
  return m;
}

export interface ProfileOutcome {
  readonly seriesDigest: string;
  readonly sectionDigest: string;
  readonly residentOnly: boolean;
  readonly sectionScope: string;
  readonly streamingComplete: boolean | null;
}

export const PROFILE_A: Vec3 = [2.3, 20.2, 0];
export const PROFILE_B: Vec3 = [77.7, 20.2, 0];

export function profileOutcome(scene: FixtureScene, rp: ResolvedPresentation): ProfileOutcome {
  const resident = residentNodes(scene, rp.streamingPointBudget);
  const layer: ProfileSeamLayer = {
    id: 'static',
    mesh: { visible: true },
    positions: scene.staticPatch.positions,
    channels: { classification: scene.staticPatch.classification },
    bounds: null,
  };
  const seam = createProfileSectionSeam({
    layers: () => [layer],
    residentNodes: (): ProfileSeamResidentNode[] => resident.map((n) => ({
      key: n.key, positions: n.patch.positions, channels: { classification: n.patch.classification },
    })),
    streamingMayCombine: () => true,
    worldUp: () => [0, 0, 1],
    streamingCoverage: () => coverageOf(scene, resident),
  });
  const series = seam.sampleSeries(PROFILE_A, PROFILE_B, { corridorWidth: 1.5 });
  const section = seam.section({ a: PROFILE_A, b: PROFILE_B, corridorWidth: 1.5 });
  if (!series || !section) throw new Error('profile produced nothing');
  return {
    seriesDigest: digestOf(series),
    sectionDigest: digestOf({ points: section.points, band: section.band, sources: section.sources }),
    residentOnly: series.residentOnly,
    sectionScope: section.scope,
    streamingComplete: section.streamingComplete,
  };
}

/** The scan report's Density row, verbatim. */
export function scanReportDensity(scene: FixtureScene): string {
  const row = scanReport.run(scene.cloud).rows.find((r) => r.label === 'Density');
  if (!row) throw new Error('no Density row');
  return `${row.status}:${row.value}`;
}
