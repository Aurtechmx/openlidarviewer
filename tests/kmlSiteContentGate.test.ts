/**
 * The site KML button enables only when the file would hold something placed:
 * a measurement or an annotation the active scan owns, a saved view, or the
 * scan outline. Withheld work only adds a note saying it was withheld, so a
 * file holding nothing else is not offered, and the click refuses it too. The
 * one-open-scan rule is re-checked at the click as well as at the button.
 */
import { describe, it, expect } from 'vitest';
import { exportSiteKml, siteKmlStatus, type KmlActionDeps } from '../src/app/kmlActions';
import * as kml from '../src/export/kmlExport';
import { resolveExportDigests } from '../src/export/exportDigests';
import type { Annotation } from '../src/render/annotate/types';
import type { Measurement } from '../src/render/measure/types';
import type { KmlViewpoint } from '../src/export/kmlExport';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { OwnershipView } from '../src/app/measurementOwnership';

const WGS84: ResolvedCrs = {
  kind: 'geographic', epsg: 4326, name: 'WGS 84', source: 'las-vlr', confidence: 'high',
  userConfirmed: true, linearUnit: 'unknown', linearUnitToMetres: 1,
} as ResolvedCrs;

const ACTIVE_B: OwnershipView = { layers: [{ viewerId: 'b', stableId: 'stable-b', name: 'source-b.las' }], activeViewerId: 'b' };

const note = (title: string, owner: string): Annotation => ({
  id: title, title, type: 'issue', createdAt: 0, updatedAt: 0,
  localPosition: { x: 1, y: 2, z: 3 }, owner: { layerId: owner, frame: 'project' },
} as Annotation);

const line = (name: string, owner: string): Measurement =>
  ({ id: name, kind: 'distance', name, points: [[1, 2, 3], [2, 3, 3]], owner: { layerId: owner, frame: 'project' } }) as Measurement;

interface Work {
  annotations?: Annotation[];
  measurements?: Measurement[];
  viewpoints?: KmlViewpoint[];
  layerCount?: () => number;
}

function harness(w: Work) {
  const writes: string[] = [];
  const errors: string[] = [];
  const deps = {
    hasViewer: () => true, geo: () => ({ origin: [10, 20, 0], crsName: 'WGS 84', name: 'source-b.las' }),
    crsCurrent: () => WGS84, upAxis: () => 'z', isGeographic: () => true,
    layerCount: w.layerCount ?? (() => 1),
    sceneOffset: () => null,
    annotations: () => w.annotations ?? [], measurements: () => w.measurements ?? [], viewpoints: () => w.viewpoints ?? [],
    worldUp: () => [0, 0, 1], unitToMetres: () => 1, scanExtent: () => null, scanHullPositions: () => null,
    measurementOwnership: () => ACTIVE_B,
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''), setError: (s: string) => errors.push(s),
    downloadText: (_n: string, text: string) => writes.push(text),
    loadKmlExport: async () => ({ ...kml, resolveExportDigests }),
  } as unknown as KmlActionDeps;
  return { deps, writes, errors };
}

describe('site KML counts only exportable content', () => {
  it('is not offered when every annotation is withheld and there is nothing else', async () => {
    const h = harness({ annotations: [note('ON-CLOSED', 'stable-a'), note('ALSO-CLOSED', 'stable-a')] });
    const s = siteKmlStatus(h.deps);
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/nothing on this scan to place/i);
    await exportSiteKml(h.deps);
    expect(h.writes).toEqual([]);
    expect(h.errors).toHaveLength(1);
  });

  it('is not offered when every measurement is withheld and there is nothing else', () => {
    expect(siteKmlStatus(harness({ measurements: [line('ON-CLOSED', 'stable-a')] }).deps).ready).toBe(false);
  });

  it('is offered for one owned annotation beside withheld ones', async () => {
    const h = harness({ annotations: [note('ON-CLOSED', 'stable-a'), note('MINE', 'stable-b')] });
    expect(siteKmlStatus(h.deps)).toEqual({ ready: true, reason: '' });
    await exportSiteKml(h.deps);
    expect(h.errors).toEqual([]);
    expect(h.writes[0]).toContain('<name>MINE</name>');
  });

  it('is offered for an owned measurement', () => {
    expect(siteKmlStatus(harness({ measurements: [line('MINE', 'stable-b')] }).deps).ready).toBe(true);
  });

  it('is offered for a saved view alone', () => {
    const v = { name: 'View 1', position: [1, 2, 30], target: [1, 2, 0] } as unknown as KmlViewpoint;
    expect(siteKmlStatus(harness({ viewpoints: [v] }).deps).ready).toBe(true);
  });
});

describe('site KML re-checks the open scan count at the click', () => {
  it('writes nothing when a second scan opened after the button enabled', async () => {
    let layers = 1;
    const h = harness({ measurements: [line('MINE', 'stable-b')], layerCount: () => layers });
    expect(siteKmlStatus(h.deps).ready).toBe(true);
    layers = 2;
    await exportSiteKml(h.deps);
    expect(h.writes).toEqual([]);
    expect(h.errors).toEqual(['KML export stopped. Site KML needs one open scan.']);
  });
});
