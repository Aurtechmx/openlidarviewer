// What these tests would catch:
//
//  - A scan that stays placed in the project frame after the scan that
//    anchored it closes, exported as if its scene coordinates were local to its
//    own file origin: every coordinate shifted by the placement offset.
//  - A session saved with that one placed scan open writing the scan's file
//    origin while its measurements, camera and clip are project-frame, so the
//    work reopens displaced by the same offset.
//  - The site KML placing that scan's features through its file origin.
//  - Any change to the single, unplaced scan, which must stay byte-identical.

import { describe, it, expect, vi } from 'vitest';
import {
  exportMeasurementsFile,
  type ExportLayerView,
  type MeasurementExportActionDeps,
} from '../src/app/measurementExportActions';
import { exportSiteKml, type KmlActionDeps } from '../src/app/kmlActions';
import { resolveLocalToLonLat } from '../src/export/lonLatMapper';
import { UTM13, utm13LonLat } from './helpers/geoJsonLonLat';
import * as serializers from '../src/export/measurementExport';
import * as sessionIo from '../src/io/session';
import { parseSession, rebaseSessionGeometry } from '../src/io/session';
import { serializeActiveSession, type SessionSnapshotDeps } from '../src/app/sessionSnapshot';
import { projectFrameInputFrom, sessionImportOrigins, type ProjectFrameSources } from '../src/app/projectFrame';
import type { KmlExportInput } from '../src/export/kmlExport';
import type { Measurement } from '../src/render/measure/types';
import type { GeoExportContext } from '../src/app/reportExport';

type V3 = [number, number, number];

// A anchored the project frame and has been closed. B stays placed in it.
const P: V3 = [500_000, 4_000_000, 99];
const B_SO: V3 = [500_100, 4_000_000, 50];
const FULL: V3 = [100, 0, -49];
const XY_ONLY: V3 = [100, 0, 0];

// Two true survey points on B, and their B-local coordinates.
const B_WORLD: V3[] = [[500_101, 4_000_001, 50], [500_104, 4_000_005, 50]];
const B_LOCAL: V3[] = B_WORLD.map((p) => [p[0] - B_SO[0], p[1] - B_SO[1], p[2] - B_SO[2]]);
const scene = (off: V3 | null): V3[] => B_LOCAL.map((p) => (off ? [p[0] + off[0], p[1] + off[1], p[2] + off[2]] : p));

const GEO_B: GeoExportContext = { origin: B_SO, crsName: 'WGS 84 / UTM zone 13N', name: 'geom-b.las', crs: UTM13 };

const oneLayer = (offset: V3 | null): NonNullable<MeasurementExportActionDeps['layers']> => ({
  view: {
    clouds: () => ['cloud_1'],
    getCloud: () => ({ name: 'geom-b.las', sourceOrigin: B_SO, metadata: { crs: { name: 'WGS 84 / UTM zone 13N' } } }),
    layerProjectOffset: () => offset,
  } satisfies ExportLayerView,
  stableIdFor: () => 'layer-b',
});

/** Taken on B while A was open (owned, picked), and after A closed (unowned). */
const workOn = (off: V3 | null): Measurement[] => [
  { id: 'b1', kind: 'distance', name: 'Distance b1', points: scene(off), owner: { layerId: 'layer-b', frame: 'project' }, pickLayers: ['layer-b'] },
  { id: 'b2', kind: 'distance', name: 'Distance b2', points: scene(off) },
];

async function runExport(ms: Measurement[], offset: V3 | null) {
  const downloads: { filename: string; text: string }[] = [];
  const refusals: string[] = [];
  const deps: MeasurementExportActionDeps = {
    measure: { getMeasurements: () => ms, worldUp: [0, 0, 1], unitToMetres: 1, verticalUnitToMetres: 1, crsKnown: true, geographicCrs: false },
    geo: () => GEO_B,
    upAxis: () => 'z',
    layers: oneLayer(offset),
    refuse: (m) => refusals.push(m),
    baseName: (n) => n.replace(/\.[^.]+$/, ''),
    downloadText: (filename, text) => downloads.push({ filename, text }),
    loadMeasurementExport: async () => ({
      ...serializers,
      resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'not supplied', crsOrigin: null } as never),
    }),
    loadMeasurementReport: async () => { throw new Error('unused'); },
    activeClassificationEpoch: () => 0,
    appVersion: '0.0.0',
    notify: () => undefined,
    now: () => '2026-01-01T00:00:00.000Z',
  };
  await exportMeasurementsFile('geojson', deps);
  await exportMeasurementsFile('csv', deps);
  return { downloads, refusals };
}

