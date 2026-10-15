/**
 * tests/sessionLayerReconcile.test.ts
 *
 * A saved session names layers by the ids the saving page minted. A fresh page
 * mints new ones, so before any work is placed the importer maps each saved
 * layer onto an open layer by its source evidence, rewrites every reference,
 * holds back work whose scan is not open (or is open twice), and the next save
 * writes that held work back. These tests run the whole save → fresh page →
 * import → save → import cycle through the real writer and importer with
 * fresh ids on every page.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as sessionModule from '../src/io/session';
import { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict, sessionScanOrigin } from '../src/io/session';
import {
  mapSessionLayers,
  mapSingleScanSession,
  remapSessionLayerIds,
  partitionHeldWork,
  keyHasContentFacts,
  normalizeRestoredOwners,
  type LiveLayerEvidence,
} from '../src/io/sessionOwnership';
import { carryHeldSessionWork, recordBase, type SessionLayerRecord, type SessionProjectFrame } from '../src/io/sessionFrame';
import { fingerprintKey } from '../src/model/layerIdentity';
import { importSession, type SessionIoDeps, type SessionModule } from '../src/app/sessionIo';
import { serializeActiveSession, type SessionSnapshotDeps } from '../src/app/sessionSnapshot';
import { projectFrameInputFrom, sceneOriginFor } from '../src/app/projectFrame';
import { clearPendingSessionRestore, heldSessionWork } from '../src/app/pendingSessionRestore';
import { ownershipOf, partitionSessionWork, relabelWorkLayer } from '../src/app/measurementOwnership';
import { createLayerIdentityService } from '../src/app/layerIdentityService';
import { exportLayerHooks } from '../src/ui/ExportPanel';
import { PointCloud } from '../src/model/PointCloud';
import type { Measurement } from '../src/render/measure/types';
import type { InspectionSession } from '../src/io/session';

type V3 = [number, number, number];

afterEach(() => clearPendingSessionRestore());

// Two scans of one survey: A at the project origin in plan, B 100 m east.
const A_SO: V3 = [500_000, 4_000_000, 99];
const B_SO: V3 = [500_100, 4_000_000, 50];

interface Scan {
  readonly name: string;
  readonly points: number;
  readonly span: V3;
  readonly so: V3;
}
const A: Scan = { name: 'geom-a.las', points: 30351, span: [40, 30, 0.5], so: A_SO };
const B: Scan = { name: 'geom-b.las', points: 2601, span: [10, 10, 0], so: B_SO };

const keyOf = (s: Scan): string => fingerprintKey({
  fileName: s.name, sourcePoints: s.points, width: s.span[0], depth: s.span[1], height: s.span[2], epsg: 32613, crs: 'UTM 13N', origin: s.so,
});

const evidence = (id: string, s: Scan): LiveLayerEvidence => ({ layerId: id, fingerprint: keyOf(s), sourceOrigin: s.so, upAxis: 'z', epsg: 32613 });

/** The project origin of a set of open scans: the per-axis floor, as the app takes it. */
const projectOriginOf = (scans: readonly Scan[]): V3 =>
  [0, 1, 2].map((k) => Math.min(...scans.map((s) => s.so[k]!))) as V3;

/**
 * One page: the open scans (in load order, the last one active), each with an
 * id this page minted, placed in plan only (no vertical datum), and the work
 * the measure store holds.
 */
class Page {
  static serial = 0;
  readonly ids: string[];
  measurements: Measurement[] = [];
  readonly toasts: string[] = [];
  readonly scans: readonly Scan[];
  constructor(scans: readonly Scan[]) {
    this.scans = scans;
    const n = ++Page.serial;
    this.ids = scans.map((s) => `page${n}-${s.name}`);
  }
  get frameOrigin(): V3 | null {
    return this.scans.length >= 2 ? projectOriginOf(this.scans) : null;
  }
  private viewerId(i: number): string { return `cloud_${i}`; }
  private indexOfLive(id: string): number { return this.ids.indexOf(id); }
  layerOrigin(id: string): V3 | null {
    const i = this.indexOfLive(id);
    if (i < 0) return null;
    return sceneOriginFor(this.frameOrigin, this.scans[i]!.so, this.frameOrigin ? { vertical: false } : null);
  }
  get activeIndex(): number { return this.scans.length - 1; }

