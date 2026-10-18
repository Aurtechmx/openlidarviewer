/**
 * sessionLayerUpFrame.test.ts
 *
 * A session reopened onto a georeferenced PLY keeps reading heights along the
 * layer's resolved up axis (Z, from its CRS), not the format axis (Y) the file
 * records for matching. New saves record the resolved axis and basis, and the
 * axis each profile chart and volume was cut along. A stored elevation value is
 * shifted only along the axis it was cut along; when that is not the reopened
 * layer's resolved axis (an older file, or a CRS changed since) the value is
 * re-cut along the resolved frame, or withheld with the reason until it can be.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { loadPly } from '../src/io/loadPly';
import { PointCloud } from '../src/model/PointCloud';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import { bindMeasureUnitFrames } from '../src/app/measureLayerUnits';
import { layerUpFrameOf } from '../src/app/layerUpFrames';
import { heldCutAxes, sessionUpAxisNote } from '../src/app/sessionUpAxisNote';
import { shiftMeasurement } from '../src/io/sessionFrame';
import { geoContextForCloud } from '../src/app/reportExport';
import { exportMeasurementsFile, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import * as serializers from '../src/export/measurementExport';
import { parseSession, rebaseSessionGeometry, serializeSession, type InspectionSession } from '../src/io/session';
import * as sessionIo from '../src/io/session';
import { serializeActiveSession, type SessionSnapshotDeps } from '../src/app/sessionSnapshot';
import type { MeasureController as MC } from '../src/render/measure/MeasureController';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

function memoryPort(): CrsOverridePort {
  const store = new Map<string, unknown>();
  return { get: (k) => store.get(k) as never, set: (k, v) => void store.set(k, { ...v, updatedAt: 0 }), clear: (k) => void store.delete(k) } as CrsOverridePort;
}

/** UTM 13N points: B is 30 m north of A and 70 m above it. Origin (floored min) 500000, 4000000, 100. */
async function site(format: 'ply' | 'glb' = 'ply'): Promise<PointCloud> {
  const rows = ['500000 4000000 100', '500000 4000030 170', '500040 4000000 100'];
  const text = `ply\nformat ascii 1.0\nelement vertex ${rows.length}\nproperty double x\nproperty double y\nproperty double z\nend_header\n${rows.join('\n')}\n`;
  const ply = await loadPly(new TextEncoder().encode(text).buffer as ArrayBuffer, `site.${format}`);
  return format === 'ply' ? ply : new PointCloud({ positions: ply.positions.slice(), origin: [...ply.sourceOrigin] as [number, number, number], sourceFormat: format, name: 'site.glb' });
}

const pt = (c: PointCloud, i: number): Vec3 => [c.positions[i * 3]!, c.positions[i * 3 + 1]!, c.positions[i * 3 + 2]!];

/** One open layer under a CRS service, a real controller and the unit binding main.ts makes. */
async function open(port: CrsOverridePort, cloud: PointCloud, epsg: number | null): Promise<{ measure: MC; crs: CrsService; cuts: string[] }> {
  const crs = new CrsService(port);
  crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'las-vlr', identity: datasetIdentity(cloud) });
  if (epsg !== null) crs.setOverride({ override: { kind: 'projected', epsg }, detected: undefined, source: 'las-vlr' });
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setLayerResolver((l) => (typeof l === 'string' ? l : null));
  const units = bindMeasureUnitFrames(measure, { activeId: () => 'a', clouds: () => ['a'], cloud: () => cloud, stableIdFor: () => 'layer-a', crs });
  units.onCrsChange();
  return { measure, crs, cuts: [] };
}

function withSamplers(w: { measure: MC; cuts: string[] }): void {
  w.measure.setProfileSampler(() => {
    w.cuts.push(`profile ${w.measure.worldUp.join(',')}`);
    return [{ distance: 0, height: 7 }, { distance: 1, height: 8 }];
  });
  w.measure.setVolumeSampler((_p, _r, up) => {
    w.cuts.push(`volume ${up!.join(',')}`);
    return { fill: 1, cut: 0, net: 1, referenceZ: 3, footprintArea: 1, pointsInPolygon: 1000, densityNative: 1, confidence: 'high' } as never;
  });
}

const own = { pickLayers: ['layer-a'], owner: { layerId: 'layer-a', frame: 'source-local' as const } };

