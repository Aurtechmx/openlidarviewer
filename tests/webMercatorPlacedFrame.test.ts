/**
 * Web Mercator terrain analysis over layers placed in a project.
 *
 * The terrain gather returns project-local coordinates with each layer's
 * placement already applied. The latitude that sets the ground scale is the
 * project origin plus that coordinate, and the project origin is any layer's
 * source origin less its placement offset. Adding a layer's own origin to
 * project-local coordinates counts its offset twice and scales the run at the
 * wrong latitude. The same scene must give the same scale whichever layer is
 * active, whether the anchor is visible, and whichever way the source is up.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { webMercatorScaleBound } from '../src/terrain/ground/horizontalScale';

const yOf = (lat: number) => 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const crs = {
  kind: 'projected', epsg: 3857, name: 'WGS 84 / Pseudo-Mercator', linearUnit: 'metre',
  linearUnitToMetres: 1, verticalUnitToMetres: 1, source: 'las-vlr', confidence: 'high', userConfirmed: false,
} as const;
/** The project anchor's world northing, near 60 degrees. */
const PROJECT_Y = yOf(60);

beforeEach(() => clearTerrainCoreCache());

interface Layer {
  readonly id: string;
  /** Northing of this layer's source origin relative to the project anchor. */
  readonly offsetY: number;
  readonly visible: boolean;
}

/** A 10 m sloped square per visible layer, gathered in the project frame. */
function harness(layers: readonly Layer[], activeId: string, upAxis: 'z' | 'y' = 'z') {
  const points: number[] = [];
  for (const l of layers.filter((x) => x.visible)) {
    for (let x = 0; x < 10; x += 0.5) for (let y = 0; y < 10; y += 0.5) points.push(x, y + l.offsetY, 0.02 * x + 0.01 * y);
  }
  const positions = Float32Array.from(points);
  const byId = new Map(layers.map((l) => [l.id, l]));
  // A Z-up source keeps its northing on Y; a Y-up source stores it as -Z.
  const sourceVec = (northing: number): [number, number, number] => (upAxis === 'z' ? [0, northing, 0] : [0, 0, -northing]);
  const updates: unknown[] = [];
  const statuses: string[] = [];
  const viewer = {
    gatherTerrainPositions: () => ({
      positions, classification: undefined, groundIsDerived: false, residentOnly: false, sampled: false,
      totalPoints: positions.length / 3, withheldExcluded: true, withheldExcludedCount: 0, sourceUpAxis: upAxis,
    }),
    getCloud: (id: string) => ({
      sourceOrigin: sourceVec(PROJECT_Y + byId.get(id)!.offsetY),
      bounds: () => ({ min: [0, 0, 0], max: [9.5, 9.5, 0.285] }),
    }),
    layerProjectOffset: (id: string) => (byId.get(id)!.offsetY === 0 ? null : sourceVec(byId.get(id)!.offsetY)),
    terrainFrameIsSingleOrigin: () => layers.every((l) => l.offsetY === 0),
    clouds: () => layers.map((l) => l.id),
    streamingCloud: null,
  };
  const panel = {
    isVisible: () => true, setBusy: () => {}, setStatus: (s: string) => statuses.push(s),
    update: (r: unknown) => updates.push(r), setContourFrame: () => {},
  };
  const runner = createTerrainAnalysisRunner({
    getViewer: () => viewer as never,
    getAnalysePanel: () => panel as never,
    getActiveId: () => activeId,
    crsService: { current: () => crs, context: () => spatialContextFrom(crs), crsRevision: () => 0 },
  });
  // The true scale: the world northing range the gathered points cover.
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < positions.length; i += 3) { lo = Math.min(lo, positions[i]); hi = Math.max(hi, positions[i]); }
  const expected = webMercatorScaleBound(PROJECT_Y + lo, PROJECT_Y + hi).groundPerGrid;
  return { runner, updates, statuses, expected };
}

async function scaleOf(h: ReturnType<typeof harness>): Promise<number | null> {
  await h.runner.run();
  return h.runner.getLastGroundUnitToMetres();
}

describe('Web Mercator scale over placed layers', () => {
  it('an unplaced layer is scaled at its real northing', async () => {
    const h = harness([{ id: 'a', offsetY: 0, visible: true }], 'a');
    expect(await scaleOf(h)).toBeCloseTo(h.expected, 10);
    expect(h.updates.length).toBe(1);
  });

  for (const offsetY of [50_000, -50_000]) {
    it(`a layer placed ${offsetY > 0 ? 'north' : 'south'} of the anchor is scaled at its project northing`, async () => {
      const h = harness([{ id: 'anchor', offsetY: 0, visible: true }, { id: 'p', offsetY, visible: true }], 'p');
      const s = await scaleOf(h);
      expect(s).not.toBeNull();
      expect(Math.abs(s! / h.expected - 1)).toBeLessThan(1e-8);
    });
  }

  it('one visible placed layer beside a hidden anchor is scaled at its project northing', async () => {
    const h = harness([{ id: 'anchor', offsetY: 0, visible: false }, { id: 'p', offsetY: 50_000, visible: true }], 'p');
    const s = await scaleOf(h);
    expect(Math.abs(s! / h.expected - 1)).toBeLessThan(1e-8);
  });

  it('the same scene gives the same scale whichever layer is active', async () => {
    const layers = [{ id: 'anchor', offsetY: 0, visible: true }, { id: 'p', offsetY: 30_000, visible: true }];
    const viaAnchor = await scaleOf(harness(layers, 'anchor'));
    clearTerrainCoreCache();
    const viaPlaced = await scaleOf(harness(layers, 'p'));
    expect(viaAnchor).not.toBeNull();
    expect(Math.abs(viaPlaced! / viaAnchor! - 1)).toBeLessThan(1e-12);
  });

  it('a Y-up source gives the same scale as the Z-up source of the same scene', async () => {
    const layers = [{ id: 'anchor', offsetY: 0, visible: false }, { id: 'p', offsetY: 50_000, visible: true }];
    const z = await scaleOf(harness(layers, 'p', 'z'));
    clearTerrainCoreCache();
    const y = await scaleOf(harness(layers, 'p', 'y'));
    expect(Math.abs(y! / z! - 1)).toBeLessThan(1e-12);
  });
});
