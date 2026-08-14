/**
 * kmlActionsFootprint.test.ts — the scan-area export as the shell actually
 * calls it, driven through `KmlActionDeps` with no DOM and no viewer.
 *
 * `scanFootprint.test.ts` pins the pure predicates. This file pins the wiring
 * around them, which is where a gate is most easily lost: a refusal that the
 * button reports but the export path skips is not a gate, and a Y-up scan that
 * reaches `footprintRectangleRing` has already been mis-measured by then. So
 * both the readiness check and the export are exercised, and the export is
 * asserted on what it WROTE — a refused export must produce no file at all,
 * not an empty one.
 */

import { describe, it, expect } from 'vitest';
import {
  scanFootprintStatus,
  exportScanFootprintKml,
  type KmlActionDeps,
  type ScanExtentReading,
} from '../src/app/kmlActions';
import { loadKmlExport } from '../src/lazyChunks';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const utm12: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};

const wgs84: ResolvedCrs = {
  ...utm12,
  kind: 'geographic',
  name: 'WGS 84',
  epsg: 4326,
  linearUnit: 'unknown',
};

/** A 1 km scan in UTM zone 12, in LOCAL coordinates about the origin below. */
const zUpReading: ScanExtentReading = {
  extent: { minX: 0, minY: 0, maxX: 1000, maxY: 800 },
  basis: 'the resident points',
  upAxis: 'z',
};

/** What was written and what was refused, per export attempt. */
interface Recorder {
  readonly files: { name: string; text: string }[];
  readonly errors: string[];
  readonly deps: KmlActionDeps;
}

function recorder(
  reading: ScanExtentReading | null,
  crs: ResolvedCrs | null = utm12,
  origin: readonly [number, number, number] = [500_000, 4_400_000, 0],
  hullPositions: Float32Array | null = null,
): Recorder {
  const files: { name: string; text: string }[] = [];
  const errors: string[] = [];
  const deps: KmlActionDeps = {
    hasViewer: () => true,
    geo: () => ({ origin, crsName: crs?.name, name: 'quarry-north.laz' }),
    crsCurrent: () => crs,
    annotations: () => [],
    measurements: () => [],
    viewpoints: () => [],
    worldUp: () => [0, 0, 1],
    unitToMetres: () => 1,
    scanExtent: () => reading,
    scanHullPositions: () => hullPositions,
    baseName: (name) => name.replace(/\.[^.]+$/, ''),
    downloadText: (name, text) => void files.push({ name, text }),
    setError: (message) => void errors.push(message),
    loadKmlExport,
  };
  return { files, errors, deps };
}

describe('scan-area export — a Z-up georeferenced scan still exports', () => {
  it('reports ready', () => {
    expect(scanFootprintStatus(recorder(zUpReading).deps)).toEqual({ ready: true, reason: '' });
  });

  it('writes one KML file and raises nothing', async () => {
    const r = recorder(zUpReading);
    await exportScanFootprintKml(r.deps);
    expect(r.errors).toEqual([]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].name).toBe('quarry-north-scan-area.kml');
    expect(r.files[0].text).toContain('<Polygon>');
    // The outline carries an explicit style, so Google Earth does not draw the
    // footprint as an opaque white block over the imagery.
    expect(r.files[0].text).toContain('<Style id="olv-area">');
    expect(r.files[0].text).toContain('<styleUrl>#olv-area</styleUrl>');
    expect(r.files[0].text).toContain('<PolyStyle>');
    expect(r.files[0].text).not.toContain('ffffffff');
  });
});

describe('scan-area export — resident points back the true outline', () => {
  // A diamond inside the 1 km extent: its hull is the four tips, tighter than the
  // bounding rectangle, and one interior point that must not reach the file.
  const diamond = new Float32Array([
    500, 0, 0, 1000, 400, 0, 500, 800, 0, 0, 400, 0, 500, 400, 0,
  ]);

  it('labels the file a point-cloud outline, not a bounding rectangle', async () => {
    const r = recorder(zUpReading, utm12, [500_000, 4_400_000, 0], diamond);
    await exportScanFootprintKml(r.deps);
    expect(r.errors).toEqual([]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].text).toContain('point-cloud outline');
    expect(r.files[0].text).not.toContain('bounding rectangle');
  });

  it('falls back to the bounding rectangle when no resident points are offered', async () => {
    const r = recorder(zUpReading, utm12, [500_000, 4_400_000, 0], null);
    await exportScanFootprintKml(r.deps);
    expect(r.files[0].text).toContain('bounding rectangle');
  });

  it('refuses rather than dropping to a rectangle when the hull is degenerate', async () => {
    // Collinear resident points enclose no area: the export stops, it does not
    // silently substitute the rectangle for a scan that has no honest outline.
    const line = new Float32Array([0, 0, 0, 10, 10, 0, 20, 20, 0]);
    const r = recorder(zUpReading, utm12, [500_000, 4_400_000, 0], line);
    await exportScanFootprintKml(r.deps);
    expect(r.files).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('Scan area export stopped.');
  });
});

/**
 * The extent arrives as minX/minY/maxX/maxY read straight off the cloud's
 * bounds. For a Y-up source those two axes are one horizontal axis and the
 * elevation axis, so the "footprint" is a vertical slice through the site — and
 * it renders in Google Earth as an ordinary rectangle, with no cue that the
 * area it claims was never measured on the ground plane.
 */
describe('scan-area export — a Y-up source is refused, not silently outlined', () => {
  const yUp: ScanExtentReading = { ...zUpReading, upAxis: 'y' };

  it('is not ready, and says why in terms of the up-axis', () => {
    const status = scanFootprintStatus(recorder(yUp).deps);
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/Y-up/i);
  });

  it('writes NO file when the export is invoked anyway', async () => {
    // The status gate is advisory — the click can arrive after the active scan
    // changes. The export must hold the line on its own.
    const r = recorder(yUp);
    await exportScanFootprintKml(r.deps);
    expect(r.files).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('Scan area export stopped.');
  });

  it('refuses an undetermined up-axis the same way', async () => {
    const r = recorder({ ...zUpReading, upAxis: 'unknown' });
    expect(scanFootprintStatus(r.deps).ready).toBe(false);
    await exportScanFootprintKml(r.deps);
    expect(r.files).toEqual([]);
  });
});

/**
 * The antimeridian case as the user meets it: a geographic scan whose stored
 * longitudes wrap, so the bounds are a perfectly ordinary min/max pair and the
 * rectangle between them spans 359.6°.
 */
describe('scan-area export — an antimeridian-crossing scan is refused', () => {
  const crossing: ScanExtentReading = {
    extent: { minX: -179.8, minY: -0.2, maxX: 179.8, maxY: 0.2 },
    basis: 'the resident points',
    upAxis: 'z',
  };

  it('writes no world-spanning polygon, and explains the crossing', async () => {
    const r = recorder(crossing, wgs84, [0, 0, 0]);
    await exportScanFootprintKml(r.deps);
    expect(r.files).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/antimeridian/i);
  });

  it('still exports the same scan once it no longer straddles ±180°', async () => {
    const r = recorder(
      { ...crossing, extent: { minX: 179.4, minY: -0.2, maxX: 179.8, maxY: 0.2 } },
      wgs84,
      [0, 0, 0],
    );
    await exportScanFootprintKml(r.deps);
    expect(r.errors).toEqual([]);
    expect(r.files).toHaveLength(1);
  });
});
