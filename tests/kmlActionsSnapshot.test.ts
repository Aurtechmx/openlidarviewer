/**
 * kmlActionsSnapshot.test.ts
 *
 * The site KML mixed two moments: the origin and CRS were read before the
 * serialiser import, everything the file actually contains — annotations,
 * measurements, saved views, the up vector and the unit scale — was read after
 * it. A dynamic import is usually warm, but "usually warm" is not a guarantee,
 * and the export has no reason to straddle it at all.
 *
 * This pins the ordering by resolving the import slowly and mutating the session
 * while it resolves: the written file must hold what the session held when the
 * export was requested, not a blend of both.
 */

import { describe, it, expect } from 'vitest';
import { exportSiteKml, type KmlActionDeps } from '../src/app/kmlActions';
import type { KmlExportInput } from '../src/export/kmlExport';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { Measurement } from '../src/render/measure/types';

/** A geographic frame, so the lon/lat mapper is a plain origin shift. */
const GEOGRAPHIC: ResolvedCrs = {
  kind: 'geographic',
  name: 'WGS 84',
  epsg: 4326,
  linearUnit: 'degree',
  linearUnitToMetres: 1,
  source: 'wkt',
  confidence: 'high',
  userConfirmed: true,
} as unknown as ResolvedCrs;

function measurement(id: string): Measurement {
  return { id, kind: 'distance', points: [[0, 0, 0], [1, 1, 1]] } as unknown as Measurement;
}

describe('exportSiteKml — one reading of the session, then the write', () => {
  it('writes the measurements the session held when the export was requested', async () => {
    // The session as it stands when the user presses Export.
    let measurements: Measurement[] = [measurement('m1')];
    let unitToMetres = 1;
    let built: KmlExportInput | null = null;
    const written: string[] = [];

    const deps = {
      hasViewer: () => true,
      geo: () => ({ origin: [0, 0, 0] as [number, number, number], crsName: 'WGS 84', name: 'site.las' }),
      crsCurrent: () => GEOGRAPHIC,
      upAxis: () => 'z',
      annotations: () => [],
      measurements: () => measurements,
      viewpoints: () => [],
      worldUp: () => [0, 0, 1] as [number, number, number],
      unitToMetres: () => unitToMetres,
      scanExtent: () => null,
      scanHullPositions: () => null,
      baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
      downloadText: (filename: string) => { written.push(filename); },
      setError: () => { /* not expected here */ },
      // The serialiser import, resolving a turn later — and the user keeps
      // working while it does: a second measurement lands and the unit scale
      // changes. Neither belongs in the file that was already requested.
      loadKmlExport: async () => {
        await new Promise((r) => setTimeout(r, 0));
        measurements = [measurement('m1'), measurement('m2')];
        unitToMetres = 1000;
        return {
          buildKml: (input: KmlExportInput) => { built = input; return '<kml/>'; },
          KmlCoordinateError: class extends Error {},
        };
      },
    } as unknown as KmlActionDeps;

    await exportSiteKml(deps);

    expect(written).toEqual(['site.kml']);
    expect(built).not.toBeNull();
    const input = built as unknown as KmlExportInput;
    expect(input.measurements.map((m) => m.id)).toEqual(['m1']);
    expect(input.unitToMetres).toBe(1);
  });
});
