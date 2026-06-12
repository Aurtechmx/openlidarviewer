/**
 * pngWorldFile.test.ts — world-file (.pgw) + .prj sidecars for the Visual
 * Export Studio's top-down PNG rasters (workplan C4). All expectations are
 * hand-computed against the ESRI world-file definition: pixel sizes from
 * extent/pixels, C/F at the CENTRE of the top-left pixel, E negative.
 */

import { describe, it, expect } from 'vitest';
import {
  buildWorldFileText,
  buildStudioPngPackage,
} from '../src/render/export/pngWorldFile';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // bytes, not parsed

describe('buildWorldFileText', () => {
  it('hand-computed: 100×50 m extent on a 200×100 px raster with a UTM origin', () => {
    const pgw = buildWorldFileText({
      extent: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      widthPx: 200,
      heightPx: 100,
      worldOrigin: { x: 500000, y: 4100000 },
    });
    // A = 100/200 = 0.5; E = -(50/100) = -0.5;
    // C = 500000 + 0 + 0.5/2 = 500000.25 (centre of the top-left pixel);
    // F = 4100000 + 50 − 0.5/2 = 4100049.75.
    expect(pgw).toBe('0.5\n0\n0\n-0.5\n500000.25\n4100049.75\n');
  });

  it('local frame (no origin): coordinates stay local, structure identical', () => {
    const pgw = buildWorldFileText({
      extent: { minX: -10, minY: -20, maxX: 10, maxY: 20 },
      widthPx: 100,
      heightPx: 200,
    });
    // A = 20/100 = 0.2; E = -40/200 = -0.2; C = -10 + 0.1 = -9.9; F = 20 - 0.1.
    expect(pgw).toBe('0.2\n0\n0\n-0.2\n-9.9\n19.9\n');
  });

  it('refuses degenerate inputs rather than writing a lying sidecar', () => {
    const base = { widthPx: 100, heightPx: 100 };
    expect(buildWorldFileText({ ...base, extent: { minX: 0, minY: 0, maxX: 0, maxY: 10 } })).toBeNull();
    expect(buildWorldFileText({ ...base, extent: { minX: 0, minY: 0, maxX: Number.NaN, maxY: 10 } })).toBeNull();
    expect(buildWorldFileText({ extent: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, widthPx: 0, heightPx: 100 })).toBeNull();
    expect(buildWorldFileText({ extent: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, widthPx: 10.5, heightPx: 100 })).toBeNull();
  });
});

describe('buildStudioPngPackage', () => {
  const extent = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  const WKT = 'PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84"]]';

  it('bundles png + pgw + prj when CRS and world origin are both known', () => {
    const pkg = buildStudioPngPackage({
      basename: 'site-height',
      png: PNG,
      extent,
      widthPx: 200,
      heightPx: 100,
      worldOrigin: { x: 500000, y: 4100000 },
      wkt: WKT,
    });
    expect(pkg).not.toBeNull();
    expect(pkg!.filename).toBe('site-height.zip');
    expect(pkg!.georeferenced).toBe(true);
    // Store-only zip: entry names and text payloads are readable in the bytes.
    const raw = new TextDecoder('latin1').decode(pkg!.zip);
    expect(raw).toContain('site-height.png');
    expect(raw).toContain('site-height.pgw');
    expect(raw).toContain('site-height.prj');
    expect(raw).toContain('500000.25'); // the pgw payload itself
    expect(raw).toContain('UTM zone 11N'); // the prj payload
  });

  it('omits the .prj without a world origin — never a real CRS on local coords', () => {
    const pkg = buildStudioPngPackage({
      basename: 'local',
      png: PNG,
      extent,
      widthPx: 200,
      heightPx: 100,
      wkt: WKT, // CRS known but the frame is local → must NOT be stamped
    });
    expect(pkg).not.toBeNull();
    expect(pkg!.georeferenced).toBe(false);
    const raw = new TextDecoder('latin1').decode(pkg!.zip);
    expect(raw).toContain('local.pgw');
    expect(raw).not.toContain('local.prj');
  });

  it('returns null when no world file can be derived (host falls back to plain PNG)', () => {
    expect(
      buildStudioPngPackage({
        basename: 'x',
        png: PNG,
        extent: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        widthPx: 100,
        heightPx: 100,
      }),
    ).toBeNull();
  });
});
