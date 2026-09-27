/**
 * resultsIndex.ts
 *
 * A read-only index over the results the session already holds. Each owner
 * keeps its own state: measurements in the measure controller, the terrain
 * surface on the Analyse panel, contour layers in their derived-layer store,
 * the Observatory run in its runner, the lab runs in their lab modules and the
 * findings in the Export panel's ledger. This module copies none of it. An
 * adapter reads its owner on demand and returns display fields plus a way
 * back: an id, a title, the layer it came from, the page that owns it and a
 * point to look at. Nothing here stores a number, a grid or a geometry, so
 * the index cannot disagree with its owner.
 *
 * Updates are pushed. Each adapter subscribes to its owner's own change
 * signal through `watch`, which the index calls on every refresh so an owner
 * built later (the Analyse panel, the contour store, the findings ledger) is
 * picked up on the first refresh after it exists.
 *
 * `createdAt` is the first time the index saw an entry. None of the owners
 * record a creation time, and this one is only used to order the list.
 */

import type { WorkspaceMode } from '../../ui/workspace/DesktopWorkspace';

export type ResultType =
  | 'measurement'
  | 'terrain'
  | 'contours'
  | 'observatory'
  | 'flow-pulse'
  | 'terrain-access'
  | 'finding';

export const RESULT_TYPE_ORDER: readonly ResultType[] = [
  'measurement', 'terrain', 'contours', 'flow-pulse', 'terrain-access', 'observatory', 'finding',
];

export const RESULT_TYPE_LABELS: Readonly<Record<ResultType, string>> = {
  measurement: 'Measurements',
  terrain: 'Terrain',
  contours: 'Contours',
  observatory: 'Observatory',
  'flow-pulse': 'Flow Pulse',
  'terrain-access': 'Terrain Access',
  finding: 'Findings',
};

/** Where a result lives in the workspace. */
export interface ResultRoute {
  readonly mode: WorkspaceMode;
  readonly page: string | null;
}

/** A 3D point in the render frame, used only to aim the camera. */
export type ResultAnchor = readonly [number, number, number];

/** Products the Export mode can preselect. Mirrors `ExportProduct`. */
export type ResultExportProduct = 'measurements' | 'findings' | 'terrain-dem' | 'contours';

export interface ResultEntry {
  /** Stable across refreshes: `<type>:<owner id>`. */
  readonly id: string;
  readonly type: ResultType;
  /** Display text only. Comes from file names and metadata: render as text. */
  readonly title: string;
  readonly createdAt: number;
  /** The layer id the result was computed on, or null when not recorded. */
  readonly sourceIdentity: string | null;
  readonly status: 'ready' | 'hidden' | 'stale';
  /** The task page that owns the result. */
  readonly route: ResultRoute;
  /** A point to look at, or null when the owner has no geometry to aim at. */
  readonly anchor: ResultAnchor | null;
  /** Radius around `anchor` to keep in view, or null to keep the distance. */
  readonly fit: number | null;
  /** The Export mode product to preselect, when the result has one. */
  readonly exportProduct?: ResultExportProduct;
}

/** What an adapter returns: an entry before the index stamps its time. */
export type ResultDraft = Omit<ResultEntry, 'createdAt'>;

export interface ResultSource {
  list(): readonly ResultDraft[];
  /**
   * Subscribe `notify` to the owner's change signal, if the owner exists and
   * is not already subscribed. Called on every refresh; must be idempotent.
   */
  watch?(notify: () => void): void;
  /** Drop every subscription. */
  dispose?(): void;
}

