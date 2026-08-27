/**
 * legacyBaselineScenario.ts
 *
 * Deterministic streaming inputs for the recorded scheduler baseline: one
 * fixture per format the scheduler drives today (COPC, EPT, the OLV tile
 * store), plus a scripted camera path each of them is driven along.
 *
 * Everything here is a function of a fixed seed and IEEE-754 basic arithmetic,
 * so the three sources, their hierarchies, their point counts and the camera
 * steps are identical on every run and every machine. No clock is read, no
 * random number is drawn, and no iteration order of a hash container reaches an
 * output.
 *
 * The camera path is expressed in units of each source's own local cube, so a
 * 256 m COPC cube and a 100 m EPT cube are swept through the same shaped
 * motion. That is what makes one recorded trace comparable across formats: the
 * radii differ, the sequence of scheduler situations does not.
 *
 * The EPT fixture is built here rather than read from `tests/fixtures/ept-tiny`,
 * which holds a single root node — enough for a decode test, far too small for
 * a scheduler to select, defer, protect or evict anything. This one is a four
 * level hierarchy served entirely from one root hierarchy file, so the octree
 * finishes loading inside the first-paint budget and no background deepening
 * runs concurrently with the recording.
 *
 * Pure Node: no DOM, no three.js, no network.
 */

import { StreamingPointCloud } from '../../../src/render/streaming/StreamingPointCloud';
import { EptStreamingPointCloud } from '../../../src/render/streaming/EptStreamingPointCloud';
import type { EptTransport } from '../../../src/render/streaming/EptStreamingPointCloud';
import { ArrayBufferRangeSource } from '../../../src/io/range/ArrayBufferRangeSource';
import { parseEptMetadata } from '../../../src/io/ept/eptDetect';
import { writeLas14 } from '../../../src/convert/writeLas';
import type { GlobalPoints } from '../../../src/convert/globalPoints';
import { indexOutOfCore, type SpillStore } from '../../../src/io/heavy/oocIndexer';
import { openSlicedLasSource } from '../../../src/io/heavy/slicedLasSource';
import {
  buildTileStore,
  parseHierarchy,
  parseTileManifest,
  TileStoreReader,
} from '../../../src/io/heavy/tileStore';
import { OlvTileSource, type TileBytesReader } from '../../../src/io/heavy/OlvTileSource';
import type { StreamingSource } from '../../../src/render/streaming/StreamingSource';
import type { StreamingBudgets } from '../../../src/render/streaming/streamingBudget';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../../../src/io/copc/copcChunkDecode';
import { buildSyntheticCopc, type SynthNode } from '../copc/synthCopc';
import { mulberry32, lookAtView, perspective, multiply4 } from '../v055/cameraPath';

/** The one seed every generated hierarchy below draws from. */
export const SCENARIO_SEED = 20260823;

/**
 * An instant decoder that fabricates a chunk of the hierarchy's declared size.
 * The recorded baseline is about scheduling decisions, so the bytes never
 * matter; what matters is that a decode resolves in a fixed number of
 * microtasks, which is what makes the drain below terminate identically.
 */
