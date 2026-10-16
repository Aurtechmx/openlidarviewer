/**
 * The ortho world file for a mounted layer. The camera frames each layer at
 * its placed (project-frame) position, local + sourceToProject, so the world
 * coordinate of a framed point is projectOrigin + p, where projectOrigin =
 * sourceOrigin - sourceToProject. Two layers at (500000, 4000000) and
 * (501000, 4000500) share the project origin (500000, 4000000); layer B's
 * sourceToProject is (1000, 500, 0).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildExportAdapter, type ExportAdapterCloud, type ExportAdapterHost } from '../src/render/exportAdapter';
import { chooseProjectOrigin, createProjectFrame, layerTransform } from '../src/geo/ProjectSpatialFrame';
import { frameTopDownOrtho } from '../src/render/export/orthoFraming';
import { buildWorldFileText } from '../src/render/export/pngWorldFile';

const oA: [number, number, number] = [500000, 4000000, 0];
const oB: [number, number, number] = [501000, 4000500, 0];

function entry(origin: number[], visible: boolean, placement: unknown, epsg = 32611): ExportAdapterCloud {
  return {
    mode: 'rgb',
    visible,
    placement,
    cloud: {
      name: 's', pointCount: 10, metadata: { crs: { epsg, wkt: 'WKT' } },
      bounds: () => ({ min: [0, 0, 0], max: [100, 50, 5] }),
      origin, sourceOrigin: origin,
    },
  } as unknown as ExportAdapterCloud;
}

function host(entries: Array<[string, ExportAdapterCloud]>): ExportAdapterHost {
  return {
    clouds: () => new Map(entries),
    streaming: () => null,
    setColorMode: vi.fn(), setStreamingColorMode: vi.fn(), setVisible: vi.fn(),
    snapshot: vi.fn(async () => new Blob()),
    renderFramedTopDown: vi.fn(async () => null),
    renderFigure: vi.fn(async () => null),
    figureViewContext: vi.fn(),
  } as unknown as ExportAdapterHost;
}

function worldFile(h: ExportAdapterHost): number[] {
  const a = buildExportAdapter(h);
  const framing = frameTopDownOrtho(a.localBoundsAabb()!, 200)!;
  const geo = a.georefContext!()!;
  const text = buildWorldFileText({
    extent: framing.extent, widthPx: framing.widthPx, heightPx: framing.heightPx, worldOrigin: geo.worldOrigin,
  });
  return text!.trim().split('\n').map(Number);
}

describe('ortho world file for a mounted layer', () => {
  const frame = createProjectFrame(chooseProjectOrigin([oA, oB]));
  const tA = layerTransform(frame, oA);
  const tB = layerTransform(frame, oB);

  it('places the upper-left pixel centre of layer B, exported alone, at its world coordinate', () => {
    expect(tB.sourceToProject).toEqual([1000, 500, 0]);
    const [pw, , , ph, c, f] = worldFile(host([['a', entry(oA, false, tA)], ['b', entry(oB, true, tB)]]));
    expect(c).toBeCloseTo(oB[0] + 0 + pw / 2, 6);
    expect(f).toBeCloseTo(oB[1] + 50 + ph / 2, 6);
  });

  it('georeferences both layers together in the shared project frame', () => {
    const a = buildExportAdapter(host([['a', entry(oA, true, tA)], ['b', entry(oB, true, tB)]]));
    expect(a.georefContext!()!.worldOrigin).toEqual({ x: 500000, y: 4000000 });
    const [pw, , , ph, c, f] = worldFile(host([['a', entry(oA, true, tA)], ['b', entry(oB, true, tB)]]));
    // West edge is layer A's (500000); north edge is layer B's (4000550).
    expect(c).toBeCloseTo(500000 + pw / 2, 6);
    expect(f).toBeCloseTo(4000550 + ph / 2, 6);
  });

  it('refuses when visible layers resolve to different project origins', () => {
    const a = buildExportAdapter(host([['a', entry(oA, true, tA)], ['b', entry(oB, true, undefined)]]));
    expect(a.georefContext!()).toBeNull();
  });
});