  importDeps(): SessionIoDeps {
    const clouds = this.scans.map((s) => ({
      name: s.name,
      pointCount: s.points,
      declaredPointCount: s.points,
      sourceFormat: 'las',
      sourceOrigin: s.so,
      bounds: () => ({ min: [0, 0, 0], max: s.span }),
      metadata: { crs: null },
    }));
    const viewer = {
      clouds: () => clouds.map((_, i) => this.viewerId(i)),
      hasStreamingCloud: false,
      streamingCloud: null,
      getCloud: (id: string) => clouds[Number(id.slice(6))],
      measure: { loadMeasurements: (m: Measurement[]) => { this.measurements = m; }, getMeasurements: () => this.measurements },
      annotate: { loadAnnotations: () => {}, getAnnotations: () => [] },
    };
    const module: SessionModule = { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict, sessionScanOrigin };
    return {
      viewerReady: Promise.resolve(),
      getViewer: () => viewer as never,
      loadSession: async () => module,
      appVersion: 'test',
      getActiveScanId: () => this.viewerId(this.activeIndex),
      getActiveLayerId: () => this.ids[this.activeIndex]!,
      getActiveCloud: () => clouds[this.activeIndex] as never,
      exportOrigin: () => this.layerOrigin(this.ids[this.activeIndex]!)!,
      layerOrigin: (id) => this.layerOrigin(id),
      projectOrigin: () => this.frameOrigin,
      liveLayers: () => this.scans.map((s, i) => evidence(this.ids[i]!, s)),
      bookmarks: { restore: () => {}, names: () => [] },
      setInspectorViews: () => {},
      restoreLayerGroups: () => {},
      refreshMeasurePanel: () => {},
      refreshAnnotationPanel: () => {},
      applyViewState: () => {},
      setCrsOverride: () => {},
      showToast: (m) => { this.toasts.push(m); },
      setDropError: (m) => { throw new Error(`drop error: ${m}`); },
    };
  }

  saveDeps(): SessionSnapshotDeps {
    const active = this.scans[this.activeIndex]!;
    const cloud = {
      name: active.name, pointCount: active.points, sourceFormat: 'las', sourceOrigin: active.so,
      bounds: () => ({ min: [0, 0, 0], max: active.span }),
    };
    const viewer = {
      streamingCloud: null,
      measure: { unitSystem: 'metric', getMeasurements: () => this.measurements },
      annotate: { getAnnotations: () => [] },
    };
    const frame = this.frameOrigin;
    return {
      getViewer: () => viewer as never,
      activeCloud: () => cloud as never,
      analysedResult: () => null,
      verticalUnitToMetres: () => null,
      captureViewState: () => ({}) as never,
      savedViews: () => [],
      origin: () => this.layerOrigin(this.ids[this.activeIndex]!)!,
      crs: () => null,
      layerGroups: () => [],
      appVersion: 'test',
      ownershipView: () => ({
        layers: this.scans.map((s, i) => ({ viewerId: this.viewerId(i), stableId: this.ids[i]!, name: s.name })),
        activeViewerId: this.viewerId(this.activeIndex),
      }),
      heldWork: heldSessionWork,
      projectFrame: (force) => projectFrameInputFrom({
        frame: frame ? { projectOrigin: frame } : null,
        layerIds: this.scans.map((_, i) => this.viewerId(i)),
        cloud: (id) => ({ sourceOrigin: this.scans[Number(id.slice(6))]!.so, sourceFormat: 'las' }),
        record: (id) => {
          const i = Number(id.slice(6));
          return { layerId: this.ids[i]!, fingerprint: keyOf(this.scans[i]!), displayName: this.scans[i]!.name };
        },
        placement: () => (frame ? { vertical: false } : null),
      }, force),
    };
  }