export const instantDecoder: ChunkDecoder = {
  decode(_chunk: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> {
    return Promise.resolve({
      pointCount: meta.pointCount,
      positions: new Float32Array(meta.pointCount * 3),
      intensity: new Uint16Array(meta.pointCount),
      classification: new Uint8Array(meta.pointCount),
      returnNumber: new Uint8Array(meta.pointCount),
      returnCount: new Uint8Array(meta.pointCount),
      gpsTime: new Float64Array(meta.pointCount),
    });
  },
};

// ── The scripted camera path ────────────────────────────────────────────────

/** One tick of the scripted path. */
export interface ScenarioStep {
  phase: 'orbit' | 'dolly' | 'rotate-fast' | 'settle' | 'retreat';
  /** Mock wall-clock time handed to the scheduler's injected `now`. */
  tMs: number;
  cameraPosition: [number, number, number];
  viewProjection: number[];
  /**
   * Fraction of the fixture's point budget in force for this tick. The recorder
   * calls `setBudgets` when it changes, which is what a quality-preset drop
   * does live.
   */
  budgetFactor: number;
}

const FOV = (60 * Math.PI) / 180;
const ASPECT = 16 / 9;
const NEAR = 0.1;

function step(
  phase: ScenarioStep['phase'],
  tMs: number,
  centre: readonly [number, number, number],
  offset: readonly [number, number, number],
  far: number,
  budgetFactor = 1,
  lookAt?: readonly [number, number, number],
): ScenarioStep {
  const eye: [number, number, number] = [
    centre[0] + offset[0],
    centre[1] + offset[1],
    centre[2] + offset[2],
  ];
  const vp = multiply4(
    perspective(FOV, ASPECT, NEAR, far),
    lookAtView(eye, lookAt ?? centre, [0, 0, 1]),
  );
  return { phase, tMs, cameraPosition: eye, viewProjection: vp, budgetFactor };
}

/**
 * The scripted path, expressed as an offset from a source's own local cube
 * centre and scaled by its half-span. Aiming at the centre rather than at the
 * local origin is what lets one path serve all three fixtures: a COPC cube sits
 * on the render origin, an OLV tile store's cube starts at it, and a path aimed
 * at the origin would look at the corner of the second and cull the whole scan.
 *
 *   orbit        8 ticks, 300 ms apart — a full turn at 2.6 × half-span.
 *   dolly        5 ticks, 300 ms apart — exponential approach 2.6 → 0.5, which
 *                ends inside the cube, so the frustum culls most of it.
 *   rotate-fast  5 ticks,  60 ms apart — 45°/tick close in, so the velocity
 *                regulators engage and the concurrent-decode budget halves.
 *   settle       6 ticks, 500 ms apart — stationary, well past the 250 ms
 *                settle window and past the 2 s eviction defer window, so both
 *                the stable fast path and lapsed eviction are exercised.
 *   retreat      4 ticks, 1500 ms apart — the camera turns its back on the
 *                scan and the point budget collapses to a tenth, which is what
 *                a quality-preset drop does. Nothing is wanted, everything
 *                resident has lapsed, and the shortfall is larger than the
 *                whole resident set, so the lapsed pass has to walk its entire
 *                candidate list. That is the only situation in which ancestor
 *                protection decides anything: while a coarse node is still
 *                selected it is never a deferred-eviction candidate at all, so
 *                a scenario that never collapses the budget records the
 *                protection set without ever recording it changing an outcome.
 */
export function scenarioCameraPath(
  halfSpan: number,
  centre: readonly [number, number, number],
): ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  const far = halfSpan * 40;
  let t = 0;

  const FAR_R = 2.6;
  const NEAR_R = 0.5;
  for (let i = 0; i < 8; i++) {
    const az = (i * 2 * Math.PI) / 8;
    const r = halfSpan * FAR_R;
    steps.push(step('orbit', t, centre, [r * Math.cos(az), r * Math.sin(az), r * 0.4], far));
    t += 300;
  }
  for (let i = 0; i < 5; i++) {
    const r = halfSpan * FAR_R * Math.pow(NEAR_R / FAR_R, i / 4);
    steps.push(step('dolly', t, centre, [r, 0, r * 0.4], far));
    t += 300;
  }
  for (let i = 1; i <= 5; i++) {
    const az = (i * Math.PI) / 4;
    const r = halfSpan * NEAR_R;
    steps.push(step('rotate-fast', t, centre, [r * Math.cos(az), r * Math.sin(az), r * 0.3], far));
    t += 60;
  }
  const last = steps[steps.length - 1];
  const lastOffset: [number, number, number] = [
    last.cameraPosition[0] - centre[0],
    last.cameraPosition[1] - centre[1],
    last.cameraPosition[2] - centre[2],
  ];
  for (let i = 0; i < 6; i++) {
    steps.push(step('settle', t, centre, lastOffset, far));
    t += 500;
  }

  const away = halfSpan * 8;
  for (let i = 0; i < 4; i++) {
    steps.push(
      step('retreat', t, centre, [away, 0, 0], far, 0.1, [
        centre[0] + away * 2,
        centre[1],
        centre[2],
      ]),
    );
    t += 1_500;
  }
  return steps;
}

// ── Fixture 1: COPC ─────────────────────────────────────────────────────────

/** Root, all eight depth-1 octants, and a seeded subset of depth 2 and 3. */
export function copcScenarioNodes(seed = SCENARIO_SEED): SynthNode[] {
  const rand = mulberry32(seed);
  const nodes: SynthNode[] = [{ key: [0, 0, 0, 0], pointCount: 260 }];
  for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      for (let z = 0; z <= 1; z++) {
        nodes.push({ key: [1, x, y, z], pointCount: 160 + Math.floor(rand() * 90) });
      }
    }
  }
  const depth2: [number, number, number][] = [];
  for (let x = 0; x <= 3; x++) {
    for (let y = 0; y <= 3; y++) {
      for (let z = 0; z <= 3; z++) {
        if (rand() < 0.45) {
          depth2.push([x, y, z]);
          nodes.push({ key: [2, x, y, z], pointCount: 120 + Math.floor(rand() * 90) });
        }
      }
    }
  }
  for (const [px, py, pz] of depth2) {
    for (let dx = 0; dx <= 1; dx++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dz = 0; dz <= 1; dz++) {
          if (rand() < 0.35) {
            nodes.push({
              key: [3, px * 2 + dx, py * 2 + dy, pz * 2 + dz],
              pointCount: 70 + Math.floor(rand() * 70),
            });
          }
        }
      }
    }
  }
  return nodes;
}

