/**
 * The site KML places a measurement through the active scan's origin, and
 * scene coordinates first undo the layer's placement offset. A measurement
 * whose owner records `source-local` coordinates is already in the file frame,
 * so it must be placed without that shift, as annotations are.
 */
import { describe, it, expect } from 'vitest';
import { exportSiteKml, type KmlActionDeps } from '../src/app/kmlActions';
import * as kml from '../src/export/kmlExport';
import { resolveExportDigests } from '../src/export/exportDigests';
import type { Measurement } from '../src/render/measure/types';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { OwnershipView } from '../src/app/measurementOwnership';

const WGS84: ResolvedCrs = {
  kind: 'geographic', epsg: 4326, name: 'WGS 84', source: 'las-vlr', confidence: 'high',
  userConfirmed: true, linearUnit: 'unknown', linearUnitToMetres: 1,
} as ResolvedCrs;

const ACTIVE_B: OwnershipView = { layers: [{ viewerId: 'b', stableId: 'stable-b', name: 'source-b.las' }], activeViewerId: 'b' };

async function run(measurements: Measurement[], sceneOffset: [number, number, number] | null): Promise<string> {
  const writes: string[] = [];
  const errors: string[] = [];
  const deps = {
    hasViewer: () => true, geo: () => ({ origin: [10, 20, 0], crsName: 'WGS 84', name: 'source-b.las' }),
    crsCurrent: () => WGS84, upAxis: () => 'z', isGeographic: () => true, layerCount: () => 1,
    sceneOffset: () => sceneOffset,
    annotations: () => [], measurements: () => measurements, viewpoints: () => [],
    worldUp: () => [0, 0, 1], unitToMetres: () => 1, scanExtent: () => null, scanHullPositions: () => null,
    measurementOwnership: () => ACTIVE_B,
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''), setError: (s: string) => errors.push(s),
    downloadText: (_name: string, text: string) => writes.push(text),
    loadKmlExport: async () => ({ ...kml, resolveExportDigests }),
  } as unknown as KmlActionDeps;
  await exportSiteKml(deps);
  expect(errors).toEqual([]);
  expect(writes).toHaveLength(1);
  return writes[0]!;
}

const line = (name: string, points: [number, number, number][], frame: 'source-local' | 'project'): Measurement =>
  ({ id: name, kind: 'distance', name, points, owner: { layerId: 'stable-b', frame } }) as Measurement;

const coordsOf = (text: string, name: string): string => {
  const at = text.indexOf(`<name>${name}</name>`);
  expect(at).toBeGreaterThan(-1);
  return /<coordinates>([^<]*)<\/coordinates>/.exec(text.slice(at))![1]!;
};

describe('site KML measurement owner frame', () => {
  it('places a source-local measurement on a placed sole layer at its file-frame position', async () => {
    const text = await run([line('LOCAL', [[1, 2, 3], [2, 3, 3]], 'source-local')], [5, 5, 0]);
    expect(coordsOf(text, 'LOCAL')).toMatch(/^11,22(,[-\d.]+)? 12,23(,[-\d.]+)?$/);
  });

  it('a project-frame measurement on the same layer still undoes the placement', async () => {
    const text = await run([line('PROJECT', [[6, 7, 3], [7, 8, 3]], 'project')], [5, 5, 0]);
    expect(coordsOf(text, 'PROJECT')).toMatch(/^11,22(,[-\d.]+)? 12,23(,[-\d.]+)?$/);
  });

  it('both frames land on the same place, and an unplaced layer is unchanged', async () => {
    const placed = await run([
      line('LOCAL', [[1, 2, 3], [2, 3, 3]], 'source-local'),
      line('PROJECT', [[6, 7, 3], [7, 8, 3]], 'project'),
    ], [5, 5, 0]);
    expect(coordsOf(placed, 'LOCAL')).toBe(coordsOf(placed, 'PROJECT'));
    const unplaced = await run([line('LOCAL', [[1, 2, 3], [2, 3, 3]], 'source-local')], null);
    expect(coordsOf(unplaced, 'LOCAL')).toBe(coordsOf(placed, 'LOCAL'));
  });
});
