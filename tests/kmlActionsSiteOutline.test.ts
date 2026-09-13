/**
 * kmlActionsSiteOutline.test.ts — the site KML with nothing placed.
 *
 * The site file used to need a measurement or annotation before the button
 * enabled, although the scan's outline was already available to the same
 * export. It now places the outline, so a georeferenced scan can be put on
 * the map before anything is measured, and a Y-up extent is left out rather
 * than drawn from the wrong pair of axes.
 */

import { describe, it, expect } from 'vitest';
import { siteKmlStatus, exportSiteKml, type KmlActionDeps, type ScanExtentReading } from '../src/app/kmlActions';
import { loadKmlExport } from '../src/lazyChunks';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const utm12: ResolvedCrs = {
  kind: 'projected', name: 'WGS 84 / UTM zone 12N', epsg: 32612,
  linearUnit: 'metre', linearUnitToMetres: 1, source: 'las-vlr', confidence: 'high', userConfirmed: false,
};

function recorder(reading: ScanExtentReading | null) {
  const files: { name: string; text: string }[] = [];
  const errors: string[] = [];
  const deps: KmlActionDeps = {
    hasViewer: () => true,
    geo: () => ({ origin: [500_000, 4_400_000, 0], crsName: utm12.name, name: 'quarry-north.laz' }),
    crsCurrent: () => utm12,
    upAxis: () => reading?.upAxis ?? 'z',
    annotations: () => [],
    measurements: () => [],
    viewpoints: () => [],
    worldUp: () => [0, 0, 1],
    unitToMetres: () => 1,
    scanExtent: () => reading,
    scanHullPositions: () => null,
    baseName: (name) => name.replace(/\.[^.]+$/, ''),
    downloadText: (name, text) => void files.push({ name, text }),
    setError: (message) => void errors.push(message),
    loadKmlExport,
  };
  return { files, errors, deps };
}

const zUp: ScanExtentReading = { extent: { minX: 0, minY: 0, maxX: 1000, maxY: 800 }, basis: 'the resident points', upAxis: 'z' };

describe('site KML with no measurement or annotation', () => {
  it('is ready when the scan has an extent to place', () => {
    expect(siteKmlStatus(recorder(zUp).deps)).toEqual({ ready: true, reason: '' });
  });

  it('is not ready when there is neither a feature nor an extent', () => {
    const s = siteKmlStatus(recorder(null).deps);
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/extent/);
  });

  it('writes the scan outline as a polygon placemark', async () => {
    const r = recorder(zUp);
    await exportSiteKml(r.deps);
    expect(r.errors).toEqual([]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].text).toContain('<name>Scan outline</name>');
    expect(r.files[0].text).toContain('<Polygon>');
    expect(r.files[0].text).toContain('the resident points');
  });

  it('omits the outline for a Y-up extent rather than drawing the wrong axes', async () => {
    const r = recorder({ ...zUp, upAxis: 'y' });
    // The site file itself is refused for a Y-up frame, as before.
    expect(siteKmlStatus(r.deps).ready).toBe(false);
  });
});
