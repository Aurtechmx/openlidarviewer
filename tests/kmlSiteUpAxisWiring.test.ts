/**
 * The resolved spatial context is built without a placement, so its up-axis is
 * 'unknown' for every scan. A frame gate that reads it raw refuses an ordinary
 * Z-up LAS (the Site KML button stayed disabled with "up-axis was not
 * determined"). The shell must resolve the axis through the per-layer frame
 * resolver (`activeSpatialUpAxis`, `geo/frame/layerUpFrame.ts`) every export
 * boundary uses: survey formats and LAS-derived streams settle to z, a PLY under
 * a CRS settles to z, a mesh with no CRS stays unknown and is refused.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activeSpatialUpAxis, type LayerFrameCrs } from '../src/app/layerUpFrames';
import { PointCloud } from '../src/model/PointCloud';
import type { SourceFormat } from '../src/io/sniffFormat';
import { lonLatUpAxisRefusal } from '../src/export/scanFootprint';

const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');

describe('shell up-axis wiring for frame gates', () => {
  it('never hands the raw context up-axis to a gate', () => {
    const raw = main.match(/crsService\.context\(\)\.upAxis/g) ?? [];
    expect(raw.length).toBe(0);
    expect(main).toMatch(/const activeUpAxis = \(\) => activeSpatialUpAxis\(/);
  });

  it('the Site KML deps and the coordinate HUD read the policy-resolved axis', () => {
    const kmlDeps = main.slice(main.indexOf('const kmlDeps: KmlActionDeps'), main.indexOf('loadKmlExport,', main.indexOf('const kmlDeps: KmlActionDeps')));
    expect(kmlDeps).toMatch(/upAxis: activeUpAxis/);
    const hud = main.slice(main.indexOf('onHoverInfo: lazyCoordinateHud'), main.indexOf('onHoverInfo: lazyCoordinateHud') + 300);
    expect(hud).toMatch(/upAxis: activeUpAxis/);
  });

  it('the policy admits a Z-up LAS, a streamed source and a PLY under a CRS, and still refuses an ambiguous mesh', () => {
    const crs = (kind: 'projected' | 'unknown', epsg?: number): LayerFrameCrs => ({
      current: () => ({ kind, epsg, name: epsg ? `EPSG:${epsg}` : 'Unknown' }) as never,
      context: () => ({}) as never,
      resolveFor: () => ({}) as never,
    });
    const axis = (format: SourceFormat | null, c: LayerFrameCrs, streaming = false) => activeSpatialUpAxis({
      activeCloud: () => (format ? new PointCloud({ positions: new Float32Array(3), origin: [0, 0, 0], sourceFormat: format, name: `a.${format}` }) : null),
      streaming: () => streaming,
      crs: c,
    });
    expect(lonLatUpAxisRefusal(axis('las', crs('unknown')))).toBeNull();
    expect(lonLatUpAxisRefusal(axis('laz', crs('unknown')))).toBeNull();
    expect(lonLatUpAxisRefusal(axis(null, crs('unknown'), true))).toBeNull();
    expect(lonLatUpAxisRefusal(axis('ply', crs('projected', 32613)))).toBeNull();
    expect(lonLatUpAxisRefusal(axis('ply', crs('unknown')))).toMatch(/up-axis was not determined/);
    expect(lonLatUpAxisRefusal(axis('glb', crs('projected', 32613)))).toMatch(/up-axis was not determined/);
  });
});