  save(): InspectionSession {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      return parseSession(serializeActiveSession(sessionModule, this.saveDeps()));
    } finally {
      vi.useRealTimers();
    }
  }

  async import(session: InspectionSession): Promise<boolean> {
    const text = JSON.stringify(session);
    return importSession({ text: async () => text, size: text.length, name: 's.olvsession' } as unknown as File, {}, this.importDeps());
  }

  /** Each held measurement's world points, by id. */
  world(): Record<string, number[][]> {
    const out: Record<string, number[][]> = {};
    for (const m of this.measurements) {
      const id = m.owner?.layerId;
      const base = id ? this.layerOrigin(id) : this.layerOrigin(this.ids[this.activeIndex]!);
      out[m.id] = m.points.map((p) => p.map((c, k) => c + base![k]!));
    }
    return out;
  }
}

/** The world points a saved file states for each measurement, by id. */
function fileWorld(s: InspectionSession): Record<string, number[][]> {
  const out: Record<string, number[][]> = {};
  for (const m of s.measurements) {
    let base: readonly number[] = s.origin;
    const rec = s.projectFrame?.layers.find((l) => l.layerId === m.owner?.layerId);
    if (m.owner?.frame === 'project' && rec) base = recordBase(rec);
    else if (m.owner?.frame === 'source-local' && rec) base = rec.sourceOrigin;
    out[m.id] = m.points.map((p) => p.map((c, k) => c + base[k]!));
  }
  return out;
}

/** A measurement taken on `layerId` at world points `world`, stored local to `base`. */
function takenOn(id: string, layerId: string, base: V3, world: V3[], pick?: string[]): Measurement {
  return {
    id, kind: 'distance', name: id,
    points: world.map((p) => [p[0] - base[0], p[1] - base[1], p[2] - base[2]]),
    owner: { layerId, frame: 'project' },
    ...(pick ? { pickLayers: pick } : {}),
  } as Measurement;
}

const ON_A: V3[] = [[500_004, 4_000_002, 100], [500_007, 4_000_006, 100]];
const ON_B: V3[] = [[500_101, 4_000_001, 50], [500_104, 4_000_005, 50]];

/** Page 1: both scans open, one measurement on each, saved. */
function firstSave(): InspectionSession {
  const p = new Page([A, B]);
  p.measurements = [
    takenOn('mA', p.ids[0]!, p.layerOrigin(p.ids[0]!)!, ON_A, [p.ids[0]!]),
    takenOn('mB', p.ids[1]!, p.layerOrigin(p.ids[1]!)!, ON_B, [p.ids[1]!]),
  ];
  return p.save();
}