export interface ResultsIndex {
  /** Newest first. */
  entries(): readonly ResultEntry[];
  /** Re-read every source; notifies subscribers when the list changed. */
  refresh(): void;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

/**
 * Keeps one subscription per owner instance: re-subscribes when the owner
 * object changes (a panel rebuilt), and drops the old one.
 */
function ownerWatch<T extends object>(
  owner: () => T | null,
  subscribe: (o: T, notify: () => void) => () => void,
): Pick<ResultSource, 'watch' | 'dispose'> {
  let current: T | null = null;
  let off: (() => void) | null = null;
  return {
    watch(notify) {
      let o: T | null = null;
      try { o = owner(); } catch { o = null; }
      if (o === current) return;
      off?.();
      off = null;
      current = o;
      if (o) off = subscribe(o, notify);
    },
    dispose() { off?.(); off = null; current = null; },
  };
}

/**
 * The layer active when the index first saw an id stands in for owners that
 * do not record one. It is what the user was looking at when the result
 * landed.
 */
function firstSeenLayer(activeLayer: () => string | null) {
  const seen = new Map<string, string | null>();
  return {
    of(id: string): string | null {
      if (!seen.has(id)) seen.set(id, activeLayer());
      return seen.get(id) ?? null;
    },
    prune(live: ReadonlySet<string>): void {
      for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
    },
  };
}

function centroid(points: readonly ResultAnchor[]): ResultAnchor | null {
  if (points.length === 0) return null;
  let x = 0, y = 0, z = 0;
  for (const p of points) { x += p[0]; y += p[1]; z += p[2]; }
  const n = points.length;
  return [x / n, y / n, z / n];
}

/** The grid fields that place a DTM in the scene (see `flowOverlayGeometry`). */
export interface DtmExtent {
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
  readonly originH1: number;
  readonly originH2: number;
  readonly z: ArrayLike<number>;
  readonly coverage: ArrayLike<number>;
}

/**
 * The centre of a DTM grid in the render frame and the radius that holds it,
 * placed the way the flow and access overlays place their cells. The height is
 * the mean over covered cells. Reads the grid; keeps nothing.
 */
export function dtmAim(dtm: DtmExtent, upAxis: 'z' | 'y' | null): { anchor: ResultAnchor; fit: number } | null {
  if (!(dtm.cols > 0 && dtm.rows > 0 && dtm.cellSizeM > 0)) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < dtm.cols * dtm.rows; i++) {
    const v = dtm.z[i]!;
    if (dtm.coverage[i]! > 0 && Number.isFinite(v)) { sum += v; n++; }
  }
  const h = n > 0 ? sum / n : 0;
  const east = dtm.originH1 + ((dtm.cols - 1) / 2) * dtm.cellSizeM;
  const north = dtm.originH2 + ((dtm.rows - 1) / 2) * dtm.cellSizeM;
  const anchor: ResultAnchor = upAxis === 'y' ? [east, h, -north] : [east, north, h];
  return { anchor, fit: (Math.hypot(dtm.cols, dtm.rows) * dtm.cellSizeM) / 2 };
}

const OUTPUT: WorkspaceMode = 'output';

/** The measure controller's read side the adapter needs. */
export interface MeasurementReader {
  getMeasurements(): readonly {
    readonly id: string;
    readonly name: string;
    readonly points: readonly ResultAnchor[];
    readonly owner?: { readonly layerId?: string };
  }[];
}

/**
 * A measurement carries its layer only when more than one layer was mounted
 * (`WorkOwnership`, a stable id). `layerOf` turns that into the viewer id the
 * other owners use; without an owner the first-seen layer stands in. The
 * measure controller's change callback belongs to the host, which forwards it
 * as a shell sync, so this adapter has no `watch`.
 */
export function measurementSource(
  read: () => MeasurementReader | null,
  layerOf: (stableId: string) => string | null = (id) => id,
  activeLayer: () => string | null = () => null,
): ResultSource {
  const seen = firstSeenLayer(activeLayer);
  return {
    list: () => {
      const ms = read()?.getMeasurements() ?? [];
      seen.prune(new Set(ms.map((m) => m.id)));
      return ms.map((m) => {
        const owner = m.owner?.layerId;
        return {
          id: `measurement:${m.id}`,
          type: 'measurement' as const,
          title: m.name,
          sourceIdentity: owner ? layerOf(owner) ?? owner : seen.of(m.id),
          status: 'ready' as const,
          route: { mode: 'work' as const, page: 'measure' },
          anchor: centroid(m.points),
          fit: null,
          exportProduct: 'measurements' as const,
        };
      });
    },
  };
}

/** The Analyse panel's read side: the result on screen, by reference. */
export interface TerrainReader {
  resultRef(): {
    readonly result: { readonly dtm: DtmExtent };
    readonly scanId: string | null;
    readonly fresh: boolean;
    readonly filename: string | null;
    readonly sceneUpAxis: 'z' | 'y' | null;
  } | null;
  subscribeResult(fn: () => void): () => void;
}

