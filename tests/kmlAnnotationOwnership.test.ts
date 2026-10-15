/**
 * The site KML places every feature through the ACTIVE scan's origin and CRS.
 * Measurements were already filtered by ownership; annotations were not, so an
 * annotation placed on a scan that is no longer open (or on another open scan)
 * was written at the active scan's lon/lat for its local coordinates, a
 * position it never had, with nothing in the file saying so.
 *
 * Annotations now go through the same fail-closed ownership policy as
 * measurements: placed only when the active scan owns them, otherwise withheld
 * and counted in the document. Ownership is read from the stable layer id in
 * `owner`, never from the display-name `layerId`.
 */
import { describe, it, expect } from 'vitest';
import { exportSiteKml, type KmlActionDeps } from '../src/app/kmlActions';
import * as kml from '../src/export/kmlExport';
import { resolveExportDigests } from '../src/export/exportDigests';
import type { Annotation } from '../src/render/annotate/types';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { OwnershipView } from '../src/app/measurementOwnership';

const WGS84: ResolvedCrs = {
  kind: 'geographic', epsg: 4326, name: 'WGS 84', source: 'las-vlr', confidence: 'high',
  userConfirmed: true, linearUnit: 'unknown', linearUnitToMetres: 1,
} as ResolvedCrs;

function note(title: string, local: [number, number, number], extra: Partial<Annotation> = {}): Annotation {
  return {
    id: title, title, type: 'issue', createdAt: 0, updatedAt: 0,
    localPosition: { x: local[0], y: local[1], z: local[2] }, ...extra,
  };
}

const ACTIVE_B: OwnershipView = { layers: [{ viewerId: 'b', stableId: 'stable-b', name: 'source-b.las' }], activeViewerId: 'b' };

async function run(
  annotations: Annotation[],
  view: OwnershipView = ACTIVE_B,
  sceneOffset: [number, number, number] | null = null,
): Promise<string> {
  const writes: { name: string; text: string }[] = [];
  const errors: string[] = [];
  const deps = {
    hasViewer: () => true, geo: () => ({ origin: [10, 20, 0], crsName: 'WGS 84', name: 'source-b.las' }),
    crsCurrent: () => WGS84, upAxis: () => 'z', isGeographic: () => true, layerCount: () => 1,
    sceneOffset: () => sceneOffset,
    annotations: () => annotations, measurements: () => [], viewpoints: () => [],
    worldUp: () => [0, 0, 1], unitToMetres: () => 1, scanExtent: () => null, scanHullPositions: () => null,
    measurementOwnership: () => view,
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''), setError: (s: string) => errors.push(s),
    downloadText: (name: string, text: string) => writes.push({ name, text }),
    loadKmlExport: async () => ({ ...kml, resolveExportDigests }),
  } as unknown as KmlActionDeps;
  await exportSiteKml(deps);
  expect(errors).toEqual([]);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.name).toBe('source-b.kml');
  return writes[0]!.text;
}

describe('site KML annotation ownership', () => {
  it('withholds an annotation whose owning scan is closed instead of placing it through the active scan', async () => {
    // Before the fix this annotation was written at 11,22, the active scan's placement of (1, 2).
    const text = await run([note('ISSUE-ON-CLOSED-A', [1, 2, 3], {
      worldPosition: { x: -105, y: 36, z: 100 },
      owner: { layerId: 'stable-a', frame: 'source-local' }, layerId: 'source-a.las', crs: 'EPSG:4326',
    })]);
    expect(text).not.toContain('ISSUE-ON-CLOSED-A');
    expect(text).not.toContain('<coordinates>11,22</coordinates>');
    expect(text).toContain('1 annotation withheld: placed on a scan that is no longer open');
  });

  it('withholds an annotation placed on another open scan and names that scan', async () => {
    const view: OwnershipView = {
      layers: [...ACTIVE_B.layers, { viewerId: 'a', stableId: 'stable-a', name: 'source-a.las' }],
      activeViewerId: 'b',
    };
    const text = await run([note('ON-A', [1, 2, 3], { owner: { layerId: 'stable-a', frame: 'project' } })], view);
    expect(text).not.toContain('ON-A');
    expect(text).toContain('1 annotation withheld: placed on source-a.las');
  });

  it('withholds an annotation whose owner more than one open layer matches', async () => {
    const view: OwnershipView = {
      layers: [...ACTIVE_B.layers, { viewerId: 'b2', stableId: 'stable-b', name: 'copy.las' }],
      activeViewerId: 'b',
    };
    const text = await run([note('TWIN', [1, 2, 3], { owner: { layerId: 'stable-b', frame: 'project' } })], view);
    expect(text).not.toContain('TWIN');
    expect(text).toContain('1 annotation withheld: naming a scan that more than one open scan matches');
  });

  it('does not treat the display-name layerId as ownership', async () => {
    // The label matches the active scan's file name; the stable owner does not.
    const text = await run([note('SAME-NAME', [1, 2, 3], {
      layerId: 'source-b.las', owner: { layerId: 'stable-other', frame: 'project' },
    })]);
    expect(text).not.toContain('SAME-NAME');
    expect(text).toContain('annotation withheld');
  });

  it('withholds an unowned annotation while several scans are open', async () => {
    const view: OwnershipView = {
      layers: [...ACTIVE_B.layers, { viewerId: 'a', stableId: 'stable-a', name: 'source-a.las' }],
      activeViewerId: 'b',
    };
    const text = await run([note('NO-OWNER', [1, 2, 3])], view);
    expect(text).not.toContain('NO-OWNER');
    expect(text).toContain('with no record of the scan they were placed on');
  });

  it('places an annotation the active scan owns in the project frame, undoing the placement', async () => {
    const text = await run([note('PROJECT', [6, 7, 3], { owner: { layerId: 'stable-b', frame: 'project' } })], ACTIVE_B, [5, 5, 0]);
    expect(text).toContain('<name>PROJECT</name>');
    expect(text).toContain('<coordinates>11,22</coordinates>');
    expect(text).not.toContain('withheld');
  });

  it('places a source-local annotation the active scan owns in its own file frame, without the placement shift', async () => {
    const text = await run([note('SOURCE-LOCAL', [1, 2, 3], { owner: { layerId: 'stable-b', frame: 'source-local' } })], ACTIVE_B, [5, 5, 0]);
    expect(text).toContain('<name>SOURCE-LOCAL</name>');
    expect(text).toContain('<coordinates>11,22</coordinates>');
    expect(text).not.toContain('withheld');
  });

  it('places an unowned annotation when the active scan is the only one open', async () => {
    const text = await run([note('SOLE', [1, 2, 3])]);
    expect(text).toContain('<coordinates>11,22</coordinates>');
    expect(text).not.toContain('withheld');
  });

  it('counts each reason when annotations are withheld for several', async () => {
    const text = await run([
      note('KEEP', [1, 2, 3], { owner: { layerId: 'stable-b', frame: 'project' } }),
      note('GONE-1', [1, 2, 3], { owner: { layerId: 'stable-a', frame: 'project' } }),
      note('GONE-2', [1, 2, 3], { owner: { layerId: 'stable-z', frame: 'source-local' } }),
    ]);
    expect(text).toContain('<name>KEEP</name>');
    expect(text).toContain('2 annotations withheld: placed on a scan that is no longer open');
  });
});