async function verticalCsv(measure: MC, cloud: PointCloud, crs: CrsService): Promise<number> {
  const files: string[] = [];
  const deps = {
    measure, geo: () => geoContextForCloud(cloud, crs.current()), upAxis: () => 'z', refuse: () => {}, notify: () => {}, baseName: (s: string) => s,
    layers: { stableIdFor: () => 'layer-a', view: { clouds: () => ['a'], getCloud: () => cloud, layerProjectOffset: () => null } },
    frameSource: { activeId: () => 'a', activeGeo: () => geoContextForCloud(cloud, crs.current()), activeUpAxis: () => 'z', cloud: () => cloud, classificationEpoch: () => 0, crs },
    downloadText: (_n: string, t: string) => files.push(t),
    loadMeasurementExport: async () => ({ ...serializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null }) }),
    loadMeasurementReport: async () => ({}), activeClassificationEpoch: () => 0, appVersion: 'test', now: () => '2026-10-18T00:00:00Z',
  } as unknown as MeasurementExportActionDeps;
  await exportMeasurementsFile('csv', deps);
  const [head, row] = files[0]!.trim().split('\n');
  return Number(row!.split(',')[head!.split(',').indexOf('vertical_m')]);
}

function sessionOf(measurements: Measurement[], extra: Partial<InspectionSession>): InspectionSession {
  return parseSession(serializeSession({ upAxis: 'y', origin: [500000, 4000000, 100], unitSystem: 'metric', views: [], measurements, annotations: [], layerId: 'layer-a', ...extra }));
}

describe('a georeferenced PLY session saved and reopened', () => {
  it('records the resolved axis and the cut axis, keeps heights and vertical_m, and shifts stored heights along the cut axis', async () => {
    const port = memoryPort();
    const cloud = await site();
    const w = await open(port, cloud, 32613);
    withSamplers(w);
    w.measure.loadMeasurements([{ id: 'h', kind: 'height', name: 'h', closed: false, points: [pt(cloud, 0), pt(cloud, 1)], ...own }]);
    w.measure.setActive(true);
    w.measure.setKind('profile');
    w.measure.addPoint(pt(cloud, 0), 'layer-a');
    w.measure.addPoint(pt(cloud, 2), 'layer-a');
    expect(w.cuts).toEqual(['profile 0,0,1']);
    const saved = w.measure.getMeasurements();
    expect(saved[1]!.derivedUpAxis).toBe('z');

    const frame = layerUpFrameOf(w.crs, cloud, true);
    // Saved in a frame whose origin sat 10 m north and 5 m above this file's.
    const file = sessionOf(saved.map((m) => ({ ...m, owner: own.owner })), { origin: [500000, 4000010, 105], upFrame: { axis: 'z', basis: frame.basis } });
    expect(file.upFrame).toEqual({ axis: 'z', basis: 'crs' });
    expect(file.measurements[1]!.derivedUpAxis).toBe('z');

    // Reopened onto the same file: stored heights move along Z, the axis they
    // were cut along, by the 5 m between the two frames.
    const reopenedCloud = cloud;
    const geo = rebaseSessionGeometry(file, reopenedCloud.sourceOrigin);
    const profile = geo.measurements[1]!;
    expect(profile.profileChart!.map((s) => s.height)).toEqual([12, 13]);
    expect(profile.derivedUpAxis).toBe('z');

    const r = await open(port, reopenedCloud, null);
    withSamplers(r);
    r.measure.loadMeasurements(geo.measurements);
    // The remembered CRS resolves the layer Z-up again: nothing to re-cut.
    expect(r.measure.recutDerived()).toEqual({ recut: 0, withheld: 0 });
    expect(r.cuts).toEqual([]);
    expect(Number.parseFloat(r.measure.getSummaries()[0]!.value)).toBeCloseTo(70, 3);
    r.measure.loadMeasurements([geo.measurements[0]!]);
    expect(await verticalCsv(r.measure, reopenedCloud, r.crs)).toBeCloseTo(70, 6);
    expect(sessionUpAxisNote({ recorded: file.upFrame, formatAxis: file.upAxis, live: layerUpFrameOf(r.crs, reopenedCloud, true), recut: { recut: 0, withheld: 0 } })).toBe('');
  });
});

describe('a new save records the resolved up frame beside the format axis', () => {
  it.each([[32613, { axis: 'z', basis: 'crs' }], [null, { axis: 'y', basis: 'explicit' }]] as const)('EPSG %s', async (epsg, expected) => {
    const cloud = await site();
    const w = await open(memoryPort(), cloud, epsg);
    const deps = {
      getViewer: () => ({ streamingCloud: null, measure: { unitSystem: 'metric', getMeasurements: () => [] }, annotate: { getAnnotations: () => [] } }) as never,
      activeCloud: () => cloud, analysedResult: () => null, verticalUnitToMetres: () => null, captureViewState: () => ({}) as never,
      savedViews: () => [], origin: () => cloud.sourceOrigin, crs: () => w.crs.current(), layerGroups: () => [], appVersion: 'test',
    } as unknown as SessionSnapshotDeps;
    const saved = parseSession(serializeActiveSession(sessionIo, deps));
    // The format axis stays what reopening matches scans on.
    expect(saved.upAxis).toBe('y');
    expect(saved.upFrame).toEqual(expected);
  });
});