describe('one placed scan left open after the anchor closed: measurement file', () => {
  for (const [kind, off] of [['verified', FULL], ['horizontal-only', XY_ONLY]] as [string, V3][]) {
    it(`GeoJSON and CSV give the true source coordinates (${kind})`, async () => {
      const out = await runExport(workOn(off), off);
      expect(out.refusals).toEqual([]);
      const fc = JSON.parse(out.downloads[0]!.text);
      for (const f of fc.features) expect(f.geometry.coordinates).toEqual(B_WORLD.map(utm13LonLat));
      expect(fc.features.map((f: { properties: { source: string } }) => f.properties.source)).toEqual(['geom-b', 'geom-b']);
      expect(out.downloads.map((d) => d.filename)).toEqual(['geom-b-measurements.geojson', 'geom-b-measurements.csv', 'geom-b-measurements.provenance.txt']);
      // The CSV holds no coordinates; it is the file the unplaced scan writes.
      const plain = await runExport(workOn(null), null);
      expect(out.downloads[1]!.text).toBe(plain.downloads[1]!.text);
    });
  }

  it('an unplaced single scan writes exactly what it wrote before', async () => {
    const none = await runExport(workOn(null), null);
    // A sole scan anchors its own frame: an identity placement, zero offset.
    const zero = await runExport(workOn(null), [0, 0, 0]);
    expect(zero.downloads).toEqual(none.downloads);
    const fc = JSON.parse(none.downloads[0]!.text);
    expect(fc.features[0].geometry.coordinates).toEqual(B_WORLD.map(utm13LonLat));
  });
});