describe('mapping saved layers onto open layers', () => {
  const frame = (layers: Array<[string, Scan]>): SessionProjectFrame => ({
    projectOrigin: A_SO,
    layers: layers.map(([id, s]) => ({
      layerId: id, sourceFingerprint: keyOf(s), sourceName: s.name, sourceOrigin: s.so, sourceToProject: [0, 0, 0], upAxis: 'z',
    })),
  });

  it('matches each saved layer to the open layer with the same source, whatever its id or order', () => {
    const m = mapSessionLayers(frame([['old-a', A], ['old-b', B]]), [evidence('new-b', B), evidence('new-a', A)]);
    expect(m.byId.get('old-a')).toEqual({ kind: 'resolved', liveId: 'new-a' });
    expect(m.byId.get('old-b')).toEqual({ kind: 'resolved', liveId: 'new-b' });
  });

  it('leaves a saved layer whose source is not open as missing', () => {
    const m = mapSessionLayers(frame([['old-a', A], ['old-b', B]]), [evidence('new-b', B)]);
    expect(m.byId.get('old-a')).toEqual({ kind: 'missing' });
  });

  it('never matches on the file name alone: another scan under the same name is not the saved one', () => {
    const otherUnderSameName: Scan = { ...A, name: B.name };
    const m = mapSessionLayers(frame([['old-b', B]]), [evidence('new', otherUnderSameName)]);
    expect(m.byId.get('old-b')).toEqual({ kind: 'missing' });
  });

  it('refuses a key that records nothing but a file name', () => {
    const nameOnly = fingerprintKey({ fileName: 'x.las' });
    expect(keyHasContentFacts(nameOnly)).toBe(false);
    expect(keyHasContentFacts(keyOf(A))).toBe(true);
    const f: SessionProjectFrame = { projectOrigin: A_SO, layers: [{ layerId: 'old', sourceFingerprint: nameOnly, sourceName: 'x.las', sourceOrigin: A_SO, sourceToProject: [0, 0, 0], upAxis: 'z' }] };
    expect(mapSessionLayers(f, [{ layerId: 'n', fingerprint: nameOnly, sourceOrigin: A_SO, upAxis: 'z' }]).byId.get('old')).toEqual({ kind: 'missing' });
  });

  it('is ambiguous, never the active layer, when the same source is open twice', () => {
    const m = mapSessionLayers(frame([['old-a', A]]), [evidence('n1', A), evidence('n2', A)]);
    expect(m.byId.get('old-a')).toEqual({ kind: 'ambiguous' });
  });

  it('is ambiguous when two saved layers claim one open layer', () => {
    const m = mapSessionLayers(frame([['old-1', A], ['old-2', A]]), [evidence('n1', A)]);
    expect(m.byId.get('old-1')).toEqual({ kind: 'ambiguous' });
    expect(m.byId.get('old-2')).toEqual({ kind: 'ambiguous' });
  });

  it('does not match a layer at another origin, on another up axis, or in another EPSG', () => {
    const f = frame([['old-a', A]]);
    expect(mapSessionLayers(f, [{ ...evidence('n', A), sourceOrigin: [1, 2, 3] }]).byId.get('old-a')!.kind).toBe('missing');
    expect(mapSessionLayers(f, [{ ...evidence('n', A), upAxis: 'y' }]).byId.get('old-a')!.kind).toBe('missing');
    const withCrs: SessionProjectFrame = { ...f, layers: [{ ...f.layers[0]!, crs: { kind: 'projected', name: 'x', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1, source: 'las-vlr', confidence: 'high', userConfirmed: false } as never }] };
    expect(mapSessionLayers(withCrs, [evidence('n', A)]).byId.get('old-a')!.kind).toBe('missing');
  });

  it('maps the one id a frameless file names onto the active layer, and refuses several', () => {
    const one = { measurements: [{ id: 'm', owner: { layerId: 'x', frame: 'source-local' } }], annotations: [] } as unknown as InspectionSession;
    expect(mapSingleScanSession(one, 'live').byId.get('x')).toEqual({ kind: 'resolved', liveId: 'live' });
    const two = { measurements: [{ id: 'm', owner: { layerId: 'x', frame: 'source-local' }, pickLayers: ['y'] }], annotations: [] } as unknown as InspectionSession;
    expect(mapSingleScanSession(two, 'live').byId.get('x')).toEqual({ kind: 'ambiguous' });
  });

  it('rewrites every reference together and renames an unmatched id that collides with a live one', () => {
    const s = {
      measurements: [{ id: 'm', owner: { layerId: 'old-a', frame: 'project' }, pickLayers: ['old-a', 'old-b'], profileProvenance: { sources: [{ layerId: 'old-a' }] } }],
      annotations: [{ id: 'n', owner: { layerId: 'old-b', frame: 'project' } }],
      layerGroups: [{ id: 'g', name: 'G', memberIds: ['old-a', 'old-b'] }],
      projectFrame: frame([['old-a', A], ['old-b', B]]),
    } as unknown as InspectionSession;
    const mapping = { byId: new Map([['old-a', { kind: 'resolved', liveId: 'new-a' } as const], ['old-b', { kind: 'missing' } as const]]) };
    const r = remapSessionLayerIds(s, mapping, new Set(['new-a', 'old-b']));
    expect(r.measurements[0]!.owner!.layerId).toBe('new-a');
    expect(r.measurements[0]!.pickLayers).toEqual(['new-a', 'old-b~unmatched']);
    expect(r.measurements[0]!.profileProvenance!.sources[0]!.layerId).toBe('new-a');
    expect(r.annotations[0]!.owner!.layerId).toBe('old-b~unmatched');
    expect(r.layerGroups![0]!.memberIds).toEqual(['new-a', 'old-b~unmatched']);
    expect(r.projectFrame!.layers.map((l) => l.layerId)).toEqual(['new-a', 'old-b~unmatched']);
    const part = partitionHeldWork(r, new Map([['old-b~unmatched', 'missing']]));
    expect(part.measurements).toHaveLength(0);
    expect(part.held.measurements).toHaveLength(1);
    expect(part.held.annotations).toHaveLength(1);
    expect(part.missing).toBe(2);
  });
});

