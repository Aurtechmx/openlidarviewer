/**
 * resultsIndex.ts
 *
 * A read-only index over the results the session already holds. Each runner
 * keeps its own state (measurements in the measure controller, the terrain
 * surface on the Analyse panel, contour layers in their derived-layer
 * service); this module does not copy any of it. An adapter reads its owner on
 * demand and returns display fields plus a reference back: an id, a title, the
 * layer it came from and how to get back to it. Nothing here stores a number,
 * a grid or a geometry, so the index cannot disagree with its owner.
 *
 * `createdAt` is the first time the index saw an entry. None of the owners
 * record a creation time, and this one is only used to order the list.
 */

import type { WorkspaceMode } from '../../ui/workspace/DesktopWorkspace';

export type ResultType = 'measurement' | 'terrain' | 'contours';

export const RESULT_TYPE_LABELS: Readonly<Record<ResultType, string>> = {
  measurement: 'Measurements',
  terrain: 'Terrain',
  contours: 'Contours',
};

/** Where a result lives in the workspace. */
export interface ResultRoute {
  readonly mode: WorkspaceMode;
  readonly page: string | null;
}

/** A 3D point in the render frame, used only to aim the camera. */
export type ResultAnchor = readonly [number, number, number];

export interface ResultEntry {
  /** Stable across refreshes: `<type>:<owner id>`. */
  readonly id: string;
  readonly type: ResultType;
  /** Display text only. Comes from file names and metadata: render as text. */
  readonly title: string;
  readonly createdAt: number;
  /** The layer id the result was computed on, or null when not recorded. */
  readonly sourceIdentity: string | null;
  readonly status: 'ready' | 'hidden';
  /** The task page that owns the result. */
  readonly route: ResultRoute;
  /** A point to look at, or null when the owner has no geometry to aim at. */
  readonly anchor: ResultAnchor | null;
  /** Export route, when the result has an export. */
  readonly exportRoute?: ResultRoute;
}

/** What an adapter returns: an entry before the index stamps its time. */
export type ResultDraft = Omit<ResultEntry, 'createdAt'>;

export interface ResultSource {
  list(): readonly ResultDraft[];
}

export interface ResultsIndex {
  /** Newest first. */
  entries(): readonly ResultEntry[];
  /** Re-read every source; notifies subscribers when the list changed. */
  refresh(): void;
  subscribe(fn: () => void): () => void;
}

const EXPORT_ROUTE: ResultRoute = { mode: 'output', page: null };

function centroid(points: readonly ResultAnchor[]): ResultAnchor | null {
  if (points.length === 0) return null;
  let x = 0, y = 0, z = 0;
  for (const p of points) { x += p[0]; y += p[1]; z += p[2]; }
  const n = points.length;
  return [x / n, y / n, z / n];
}

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
 * other owners use. Without an owner, the layer active when the index first saw
 * the measurement stands in, which is what the user was looking at when it was
 * placed.
 */
export function measurementSource(
  read: () => MeasurementReader | null,
  layerOf: (stableId: string) => string | null = (id) => id,
  activeLayer: () => string | null = () => null,
): ResultSource {
  const seenOn = new Map<string, string | null>();
  return {
    list: () => {
      const ms = read()?.getMeasurements() ?? [];
      const live = new Set(ms.map((m) => m.id));
      for (const id of [...seenOn.keys()]) if (!live.has(id)) seenOn.delete(id);
      return ms.map((m) => {
        const owner = m.owner?.layerId;
        if (!owner && !seenOn.has(m.id)) seenOn.set(m.id, activeLayer());
        return {
          id: `measurement:${m.id}`,
          type: 'measurement' as const,
          title: m.name,
          sourceIdentity: owner ? layerOf(owner) ?? owner : seenOn.get(m.id) ?? null,
          status: 'ready' as const,
          route: { mode: 'work' as const, page: 'measure' },
          anchor: centroid(m.points),
          exportRoute: EXPORT_ROUTE,
        };
      });
    },
  };
}

/** The Analyse panel's read side: the fresh surface and the layer it came from. */
export interface TerrainReader {
  flowPulseInput(): { readonly layerId: string | null; readonly filename: string | null } | null;
}

export function terrainSource(read: () => TerrainReader | null): ResultSource {
  return {
    list: () => {
      const input = read()?.flowPulseInput() ?? null;
      if (!input) return [];
      return [{
        id: `terrain:${input.layerId ?? 'unknown'}`,
        type: 'terrain' as const,
        title: input.filename ? `Terrain surface, ${input.filename}` : 'Terrain surface',
        sourceIdentity: input.layerId,
        status: 'ready' as const,
        route: { mode: 'analyse' as const, page: 'terrain' },
        anchor: null,
        exportRoute: EXPORT_ROUTE,
      }];
    },
  };
}

/** The contour service's read side, keyed by the scan a layer was derived from. */
export interface ContourReader {
  layerFor(scanId: string): {
    readonly name: string;
    readonly visible: boolean;
    readonly sourceScanIds: readonly string[];
    readonly bounds: readonly [number, number, number, number, number, number] | null;
  } | undefined;
}

export function contourSource(read: () => ContourReader | null, scanIds: () => readonly string[]): ResultSource {
  return {
    list: () => {
      const service = read();
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
          exportRoute: EXPORT_ROUTE,
        });
      }
      return out;
    },
  };
}

function sameList(a: readonly ResultEntry[], b: readonly ResultEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => {
    const o = b[i]!;
    return e.id === o.id && e.title === o.title && e.status === o.status && e.sourceIdentity === o.sourceIdentity;
  });
}

export function createResultsIndex(sources: readonly ResultSource[], now: () => number = Date.now): ResultsIndex {
  const firstSeen = new Map<string, number>();
  const listeners = new Set<() => void>();
  let current: ResultEntry[] = [];
  let seq = 0;
  const order = new Map<string, number>();

  const api: ResultsIndex = {
    entries: () => current,
    refresh() {
      const drafts: ResultDraft[] = [];
      for (const s of sources) {
        try { drafts.push(...s.list()); } catch { /* an owner mid-teardown lists nothing */ }
      }
      const live = new Set(drafts.map((d) => d.id));
      for (const id of [...firstSeen.keys()]) {
        if (!live.has(id)) { firstSeen.delete(id); order.delete(id); }
      }
      for (const d of drafts) {
        if (!firstSeen.has(d.id)) { firstSeen.set(d.id, now()); order.set(d.id, seq++); }
      }
      const next = drafts
        .map((d) => ({ ...d, createdAt: firstSeen.get(d.id)! }))
        .sort((a, b) => b.createdAt - a.createdAt || order.get(b.id)! - order.get(a.id)!);
      if (sameList(current, next)) return;
      current = next;
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
  return api;
}