describe('an older session that recorded the format axis', () => {
  async function oldFile(): Promise<{ file: InspectionSession; cloud: PointCloud }> {
    const cloud = await site();
    // Written before the resolved frame was recorded: no upFrame, no cut axis,
    // and a profile and volume cut along Y (the format axis) under EPSG:32613.
    const raw = JSON.parse(serializeSession({
      upAxis: 'y', origin: [500000, 4000000, 100], unitSystem: 'metric', views: [], annotations: [], layerId: 'layer-a',
      measurements: [
        { id: 'h', kind: 'height', name: 'h', closed: false, points: [pt(cloud, 0), pt(cloud, 1)], ...own },
        { id: 'p', kind: 'profile', name: 'p', closed: false, points: [pt(cloud, 0), pt(cloud, 2)], profileChart: [{ distance: 0, height: 30 }, { distance: 1, height: 31 }], ...own },
        { id: 'v', kind: 'volume', name: 'v', closed: true, points: [pt(cloud, 0), pt(cloud, 2), pt(cloud, 1)], volume: { fill: 9, cut: 0, net: 9, referenceZ: 30, footprintArea: 1, pointsInPolygon: 1000, densityNative: 1, confidence: 'high' } as never, ...own },
      ] as Measurement[],
    })) as Record<string, unknown>;
    expect(raw.upFrame).toBeUndefined();
    return { file: parseSession(JSON.stringify(raw)), cloud };
  }

  it('is re-cut along the resolved frame, and the restore says so', async () => {
    const { file, cloud } = await oldFile();
    const geo = rebaseSessionGeometry(file, [500000, 3999990, 95]);
    // Shifted only along the axis the values are in (Y), never along Z.
    expect(geo.measurements[1]!.profileChart!.map((s) => s.height)).toEqual([40, 41]);
    expect(geo.measurements[2]!.volume!.referenceZ).toBe(40);
    expect(geo.measurements.slice(1).map((m) => m.derivedUpAxis)).toEqual(['y', 'y']);

    const port = memoryPort();
    const reopened = new PointCloud({ positions: cloud.positions.slice(), origin: [500000, 3999990, 95], sourceFormat: 'ply', name: cloud.name });
    const r = await open(port, reopened, 32613);
    withSamplers(r);
    r.measure.loadMeasurements(geo.measurements);
    const recut = r.measure.recutDerived();
    expect(recut).toEqual({ recut: 2, withheld: 0 });
    expect(r.cuts).toEqual(['profile 0,0,1', 'volume 0,0,1']);
    const ms = r.measure.getMeasurements();
    expect(ms.slice(1).map((m) => m.derivedUpAxis)).toEqual(['z', 'z']);
    expect(ms[1]!.profileChart!.map((s) => s.height)).toEqual([7, 8]);
    expect(ms[2]!.volume!.referenceZ).toBe(3);
    expect(Number.parseFloat(r.measure.getSummaries()[0]!.value)).toBeCloseTo(70, 3);
    const note = sessionUpAxisNote({ recorded: file.upFrame, formatAxis: file.upAxis, live: layerUpFrameOf(r.crs, reopened, true), recut });
    expect(note).toBe(" The session recorded the scan's format axis, Y; heights are now read Z-up (its coordinate system). 2 profile or volume results were re-cut along the scan's resolved up axis.");
  });

  it('is withheld with the reason when it cannot be re-cut, and re-cut once it can', async () => {
    const { file, cloud } = await oldFile();
    const geo = rebaseSessionGeometry(file, cloud.sourceOrigin);
    const r = await open(memoryPort(), cloud, 32613);
    r.measure.loadMeasurements(geo.measurements);
    expect(r.measure.recutDerived()).toEqual({ recut: 0, withheld: 2 });
    const [, p, v] = r.measure.getMeasurements();
    expect(p!.profileChart).toBeUndefined();
    expect(v!.volume).toBeUndefined();
    expect(p!.derivedWithheld).toBe("Profile chart withheld: it was cut along Y, and this layer's up axis is now Z. It could not be re-cut here; resample the profile once the layer's points are loaded.");
    expect(v!.derivedWithheld).toMatch(/^Cut and fill withheld: it was cut along Y/);
    // Saved again, the reason travels with the file.
    const again = parseSession(serializeSession({ upAxis: 'y', origin: [500000, 4000000, 100], unitSystem: 'metric', views: [], annotations: [], measurements: r.measure.getMeasurements() }));
    expect(again.measurements[1]!.derivedWithheld).toBe(p!.derivedWithheld);
    // A sampler arrives (the points loaded): the next frame refresh re-cuts.
    withSamplers(r);
    r.measure.refreshUnitFrames();
    const [, p2, v2] = r.measure.getMeasurements();
    expect(p2!.derivedWithheld).toBeUndefined();
    expect(p2!.profileChart).toBeDefined();
    expect(v2!.volume?.referenceZ).toBe(3);
  });

  it('a glTF under a CRS has no resolved axis: the restore says its figures are withheld', async () => {
    const cloud = await site('glb');
    const r = await open(memoryPort(), cloud, 32613);
    const live = layerUpFrameOf(r.crs, cloud, true);
    expect(live.ok).toBe(false);
    expect(sessionUpAxisNote({ recorded: undefined, formatAxis: 'y', live, recut: { recut: 0, withheld: 0 } }))
      .toMatch(/^ The scan has no resolved up axis, so heights, grades, profiles and volumes are withheld: glTF stores Y/);
  });
});