describe('held work written into another frame', () => {
  const rec = (id: string, s: Scan, P: V3, placed: boolean): SessionLayerRecord => ({
    layerId: id, sourceFingerprint: keyOf(s), sourceName: s.name, sourceOrigin: s.so,
    sourceToProject: placed ? [s.so[0] - P[0], s.so[1] - P[1], 0] : [0, 0, 0], upAxis: 'z',
  });

  it('keeps every world coordinate when the project origin changes', () => {
    const P1 = projectOriginOf([A, B]);
    const held = { upAxis: 'z' as const, projectOrigin: P1, layers: [rec('old-a', A, P1, true)], measurements: [takenOn('m', 'old-a', recordBase(rec('old-a', A, P1, true)) as V3, ON_A)], annotations: [] };
    const target: SessionProjectFrame = { projectOrigin: B_SO, layers: [rec('live-b', B, B_SO, false)] };
    const out = carryHeldSessionWork(target, held);
    const r = out.frame.layers.find((l) => l.layerId === 'old-a')!;
    const base = recordBase(r);
    expect(out.measurements[0]!.points.map((p) => p.map((c, k) => c + base[k]!))).toEqual(ON_A);
    // The written frame is one this app reads back.
    expect(() => sessionModule.serializeSession({ upAxis: 'z', origin: B_SO, unitSystem: 'metric', views: [], measurements: out.measurements, annotations: [], projectFrame: out.frame } as never)).not.toThrow();
  });

  it('writes held work under the open layer that carries its source, without a second record', () => {
    const P1 = projectOriginOf([A, B]);
    const held = { upAxis: 'z' as const, projectOrigin: P1, layers: [rec('old-a', A, P1, true)], measurements: [takenOn('m', 'old-a', recordBase(rec('old-a', A, P1, true)) as V3, ON_A, ['old-a'])], annotations: [] };
    const target: SessionProjectFrame = { projectOrigin: P1, layers: [rec('live-a', A, P1, true), rec('live-b', B, P1, true)] };
    const out = carryHeldSessionWork(target, held);
    expect(out.frame.layers.map((l) => l.layerId)).toEqual(['live-a', 'live-b']);
    expect(out.measurements[0]!.owner!.layerId).toBe('live-a');
    expect(out.measurements[0]!.pickLayers).toEqual(['live-a']);
  });

  it('states restored work the way a scene with no project frame holds it', () => {
    const m = takenOn('m', 'live-b', [500_000, 4_000_000, 50], ON_B);
    const out = normalizeRestoredOwners([m], [], () => 'layer', 'z', {
      liveIds: new Set(['live-b']), hasProjectFrame: false, layerOrigin: () => B_SO, exportOrigin: B_SO, sourceOrigin: () => B_SO,
    });
    // 'layer': the rebase already put it local to B's origin; only the owner is restated.
    expect(out.measurements[0]!.owner).toEqual({ layerId: 'live-b', frame: 'source-local' });
    expect(out.measurements[0]!.points).toEqual(m.points);
  });
});