/** `dtmAim` once per grid object: a new result is a new grid. */
const aimCache = new WeakMap<object, { anchor: ResultAnchor; fit: number } | null>();
export function cachedDtmAim(dtm: DtmExtent, upAxis: 'z' | 'y' | null): { anchor: ResultAnchor; fit: number } | null {
  if (!aimCache.has(dtm)) aimCache.set(dtm, dtmAim(dtm, upAxis));
  return aimCache.get(dtm) ?? null;
}

export function terrainSource(read: () => TerrainReader | null): ResultSource {
  return {
    ...ownerWatch(read, (panel, notify) => panel.subscribeResult(notify)),
    list: () => {
      const ref = read()?.resultRef() ?? null;
      if (!ref) return [];
      const aim = cachedDtmAim(ref.result.dtm, ref.sceneUpAxis);
      return [{
        id: `terrain:${ref.scanId ?? 'unknown'}`,
        type: 'terrain' as const,
        title: ref.filename ? `Terrain surface, ${ref.filename}` : 'Terrain surface',
        sourceIdentity: ref.scanId,
        status: ref.fresh ? 'ready' as const : 'stale' as const,
        route: { mode: 'analyse' as const, page: 'terrain' },
        anchor: aim?.anchor ?? null,
        fit: aim?.fit ?? null,
        exportProduct: 'terrain-dem' as const,
      }];
    },
  };
}

/** The derived layers the terrain runner keeps, and its change signal. */
export interface ContourReader {
  getContourLayers(): {
    layerFor(scanId: string): {
      readonly name: string;
      readonly visible: boolean;
      readonly sourceScanIds: readonly string[];
      readonly bounds: readonly [number, number, number, number, number, number] | null;
    } | undefined;
  } | null;
  subscribeDerivedLayers(fn: () => void): () => void;
}

export function contourSource(read: () => ContourReader | null, scanIds: () => readonly string[]): ResultSource {
  return {
    ...ownerWatch(read, (runner, notify) => runner.subscribeDerivedLayers(notify)),
    list: () => {
      const service = read()?.getContourLayers() ?? null;
      if (!service) return [];
      const out: ResultDraft[] = [];
      for (const scanId of scanIds()) {
        const layer = service.layerFor(scanId);
        if (!layer) continue;
        const b = layer.bounds;
        out.push({
          id: `contours:${scanId}`,
          type: 'contours',
          title: layer.name,
          sourceIdentity: layer.sourceScanIds[0] ?? scanId,
          status: layer.visible ? 'ready' : 'hidden',
          route: { mode: 'analyse', page: 'contours' },
          anchor: b ? [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] : null,
          fit: b ? Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 : null,
          exportProduct: 'contours',
        });
      }
      return out;
    },
  };
}

/** The shared registry for owners in lazy chunks (see `resultSignals.ts`). */
export interface SignalsReader {
  observatory(): { getState(): { readonly phase: string; readonly outcome?: { readonly status: string; readonly record?: { readonly id: string }; readonly domain?: { readonly min: ResultAnchor; readonly max: ResultAnchor } } } } | null;
  /** World to scene for the committed Observatory run, as its overlay is placed. */
  observatoryToScene(): ((p: ResultAnchor) => ResultAnchor) | null;
  lab(kind: 'flow-pulse' | 'terrain-access'): { readonly outcome: object; readonly layerId: string | null; readonly filename: string | null } | null;
  subscribe(fn: () => void): () => void;
}

/**
 * One watch on the registry for the three owners that share it. The lab runs
 * read the Analyse surface, so they aim at its extent.
 */
