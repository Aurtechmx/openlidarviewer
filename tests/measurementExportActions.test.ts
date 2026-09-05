// What these tests would catch:
//
//  - A measurement export written at render-frame coordinates. Measurement
//    points are local residuals; the export frame's origin has to be added back
//    or a UTM scan lands near (0, 0) in the output file.
//  - The export frame read after the serializer import resolves, so a scan swap
//    during the lazy import would pair one scan's origin with another's points.
//  - The units caveat dropped on a scan whose linear scale is unknown, which
//    labels render units as metres in both the GeoJSON note and the CSV
//    evidence column.
//  - An empty measurement set producing a download of an empty file rather than
//    no download at all.
//  - The vertical unit factor lost on the way to the serializer, which silently
//    reverts a compound CRS (metre eastings, foot heights) to one factor.
//  - The integrity report built with a live clock instead of the injected one,
//    which makes the signed report non-reproducible.

import { describe, it, expect, vi } from 'vitest';
import {
  exportMeasurementsFile,
  exportMeasurementIntegrityReport,
  type MeasurementExportActionDeps,
} from '../src/app/measurementExportActions';
import type { Measurement } from '../src/render/measure/types';
import type { MeasurementExportContext } from '../src/export/measurementExport';

function distance(id: string, a: [number, number, number], b: [number, number, number]): Measurement {
  return { id, kind: 'distance', name: `Distance ${id}`, points: [a, b] };
}

interface Recorded {
  deps: MeasurementExportActionDeps;
  downloads: Array<{ filename: string; text: string }>;
  geoJsonCalls: Array<{ measurements: readonly Measurement[]; ctx: MeasurementExportContext }>;
  csvCalls: Array<{ measurements: readonly Measurement[]; ctx: MeasurementExportContext }>;
  reportArgs: unknown[][];
  order: string[];
}