describe('save → fresh page → import → save → import', () => {
  it('both scans reopened, in either order: counts, owners and coordinates are stable', async () => {
    const saved = firstSave();
    for (const order of [[A, B], [B, A], [A, B]] as const) {
      const p = new Page(order);
      expect(await p.import(saved)).toBe(true);
      expect(p.measurements).toHaveLength(2);
      for (const m of p.measurements) expect(p.ids).toContain(m.owner!.layerId);
      expect(p.toasts.join(' ')).not.toMatch(/not restored|waiting/);
      const again = p.save();
      expect(again.measurements).toHaveLength(2);
      expect(fileWorld(again)).toEqual(fileWorld(saved));
      expect(fileWorld(again)).toEqual({ mA: ON_A, mB: ON_B });
    }
  });

  it('anchor closed and only the survivor reopened: its work reattaches and survives two more cycles', async () => {
    let file = firstSave();
    // The file is reduced to B's work, as after A is closed and the session saved.
    file = { ...file, measurements: file.measurements.filter((m) => m.id === 'mB') };
    for (let cycle = 0; cycle < 3; cycle++) {
      const p = new Page([B]);
      expect(await p.import(file)).toBe(true);
      expect(p.measurements).toHaveLength(1);
      expect(p.measurements[0]!.owner!.layerId).toBe(p.ids[0]);
      // The open layer owns it, so outputs and the next save keep it.
      const view = { layers: [{ viewerId: 'cloud_0', stableId: p.ids[0]!, name: B.name }], activeViewerId: 'cloud_0' };
      expect(ownershipOf(p.measurements[0]!, view).kind).toBe('own');
      expect(p.world()).toEqual({ mB: ON_B });
      file = p.save();
      expect(file.measurements).toHaveLength(1);
      expect(fileWorld(file)).toEqual({ mB: ON_B });
    }
  });

  it('a scan that is not reopened keeps its work through a re-save and gets it back when reopened', async () => {
    const saved = firstSave();
    const partial = new Page([B]);
    await partial.import(saved);
    expect(partial.measurements.map((m) => m.id)).toEqual(['mB']);
    expect(partial.toasts.join(' ')).toMatch(/1 item is waiting for its scan \(“geom-a\.las”\)/);
    // Not in the scene, so no output can take it; it is still in the session.
    expect(heldSessionWork()?.measurements.map((m) => m.id)).toEqual(['mA']);
    const resaved = partial.save();
    expect(resaved.measurements.map((m) => m.id).sort()).toEqual(['mA', 'mB']);
    expect(fileWorld(resaved)).toEqual({ mA: ON_A, mB: ON_B });

    clearPendingSessionRestore();
    const both = new Page([A, B]);
    await both.import(resaved);
    expect(both.measurements.map((m) => m.id).sort()).toEqual(['mA', 'mB']);
    expect(heldSessionWork()).toBeNull();
    expect(fileWorld(both.save())).toEqual({ mA: ON_A, mB: ON_B });
  });

  it('the same source open twice: the work is held as ambiguous, never bound to the active copy', async () => {
    const saved = firstSave();
    const p = new Page([A, A, B]);
    await p.import(saved);
    expect(p.measurements.map((m) => m.id)).toEqual(['mB']);
    expect(p.toasts.join(' ')).toMatch(/1 item names a scan that more than one open scan matches/);
    expect(heldSessionWork()?.measurements.map((m) => m.id)).toEqual(['mA']);
  });

  it('reports what was applied: the evidence line counts only restored measurements', async () => {
    const saved = firstSave();
    const trusted = { ...saved, measurements: saved.measurements.map((m) => ({ ...m, trust: { grade: 'supported' } as never })) };
    const p = new Page([B]);
    await p.import(trusted);
    const toast = p.toasts.join(' ');
    expect(toast).not.toMatch(/2 measurements/);
    expect(toast).toMatch(/waiting for its scan/);
  });

  it('names the actual reason when the file has a project frame but no record for a layer', async () => {
    const saved = firstSave();
    const orphan = { ...saved, measurements: [...saved.measurements, { ...saved.measurements[1]!, id: 'mX', owner: { layerId: 'nowhere', frame: 'project' as const }, pickLayers: undefined }] };
    const p = new Page([A, B]);
    await p.import(orphan as InspectionSession);
    const toast = p.toasts.join(' ');
    expect(toast).toMatch(/1 item was not restored: the session’s project frame has no record of the scan/);
    expect(toast).not.toMatch(/does not record the multi-scan project frame/);
  });
});