describe('one placed scan left open after the anchor closed: session', () => {
  const RECORD = { layerId: 'layer-b', fingerprint: 'f b.laz 2', displayName: 'geom-b.las' };
  const sources = (frameOrigin: V3, placement: { vertical: boolean } | null): ProjectFrameSources => ({
    frame: { projectOrigin: frameOrigin },
    layerIds: ['b'],
    cloud: () => ({ sourceOrigin: B_SO, sourceFormat: 'las' }),
    record: () => RECORD,
    placement: () => placement,
  });

  function deps(ms: Measurement[], src: ProjectFrameSources | null, camera: { position: V3; target: V3 }): SessionSnapshotDeps {
    const viewer = {
      streamingCloud: null,
      measure: { unitSystem: 'metric', getMeasurements: () => ms },
      annotate: { getAnnotations: () => [] },
    };
    const cloud = {
      name: 'geom-b.las', pointCount: 10, sourceFormat: 'las', sourceOrigin: B_SO,
      bounds: () => ({ min: [0, 0, 0], max: [5, 5, 1] }),
    };
    return {
      getViewer: () => viewer as never,
      activeCloud: () => cloud as never,
      analysedResult: () => null,
      verticalUnitToMetres: () => null,
      captureViewState: () => ({ camera }) as never,
      savedViews: () => [],
      // The app's single-origin reading: the active scan's file origin.
      origin: () => B_SO,
      crs: () => null,
      layerGroups: () => [],
      appVersion: 'test',
      ...(src ? { projectFrame: () => projectFrameInputFrom(src) } : {}),
    };
  }

  const save = (d: SessionSnapshotDeps): string => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      return serializeActiveSession(sessionIo, d);
    } finally {
      vi.useRealTimers();
    }
  };

  /** Reopen with B alone: B anchors its own frame, unplaced. */
  const reopenAlone = (text: string) => {
    const session = parseSession(text);
    const o = sessionImportOrigins({
      frame: () => ({ projectOrigin: B_SO }),
      activeId: () => 'v1',
      viewerIds: () => ['v1'],
      stableIdFor: () => 'layer-b',
      cloud: () => ({ sourceOrigin: B_SO }),
      placement: () => ({ vertical: true }),
      fallback: () => B_SO,
    });
    return rebaseSessionGeometry(session, o.exportOrigin(), { layerOrigin: o.layerOrigin, projectOrigin: o.projectOrigin() });
  };

  for (const [kind, off, placement] of [
    ['verified', FULL, { vertical: true }],
    ['horizontal-only', XY_ONLY, { vertical: false }],
  ] as [string, V3, { vertical: boolean }][]) {
    it(`reopens every measurement and the camera at the same world coordinate (${kind})`, async () => {
      const camScene: V3 = [B_LOCAL[0]![0] + off[0], B_LOCAL[0]![1] + off[1], 10 + off[2]];
      const text = save(deps(workOn(off), sources(P, placement), { position: camScene, target: camScene }));
      const g = reopenAlone(text);
      expect(g.refused).toEqual([]);
      expect(g.measurements.map((m) => m.id)).toEqual(['b1', 'b2']);
      for (const m of g.measurements) {
        expect(m.points.map((p) => [p[0] + B_SO[0], p[1] + B_SO[1], p[2] + B_SO[2]])).toEqual(B_WORLD);
      }
      // The camera sat 10 units above B's first point; it still does.
      const c = g.camera!.position;
      expect([c[0] + B_SO[0], c[1] + B_SO[1], c[2] + B_SO[2]]).toEqual([B_WORLD[0]![0], B_WORLD[0]![1], B_SO[2] + 10]);
    });
  }

  it('an unplaced single scan saves exactly what it saved without a frame', () => {
    const cam = { position: [1, 1, 10] as V3, target: [1, 1, 0] as V3 };
    // A sole scan anchors the frame at its own origin with an identity placement.
    const anchored = sources(B_SO, { vertical: true });
    expect(projectFrameInputFrom(anchored)).toBeNull();
    expect(projectFrameInputFrom(sources(P, null))).toBeNull();
    const withFrame = save(deps(workOn(null), anchored, cam));
    const without = save(deps(workOn(null), null, cam));
    expect(withFrame).toBe(without);
    const s = parseSession(withFrame);
    expect(s.origin).toEqual(B_SO);
    expect(s.projectFrame).toBeUndefined();
  });
});

describe('one placed scan left open after the anchor closed: site KML', () => {
  function harness(offset: V3 | null) {
    let input: KmlExportInput | null = null;
    const deps = {
      hasViewer: () => true,
      geo: () => GEO_B,
      crsCurrent: () => UTM13,
      upAxis: () => 'z',
      annotations: () => [],
      measurements: () => workOn(offset),
      layerCount: () => 1,
      sceneOffset: () => offset,
      viewpoints: () => [],
      worldUp: () => [0, 0, 1],
      unitToMetres: () => 1,
      scanExtent: () => null,
      scanHullPositions: () => null,
      baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
      downloadText: () => undefined,
      setError: (m: string) => { throw new Error(m); },
      loadKmlExport: async () => ({
        buildKml: (i: KmlExportInput) => { input = i; return '<kml/>'; },
        KmlCoordinateError: class extends Error {},
        resolveExportDigests: async () => ({}) as never,
      }),
    } as unknown as KmlActionDeps;
    return { deps, input: () => input! };
  }

  const truth = (() => {
    const m = resolveLocalToLonLat(UTM13, B_SO);
    if (!m.ok) throw new Error(m.reason);
    return B_LOCAL.map((p) => m.map(p));
  })();

  for (const [kind, off] of [['verified', FULL], ['horizontal-only', XY_ONLY], ['unplaced', null]] as [string, V3 | null][]) {
    it(`places features at their true position (${kind})`, async () => {
      const h = harness(off);
      await exportSiteKml(h.deps);
      const placed = scene(off).map((p) => h.input().toLonLat(p));
      expect(placed).toEqual(truth);
    });
  }
});