async function openCopcScenario(): Promise<StreamingSource> {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: copcScenarioNodes(),
  });
  return StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'legacy-baseline.copc.laz',
  );
}

// ── Fixture 2: EPT ──────────────────────────────────────────────────────────

const EPT_CUBE_MIN = [500_000, 500_000, 1_400] as const;
const EPT_CUBE_SIDE = 256;
/** Bytes per point for the fixture schema below: X/Y/Z int32 + intensity + class. */
const EPT_STRIDE = 15;

/** `ept.json` for the generated dataset, as the manifest parser reads it. */
function eptManifestJson(points: number): string {
  const [x0, y0, z0] = EPT_CUBE_MIN;
  const cube = [x0, y0, z0, x0 + EPT_CUBE_SIDE, y0 + EPT_CUBE_SIDE, z0 + EPT_CUBE_SIDE];
  const conforming = [x0 + 8, y0 + 8, z0 + 8, x0 + EPT_CUBE_SIDE - 8, y0 + EPT_CUBE_SIDE - 8, z0 + 40];
  return JSON.stringify({
    version: '1.1.0',
    dataType: 'binary',
    hierarchyType: 'json',
    points,
    span: 128,
    schema: [
      { name: 'X', size: 4, type: 'signed', scale: 0.001, offset: 0 },
      { name: 'Y', size: 4, type: 'signed', scale: 0.001, offset: 0 },
      { name: 'Z', size: 4, type: 'signed', scale: 0.001, offset: 0 },
      { name: 'Intensity', size: 2, type: 'unsigned' },
      { name: 'Classification', size: 1, type: 'unsigned' },
    ],
    bounds: cube,
    boundsConforming: conforming,
  });
}

/**
 * One root hierarchy file holding the whole tree. Kept to a single file on
 * purpose: a linked sub-file would be fetched by the background deepening walk
 * that `open` starts, and a hierarchy still growing while the scheduler runs is
 * not a fixed input.
 */
export function eptScenarioHierarchy(seed = SCENARIO_SEED): Record<string, number> {
  const rand = mulberry32(seed);
  const entries: Record<string, number> = { '0-0-0-0': 240 };
  for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      for (let z = 0; z <= 1; z++) {
        entries[`1-${x}-${y}-${z}`] = 150 + Math.floor(rand() * 80);
      }
    }
  }
  const depth2: [number, number, number][] = [];
  for (let x = 0; x <= 3; x++) {
    for (let y = 0; y <= 3; y++) {
      for (let z = 0; z <= 3; z++) {
        if (rand() < 0.45) {
          depth2.push([x, y, z]);
          entries[`2-${x}-${y}-${z}`] = 110 + Math.floor(rand() * 80);
        }
      }
    }
  }
  for (const [px, py, pz] of depth2) {
    for (let dx = 0; dx <= 1; dx++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dz = 0; dz <= 1; dz++) {
          if (rand() < 0.35) {
            entries[`3-${px * 2 + dx}-${py * 2 + dy}-${pz * 2 + dz}`] =
              60 + Math.floor(rand() * 60);
          }
        }
      }
    }
  }
  return entries;
}

async function openEptScenario(): Promise<StreamingSource> {
  const hierarchy = eptScenarioHierarchy();
  const total = Object.values(hierarchy).reduce((s, n) => s + n, 0);
  const parsed = parseEptMetadata(eptManifestJson(total));
  if (!parsed.isEpt) throw new Error('generated EPT manifest failed to parse');
  const hierarchyText = JSON.stringify(hierarchy);
  const transport: EptTransport = {
    fetchText: (url) => {
      if (url.endsWith('ept-hierarchy/0-0-0-0.json')) return Promise.resolve(hierarchyText);
      return Promise.reject(new Error(`unexpected hierarchy fetch: ${url}`));
    },
    fetchBytes: (url) => {
      const id = url.slice(url.lastIndexOf('/') + 1).replace(/\.bin$/, '');
      const count = hierarchy[id];
      if (count === undefined) return Promise.reject(new Error(`unknown tile: ${url}`));
      return Promise.resolve(new ArrayBuffer(count * EPT_STRIDE));
    },
  };
  return EptStreamingPointCloud.open(
    parsed.metadata,
    'fixture://legacy-baseline-ept/',
    'legacy-baseline.ept',
    transport,
  );
}