describe('density reload hands the layer identity and its work to the replacement', () => {
  const facts = { fileName: 'same.las', sourcePoints: 10000, width: 10, depth: 10, height: 10, origin: [500000, 4000000, 0] as const, epsg: 32613 };
  const make = (): PointCloud => new PointCloud({ positions: new Float32Array([0, 0, 0, 10, 10, 10]), origin: [500000, 4000000, 0], sourceFormat: 'las', name: 'same.las' });

  function world(handOver: boolean) {
    let serial = 0;
    const ids = createLayerIdentityService({ generateId: () => `stable-${++serial}` });
    const clouds = new Map([['old', make()]]);
    const oldId = ids.bindOnLoad('old', facts, 'same.las', [])!.layerId;
    const measurements: Measurement[] = [{ id: 'before', kind: 'distance', name: 'd', points: [], owner: { layerId: oldId, frame: 'source-local' } } as Measurement];
    const file = new File([new Uint8Array(4)], 'same.las');
    const files = new Map([['old', file]]);
    let active = 'old';
    const hooks = exportLayerHooks({
      scans: { get activeId() { return active; }, setActive: (id) => { active = id; } },
      viewer: () => ({ getCloud: (id) => clouds.get(id), classificationEpoch: () => 0, clouds: () => [...clouds.keys()] }),
      sourceFiles: files, reduced: new Map(), notify: () => {},
      reopen: async (f) => {
        const prior = [...clouds.keys()];
        clouds.set('new', make());
        files.set('new', f);
        const freshId = ids.bindOnLoad('new', facts, 'same.las', prior)!.layerId;
        active = 'new';
        // Work taken on the copy while it loaded, stamped with the copy's own id.
        measurements.push({ id: 'during', kind: 'distance', name: 'd', points: [], owner: { layerId: freshId, frame: 'project' }, pickLayers: [freshId] } as Measurement);
      },
      removeLayer: (id) => { clouds.delete(id); files.delete(id); },
      ...(handOver ? {
        handOver: (from: string, to: string) => {
          const r = ids.handOver(from, to);
          if (!r) return false;
          relabelWorkLayer(measurements, r.released, r.kept);
          return true;
        },
      } : {}),
    });
    return { ids, hooks, clouds, measurements, oldId };
  }

  it('without a hand-over the original work is left naming a closed layer (the defect)', async () => {
    const w = world(false);
    await w.hooks.reloadLayer!('old', 10000);
    const view = { layers: [{ viewerId: 'new', stableId: w.ids.stableIdFor('new'), name: 'same.las' }], activeViewerId: 'new' };
    expect(ownershipOf(w.measurements[0]!, view).kind).toBe('closed');
  });

  it('the replacement keeps the original id, and work from before and during the reload is kept by a save', async () => {
    const w = world(true);
    await w.hooks.reloadLayer!('old', 10000);
    expect([...w.clouds.keys()]).toEqual(['new']);
    expect(w.ids.stableIdFor('new')).toBe(w.oldId);
    const view = { layers: [{ viewerId: 'new', stableId: w.ids.stableIdFor('new'), name: 'same.las' }], activeViewerId: 'new' };
    for (const m of w.measurements) expect(ownershipOf(m, view).kind).toBe('own');
    expect(w.measurements[1]!.pickLayers).toEqual([w.oldId]);
    expect(partitionSessionWork(w.measurements, view).keep).toHaveLength(2);
  });

  it('a session saved after the reload maps onto the same file opened in a fresh page', async () => {
    const w = world(true);
    await w.hooks.reloadLayer!('old', 10000);
    const rec = w.ids.recordFor('new')!;
    expect(rec.layerId).toBe(w.oldId);
    const frame: SessionProjectFrame = {
      projectOrigin: [500000, 4000000, 0],
      layers: [{ layerId: rec.layerId, sourceFingerprint: rec.fingerprint, sourceName: 'same.las', sourceOrigin: [500000, 4000000, 0], sourceToProject: [0, 0, 0], upAxis: 'z' }],
    };
    // A fresh page mints its own id for the same file.
    const fresh = createLayerIdentityService({ generateId: () => 'fresh-page' }).bindOnLoad('v', facts, 'same.las', [])!;
    const m = mapSessionLayers(frame, [{ layerId: fresh.layerId, fingerprint: fresh.fingerprint, sourceOrigin: [500000, 4000000, 0], upAxis: 'z', epsg: 32613 }]);
    expect(m.byId.get(w.oldId)).toEqual({ kind: 'resolved', liveId: 'fresh-page' });
  });

  it('refuses the replacement, keeping the original, when the copy is not the same source', async () => {
    const w = world(true);
    const reopen = w.hooks.reloadLayer!;
    // A copy at another origin is not the same source.
    w.clouds.set('old', new PointCloud({ positions: new Float32Array([0, 0, 0, 10, 10, 10]), origin: [1, 2, 3], sourceFormat: 'las', name: 'same.las' }));
    await reopen('old', 10000);
    expect([...w.clouds.keys()]).toEqual(['old']);
    expect(w.ids.stableIdFor('old')).toBe(w.oldId);
  });
});