describe('work held for a scan that is not open', () => {
  const chart = [{ distance: 0, height: 30 }, { distance: 1, height: 31 }];
  const heldProfile = (extra: Partial<Measurement> = {}): Measurement =>
    ({ id: 'p', kind: 'profile', name: 'p', closed: false, points: [[0, 0, 0], [10, 0, 0]], profileChart: chart, owner: { layerId: 'layer-b', frame: 'source-local' }, ...extra }) as Measurement;

  it('keeps a recorded cut axis, takes the session record for its own scan, and never the format axis', () => {
    const [kept] = heldCutAxes([heldProfile({ derivedUpAxis: 'z' })], undefined, null);
    expect(kept!.derivedUpAxis).toBe('z');
    // Moved between frame records along Z, the axis it was cut along, though the held format axis is Y.
    expect(shiftMeasurement(kept!, [0, 10, 5], 'y').profileChart!.map((x) => x.height)).toEqual([35, 36]);

    const [fromRecord] = heldCutAxes([heldProfile()], { axis: 'z', basis: 'crs' }, 'layer-b');
    expect(fromRecord!.derivedUpAxis).toBe('z');

    // An older file: only the format axis is recorded, which is not evidence of the cut.
    const [unknown] = heldCutAxes([heldProfile()], undefined, 'layer-b');
    expect(unknown!.derivedUpAxis).toBeUndefined();
    expect(unknown!.profileChart).toBeUndefined();
    expect(unknown!.derivedWithheld).toBe("Profile chart withheld: the session did not record the up axis it was cut along. It is re-cut along the layer's resolved up axis when the layer is open.");
    // Moved between frames, nothing is shifted along a guessed axis.
    const moved = shiftMeasurement(unknown!, [0, 10, 5], 'y');
    expect(moved.profileChart).toBeUndefined();
    expect(moved.points[0]).toEqual([0, 10, 5]);
    // A record for a different scan does not apply.
    expect(heldCutAxes([heldProfile()], { axis: 'z', basis: 'crs' }, 'layer-a')[0]!.derivedWithheld).toBeDefined();
  });

  it('is re-cut along the reopened layer\'s resolved frame when its scan opens, and the restore says so', async () => {
    const cloud = await site();
    const r = await open(memoryPort(), cloud, 32613);
    withSamplers(r);
    const [held] = heldCutAxes([{ ...heldProfile(), points: [pt(cloud, 0), pt(cloud, 2)], owner: own.owner, pickLayers: own.pickLayers }], undefined, null);
    r.measure.loadMeasurements([held!]);
    const recut = r.measure.recutDerived();
    expect(recut).toEqual({ recut: 1, withheld: 0 });
    expect(r.cuts).toEqual(['profile 0,0,1']);
    const m = r.measure.getMeasurements()[0]!;
    expect(m.derivedUpAxis).toBe('z');
    expect(m.derivedWithheld).toBeUndefined();
    expect(sessionUpAxisNote({ recorded: undefined, formatAxis: 'y', live: null, recut })).toBe(" 1 profile or volume result was re-cut along the scan's resolved up axis.");
  });
});