function deps(over: Partial<MeasurementExportActionDeps> = {}): Recorded {
  const downloads: Recorded['downloads'] = [];
  const geoJsonCalls: Recorded['geoJsonCalls'] = [];
  const csvCalls: Recorded['csvCalls'] = [];
  const reportArgs: unknown[][] = [];
  const order: string[] = [];

  const base: MeasurementExportActionDeps = {
    measure: {
      getMeasurements: () => [distance('m1', [1, 2, 3], [4, 5, 6])],
      worldUp: [0, 0, 1],
      unitToMetres: 1,
      verticalUnitToMetres: 1,
      crsKnown: true,
    geographicCrs: false,
    },
    geo: () => {
      order.push('geo');
      return { origin: [400_000, 3_800_000, 100], crsName: 'WGS 84 / UTM zone 12N', name: 'site/scan.laz' };
    },
    baseName: (n) => n.replace(/^.*\//, '').replace(/\.[^.]+$/, ''),
    downloadText: (filename, text) => {
      downloads.push({ filename, text });
    },
    loadMeasurementExport: async () => {
      order.push('import');
      return {
        measurementsToGeoJSON: (measurements, ctx) => {
          geoJsonCalls.push({ measurements, ctx });
          return '{"geojson":true}';
        },
        measurementsToCsv: (measurements, ctx) => {
          csvCalls.push({ measurements, ctx });
          return 'id,name\n';
        },
      };
    },
    loadMeasurementReport: async () => ({
      integrityReportFile: (...args: unknown[]) => {
        reportArgs.push(args);
        return { filename: 'scan-integrity.json', text: '{"report":true}' };
      },
    } as unknown as Awaited<ReturnType<MeasurementExportActionDeps['loadMeasurementReport']>>),
    activeClassificationEpoch: () => 7,
    appVersion: '0.6.6',
    now: () => '2026-01-02T03:04:05.000Z',
    ...over,
  };
  return { deps: base, downloads, geoJsonCalls, csvCalls, reportArgs, order };
}

describe('exportMeasurementsFile — landing local points in the source frame', () => {
  it('adds the export origin back, so a UTM scan exports at UTM coordinates', async () => {
    const r = deps();
    await exportMeasurementsFile('geojson', r.deps);
    const { toOutput } = r.geoJsonCalls[0].ctx;
    expect(toOutput([1, 2, 3])).toEqual([400_001, 3_800_002, 103]);
    // A missed origin would put this measurement at the projection's false
    // easting rather than on the survey.
    expect(toOutput([0, 0, 0])).toEqual([400_000, 3_800_000, 100]);
  });

  it('reads the export frame before the serializer import resolves', async () => {
    const r = deps();
    await exportMeasurementsFile('csv', r.deps);
    expect(r.order).toEqual(['geo', 'import']);
  });

  it('carries the CRS label and the up axis into the serializer context', async () => {
    const r = deps();
    await exportMeasurementsFile('geojson', r.deps);
    const ctx = r.geoJsonCalls[0].ctx;
    expect(ctx.crsName).toBe('WGS 84 / UTM zone 12N');
    expect(ctx.up).toEqual([0, 0, 1]);
    // The output frame is projected, never lon/lat, on this path.
    expect(ctx.geographic).toBe(false);
  });

  it('keeps a separate vertical factor for a compound CRS', async () => {
    const r = deps({
      measure: {
        getMeasurements: () => [distance('m1', [0, 0, 0], [10, 0, 0])],
        worldUp: [0, 0, 1],
        unitToMetres: 1,
        verticalUnitToMetres: 0.3048,
        crsKnown: true,
    geographicCrs: false,
      },
    });
    await exportMeasurementsFile('csv', r.deps);
    const ctx = r.csvCalls[0].ctx;
    expect(ctx.unitToMetres).toBe(1);
    expect(ctx.verticalUnitToMetres).toBeCloseTo(0.3048, 12);
  });

  it('marks units unverified when the scan has no known linear scale', async () => {
    const r = deps({
      measure: {
        getMeasurements: () => [distance('m1', [0, 0, 0], [1, 1, 1])],
        worldUp: [0, 1, 0],
        unitToMetres: 1,
        verticalUnitToMetres: 1,
        crsKnown: false,
    geographicCrs: false,
      },
    });
    await exportMeasurementsFile('geojson', r.deps);
    // The inert factor of 1 makes the metre columns nominal; the flag is what
    // makes the file say so.
    expect(r.geoJsonCalls[0].ctx.unitsVerified).toBe(false);
  });

  it('marks units verified when the scan resolves a real linear scale', async () => {
    const r = deps();
    await exportMeasurementsFile('geojson', r.deps);
    expect(r.geoJsonCalls[0].ctx.unitsVerified).toBe(true);
  });

  it('names the file after the scan, and both formats keep their own extension', async () => {
    const r = deps();
    await exportMeasurementsFile('geojson', r.deps);
    await exportMeasurementsFile('csv', r.deps);
    expect(r.downloads.map((d) => d.filename)).toEqual([
      'scan-measurements.geojson',
      'scan-measurements.csv',
    ]);
    expect(r.downloads[0].text).toBe('{"geojson":true}');
    expect(r.downloads[1].text).toBe('id,name\n');
  });

  it('falls back to a generic stem when the frame carries no scan name', async () => {
    const r = deps({
      geo: () => ({ origin: [0, 0, 0], crsName: undefined, name: null }),
    });
    await exportMeasurementsFile('csv', r.deps);
    expect(r.downloads[0].filename).toBe('measurements-measurements.csv');
  });

  it('downloads nothing at all when no measurement is placed', async () => {
    const load = vi.fn();
    const r = deps({
      measure: {
        getMeasurements: () => [],
        worldUp: [0, 0, 1],
        unitToMetres: 1,
        verticalUnitToMetres: 1,
        crsKnown: true,
    geographicCrs: false,
      },
      loadMeasurementExport: load as unknown as MeasurementExportActionDeps['loadMeasurementExport'],
    });
    await exportMeasurementsFile('geojson', r.deps);
    expect(r.downloads).toEqual([]);
    // The serializer chunk is not even fetched for an empty set.
    expect(load).not.toHaveBeenCalled();
  });
});

describe('exportMeasurementIntegrityReport — a reproducible signed report', () => {
  it('stamps the injected timestamp, epoch and app version rather than a live clock', async () => {
    const r = deps();
    await exportMeasurementIntegrityReport(r.deps);
    const args = r.reportArgs[0];
    expect(args[6]).toBe('2026-01-02T03:04:05.000Z');
    expect(args[7]).toBe(7);
    expect(args[8]).toBe('0.6.6');
  });

  it('passes the scan stem and resolved CRS label through to the report', async () => {
    const r = deps();
    await exportMeasurementIntegrityReport(r.deps);
    const args = r.reportArgs[0];
    expect(args[4]).toBe('scan');
    expect(args[5]).toBe('WGS 84 / UTM zone 12N');
    expect(r.downloads[0]).toEqual({ filename: 'scan-integrity.json', text: '{"report":true}' });
  });

  it('propagates the same units-verified verdict the file export uses', async () => {
    const r = deps({
      measure: {
        getMeasurements: () => [distance('m1', [0, 0, 0], [1, 0, 0])],
        worldUp: [0, 0, 1],
        unitToMetres: 1,
        verticalUnitToMetres: 1,
        crsKnown: false,
    geographicCrs: false,
      },
    });
    await exportMeasurementIntegrityReport(r.deps);
    expect(r.reportArgs[0][9]).toBe(false);
  });

  it('uses a generic stem when the frame carries no scan name', async () => {
    const r = deps({
      geo: () => ({ origin: [0, 0, 0], crsName: undefined, name: null }),
    });
    await exportMeasurementIntegrityReport(r.deps);
    expect(r.reportArgs[0][4]).toBe('scan');
  });

  it('produces no report when no measurement is placed', async () => {
    const r = deps({
      measure: {
        getMeasurements: () => [],
        worldUp: [0, 0, 1],
        unitToMetres: 1,
        verticalUnitToMetres: 1,
        crsKnown: true,
    geographicCrs: false,
      },
    });
    await exportMeasurementIntegrityReport(r.deps);
    expect(r.reportArgs).toEqual([]);
    expect(r.downloads).toEqual([]);
  });
});
