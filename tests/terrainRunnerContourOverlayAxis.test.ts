/**
 * terrainRunnerContourOverlayAxis.test.ts
 *
 * The contour overlay is built for the up axis the terrain gather settled, not
 * for the scan's format. A PLY or OBJ under a horizontal CRS gathers Z-up and
 * unrotated, so its contours must be drawn unrotated: building them from the
 * format table (PLY -> Y-up) drew them rotated and mirrored over the scan.
 *
 * The run goes through the real runner; the drawn line buffer is read back from
 * the host the overlay attaches to. The plane has 20 m of northing and 0.5 m of
 * relief, so a vertical axis taken from the wrong place is unmistakable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as THREE from 'three/webgpu';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';
import { spatialContextFrom } from '../src/geo/SpatialContext';

// The Layers-panel list is DOM; the overlay frame is what this test is about.
vi.mock('../src/ui/DerivedLayersList', () => ({
  createDerivedLayersList: () => ({ element: {} }),
}));

function plane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 20; x += 1) {
    for (let y = 0; y <= 20; y += 1) pts.push(x, y, 0.025 * x);
  }
  return Float32Array.from(pts);
}

function fakePanel(): AnalysePanel {
  return {
    isVisible: () => true,
    setBusy: () => {},
    setStatus: () => {},
    update: () => {},
    setContourFrame: () => {},
    setDerivedLayersList: () => {},
    setContourLayerControls: () => {},
  } as unknown as AnalysePanel;
}

function fakeCrs(): CrsService {
  return {
    crsRevision: () => 0,
    current: () => null,
    context: () => spatialContextFrom(null),
  } as unknown as CrsService;
}

/** Run a PLY scan whose gather settled `sourceUpAxis`; return the drawn vertices. */
async function drawnVertices(sourceUpAxis: 'z' | 'y'): Promise<{ x: number[]; y: number[]; z: number[] }> {
  clearTerrainCoreCache();
  const added: THREE.Object3D[] = [];
  const positions = plane();
  const viewer = {
    gatherTerrainPositions: () => ({
      positions,
      classification: undefined,
      groundIsDerived: false,
      residentOnly: false,
      sampled: false,
      totalPoints: positions.length / 3,
      sourceUpAxis,
    }),
    clouds: () => ['scan-1'],
    getCloud: () => ({
      sourceFormat: 'ply',
      sourceOrigin: [0, 0, 0],
      bounds: () => ({ min: [0, 0, 0], max: [20, 20, 0.5] }),
    }),
    layerProjectOffset: () => null,
    streamingCloud: null,
    derivedLayerHost: () => ({
      add: (o: THREE.Object3D) => { added.push(o); },
      remove: () => {},
      requestFrame: () => {},
    }),
  } as unknown as Viewer;
  const runner = createTerrainAnalysisRunner({
    getViewer: () => viewer,
    getAnalysePanel: fakePanel,
    getActiveId: () => 'scan-1',
    crsService: fakeCrs(),
  });
  await runner.run(0.1);
  await vi.waitFor(() => expect(added.length).toBeGreaterThan(0), { timeout: 20_000 });
  const attr = (added[0] as THREE.LineSegments).geometry.getAttribute('position');
  const out = { x: [] as number[], y: [] as number[], z: [] as number[] };
  for (let i = 0; i < attr.count; i++) {
    out.x.push(attr.getX(i));
    out.y.push(attr.getY(i));
    out.z.push(attr.getZ(i));
  }
  return out;
}

describe('terrain runner contour overlay frame', { timeout: 120_000 }, () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warnSpy.mockRestore());

  it('a PLY gathered Z-up (georeferenced) is drawn unrotated: northing stays +Y, height stays Z', async () => {
    const v = await drawnVertices('z');
    expect(v.x.length).toBeGreaterThan(0);
    // Contours run along the 20 m northing and sit at heights up to 0.5 m.
    expect(Math.max(...v.y)).toBeGreaterThan(15);
    expect(Math.min(...v.y)).toBeGreaterThanOrEqual(-0.001);
    expect(Math.max(...v.z)).toBeLessThan(1);
  });

  it('a mesh the gather rotated from Y-up keeps the inverse rotation: height on Y, northing negated on Z', async () => {
    const v = await drawnVertices('y');
    expect(v.x.length).toBeGreaterThan(0);
    expect(Math.max(...v.y)).toBeLessThan(1);
    expect(Math.min(...v.z)).toBeLessThan(-15);
    expect(Math.max(...v.z)).toBeLessThanOrEqual(0.001);
  });
});