export function signalSources(
  signals: SignalsReader,
  activeLayer: () => string | null,
  terrainAim: () => { anchor: ResultAnchor; fit: number } | null,
): ResultSource {
  const seen = firstSeenLayer(activeLayer);
  let off: (() => void) | null = null;
  const labTitle = (name: string, filename: string | null): string => (filename ? `${name}, ${filename}` : name);
  return {
    watch(notify) { off ??= signals.subscribe(notify); },
    dispose() { off?.(); off = null; },
    list: () => {
      const out: ResultDraft[] = [];
      for (const [kind, name, page] of [
        ['flow-pulse', 'Flow Pulse run', 'flow'],
        ['terrain-access', 'Terrain Access route', 'access'],
      ] as const) {
        const run = signals.lab(kind);
        if (!run) continue;
        const aim = terrainAim();
        out.push({
          id: `${kind}:${run.layerId ?? 'unknown'}`,
          type: kind,
          title: labTitle(name, run.filename),
          sourceIdentity: run.layerId,
          status: 'ready',
          route: { mode: 'analyse', page },
          anchor: aim?.anchor ?? null,
          fit: aim?.fit ?? null,
        });
      }
      const state = signals.observatory()?.getState();
      const ok = state?.phase === 'committed' && state.outcome?.status === 'ok' ? state.outcome : undefined;
      const record = ok?.record;
      const toScene = signals.observatoryToScene();
      const d = ok?.domain;
      const lo = d && toScene ? toScene(d.min) : null;
      const hi = d && toScene ? toScene(d.max) : null;
      const live = new Set<string>();
      if (record) {
        const id = `observatory:${record.id}`;
        live.add(id);
        out.push({
          id,
          type: 'observatory',
          title: 'Observatory run',
          sourceIdentity: seen.of(id),
          status: 'ready',
          route: { mode: 'analyse', page: 'observatory' },
          anchor: lo && hi ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : null,
          fit: lo && hi ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 : null,
        });
      }
      seen.prune(live);
      return out;
    },
  };
}

/** The Export panel's read side of the findings ledger. */
export interface FindingsReader {
  findingsLedger(): {
    readonly all: ReadonlyArray<{ readonly label: string; readonly value: number; readonly unit: string }>;
    readonly ownerId: string | null;
  } | null;
  watchFindings(fn: () => void): () => void;
}

export function findingsSource(read: () => FindingsReader | null): ResultSource {
  // Stable ids by object identity: a finding has no id of its own.
  const ids = new WeakMap<object, number>();
  let next = 0;
  return {
    ...ownerWatch(read, (panel, notify) => panel.watchFindings(notify)),
    list: () => {
      const ledger = read()?.findingsLedger() ?? null;
      if (!ledger) return [];
      return ledger.all.map((f) => {
        let id = ids.get(f);
        if (id === undefined) { id = next++; ids.set(f, id); }
        return {
          id: `finding:${id}`,
          type: 'finding' as const,
          title: `${f.label}, ${f.value} ${f.unit}`,
          sourceIdentity: ledger.ownerId,
          status: 'ready' as const,
          route: { mode: OUTPUT, page: null },
          anchor: null,
          fit: null,
          exportProduct: 'findings' as const,
        };
      });
    },
  };
}

function sameList(a: readonly ResultEntry[], b: readonly ResultEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => {
    const o = b[i]!;
    return e.id === o.id && e.title === o.title && e.status === o.status && e.sourceIdentity === o.sourceIdentity
      && e.anchor?.join() === o.anchor?.join();
  });
}

export function createResultsIndex(sources: readonly ResultSource[], now: () => number = Date.now): ResultsIndex {
  const firstSeen = new Map<string, number>();
  const order = new Map<string, number>();
  const listeners = new Set<() => void>();
  let current: ResultEntry[] = [];
  let seq = 0;
  let refreshing = false;
  let again = false;

  const api: ResultsIndex = {
    entries: () => current,
    refresh() {
      // A notify that lands while a refresh runs re-runs it once at the end.
      if (refreshing) { again = true; return; }
      refreshing = true;
      try {
        do {
          again = false;
          const drafts: ResultDraft[] = [];
          for (const s of sources) {
            try { s.watch?.(api.refresh); } catch { /* an owner mid-teardown has no signal */ }
            try { drafts.push(...s.list()); } catch { /* an owner mid-teardown lists nothing */ }
          }
          const live = new Set(drafts.map((d) => d.id));
          for (const id of [...firstSeen.keys()]) {
            if (!live.has(id)) { firstSeen.delete(id); order.delete(id); }
          }
          for (const d of drafts) {
            if (!firstSeen.has(d.id)) { firstSeen.set(d.id, now()); order.set(d.id, seq++); }
          }
          const nextList = drafts
            .map((d) => ({ ...d, createdAt: firstSeen.get(d.id)! }))
            .sort((a, b) => b.createdAt - a.createdAt || order.get(b.id)! - order.get(a.id)!);
          if (!sameList(current, nextList)) {
            current = nextList;
            for (const fn of [...listeners]) fn();
          }
        } while (again);
      } finally {
        refreshing = false;
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dispose() {
      for (const s of sources) s.dispose?.();
      listeners.clear();
    },
  };
  return api;
}