// ── Fixture 3: the OLV tile store ───────────────────────────────────────────

function memorySpill(): SpillStore {
  const parts = new Map<string, Uint8Array[]>();
  return {
    async append(key, bytes) {
      (parts.get(key) ?? parts.set(key, []).get(key)!).push(bytes.slice());
    },
    async read(key) {
      const arr = parts.get(key) ?? [];
      const out = new Uint8Array(arr.reduce((n, b) => n + b.byteLength, 0));
      let o = 0;
      for (const b of arr) {
        out.set(b, o);
        o += b.byteLength;
      }
      return out;
    },
    async keys() {
      return [...parts.keys()];
    },
  };
}

/** A gridded scan whose vertical span is much shallower than its footprint. */
function tileScenarioPoints(n: number): GlobalPoints {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  const classification = new Uint8Array(n);
  const pointSourceId = new Uint16Array(n);
  const gpsTime = new Float64Array(n);
  const colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    x[i] = 500_000 + (i % 200) * 1.25;
    y[i] = 4_100_000 + Math.floor(i / 200) * 1.25;
    z[i] = 190 + (i % 11) * 0.5;
    intensity[i] = i & 0xffff;
    returnNumber[i] = 1;
    returnCount[i] = 1;
    classification[i] = 2;
    pointSourceId[i] = 5;
    gpsTime[i] = 500 + i * 0.01;
    colors[i * 3] = i & 0xff;
    colors[i * 3 + 1] = (i >> 8) & 0xff;
    colors[i * 3 + 2] = 9;
  }
  return { count: n, x, y, z, intensity, returnNumber, returnCount, classification, pointSourceId, gpsTime, colors };
}

async function openTileScenario(): Promise<StreamingSource> {
  const bytes = writeLas14(tileScenarioPoints(40_000));
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const las = await openSlicedLasSource(new ArrayBufferRangeSource(ab));
  const spill = memorySpill();
  const index = await indexOutOfCore(las.source, spill, {
    pointsPerLeaf: 250,
    maxDepth: 4,
    memoryBudgetBytes: 64 * 1024,
  });
  const { manifestJson, hierarchy } = buildTileStore(index, las.schema, las.origin);
  // The build origin is carried through as the build measured it. It used to be
  // folded to zero here, from a time when `OlvTileOctree` recorded each node's
  // cube in the store's own local frame while `OlvTileSource` reported the world
  // recentring origin as its `renderOrigin`: the scheduler subtracted the origin
  // from bounds that had never had it added, so a UTM build moved the hierarchy
  // hundreds of kilometres and every node scored zero. Zeroing hid that by making
  // the two frames agree by accident.
  //
  // Node bounds are world now, so the frames agree on their own and the recorded
  // document is byte-identical either way. Keeping a real origin is what makes
  // this fixture able to fail: with it zeroed, local and world are the same
  // numbers and a reintroduced double-shift records an identical scheduler.
  const reader = new TileStoreReader(
    parseTileManifest(JSON.parse(manifestJson)),
    parseHierarchy(hierarchy),
  );
  const tiles: TileBytesReader = { read: (key) => spill.read(key) };
  return new OlvTileSource({
    id: 'legacy-baseline-tiles',
    name: 'legacy-baseline.las',
    store: reader,
    tiles,
  });
}

// ── The fixture set ─────────────────────────────────────────────────────────

/** One recorded fixture: a source, the budgets it runs under, and a label. */
export interface ScenarioFixture {
  /** Stable key in the recorded document. */
  readonly id: 'copc' | 'ept' | 'tiles';
  readonly budgets: StreamingBudgets;
  open(): Promise<StreamingSource>;
}

/**
 * Point budgets small enough that selection actually chooses. A budget above a
 * fixture's source total would record a scheduler that never dropped anything,
 * which pins none of the behaviour this baseline exists to hold still.
 */
export const SCENARIO_FIXTURES: readonly ScenarioFixture[] = [
  {
    id: 'copc',
    budgets: { pointBudget: 2_200, maxConcurrentDecodes: 4, chunkCacheBytes: 8 * 1024 * 1024 },
    open: openCopcScenario,
  },
  {
    id: 'ept',
    budgets: { pointBudget: 1_900, maxConcurrentDecodes: 4, chunkCacheBytes: 8 * 1024 * 1024 },
    open: openEptScenario,
  },
  {
    id: 'tiles',
    budgets: { pointBudget: 2_600, maxConcurrentDecodes: 3, chunkCacheBytes: 4 * 1024 * 1024 },
    open: openTileScenario,
  },
];
