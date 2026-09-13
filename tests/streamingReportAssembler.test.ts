/**
 * streamingReportAssembler.test.ts
 *
 * `runStreamingModules` assembles the Scan Report rows for a streaming cloud
 * from the source's header, against the frame the caller supplies. It lived
 * inside the shell without a test; these pin what it says.
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { runStreamingModules, type StreamingReportCloud } from '../src/app/streamingScanReport';

const metreCrs = (): CrsInfo => ({
  source: 'epsg', name: 'WGS 84 / UTM zone 12N', epsg: 32612,
  linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false,
} as CrsInfo);

function cloud(over: Partial<StreamingReportCloud> = {}): StreamingReportCloud {
  return {
    kind: 'copc',
    name: 'tile.copc.laz',
    sourcePointCount: 1_250_000,
    metadata: {
      header: { min: [0, 0, 100], max: [1000, 1000, 238], pointDataRecordFormat: 6 },
      info: { spacing: 0.5 },
      captureSensor: 'sensor-x',
    },
    ...over,
  } as StreamingReportCloud;
}

const labels = (rows: { label: string }[]) => rows.map((r) => r.label);

describe('runStreamingModules', () => {
  it('leads with the source and the declaration basis, then the header facts', () => {
    const rows = runStreamingModules(cloud(), spatialContextFrom(metreCrs()));
    const l = labels(rows);
    expect(l[0]).toBe('Source');
    expect(l).toContain('Point format');
    expect(rows.find((r) => r.label === 'Point format')?.value).toBe('PDRF 6');
    expect(rows.find((r) => r.label === 'Source point count')?.value).toBe('1,250,000');
  });

  it('reports an absent total as absent, never as zero', () => {
    const rows = runStreamingModules(cloud({ sourcePointCount: null }), spatialContextFrom(metreCrs()));
    expect(rows.find((r) => r.label === 'Source point count')?.value).toBe('not stated by the source');
  });

  it('warns and withholds the metre claim when the frame carries no confirmed unit', () => {
    const rows = runStreamingModules(cloud(), spatialContextFrom(null));
    const units = rows.find((r) => r.label === 'Units');
    expect(units?.status).toBe('warn');
    expect(units?.value).toMatch(/unconfirmed/);
  });

  it('stamps header-derived figures as not class-scoped while a class filter is active', () => {
    const scoped = runStreamingModules(cloud(), spatialContextFrom(metreCrs()), true);
    const count = scoped.find((r) => r.label === 'Source point count');
    expect(count?.scope).toBeDefined();
    const unscoped = runStreamingModules(cloud(), spatialContextFrom(metreCrs()), false);
    expect(unscoped.find((r) => r.label === 'Source point count')?.scope).toBeUndefined();
  });
});
