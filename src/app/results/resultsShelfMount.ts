/**
 * resultsShelfMount.ts
 *
 * Builds the results index over the live owners and mounts the shelf on it.
 * Part of the lazy workspace shell chunk; `main.ts` passes the owners and
 * nothing else.
 *
 * Refresh signals, no polling: the Analyse panel's result signal, the terrain
 * runner's derived-layer signal, the Export panel's findings signal and the
 * shared registry in `resultSignals.ts` (Observatory runner, lab runs) push
 * into the index. Measurements reach it through the shell's `sync()`, which
 * the host already calls on every measurement change and mode change.
 */

import type { WorkspaceRoute } from '../workspace/workspaceRouter';
import type { TerrainExportsLane } from '../../ui/ExportPanel';
import {
  cachedDtmAim,
  contourSource,
  createResultsIndex,
  findingsSource,
  measurementSource,
  signalSources,
  terrainSource,
  type ContourReader,
  type FindingsReader,
  type MeasurementReader,
  type ResultExportProduct,
  type ResultsIndex,
  type TerrainReader,
} from './resultsIndex';
import { createResultsShelf, type ResultsShelf } from './resultsShelf';
import {
  labRun,
  observatoryRunnerView,
  observatorySceneTransform,
  onResultReopenTaken,
  requestResultReopen,
  resultReopenPending,
  subscribeResultSignals,
  takeResultReopen,
  type ModalResultKind,
} from './resultSignals';

/** The palette actions that open each lab result on its page. */
const LAB_PAGE_ACTION: Readonly<Record<ModalResultKind, string>> = {
  'flow-pulse': 'analyse.flowPulse',
  'terrain-access': 'analyse.terrainAccess',
  observatory: 'analyse.observatory',
};

/** How long a lab has to take its reopen request before the shelf shows its route. */
export const LAB_OPEN_FALLBACK_MS = 8_000;

type Pose = { position: [number, number, number]; target: [number, number, number] };

/** The Analyse panel's read side plus its own export hand-off. */
export interface ShelfTerrainPanel extends TerrainReader {
  exportProduct(kind: 'dem' | 'contours'): boolean;
}

/** The Export panel's read side plus its product selection. */
export interface ShelfExportPanel extends FindingsReader {
  readonly element: HTMLElement;
  select(product: ResultExportProduct): boolean;
  setTerrainExports(t: TerrainExportsLane | null): void;
}

/** What the host hands the shell for the shelf: the owners, by reference. */
export interface ResultsShelfSources {
  readonly viewer: {
    readonly measure: MeasurementReader;
    clouds(): string[];
    getCloud(id: string): { readonly name: string; readonly acquisitionStations?: { readonly stations: readonly unknown[] } } | undefined;
    getCameraPose(): Pose;
    applyCameraPose(pose: Pose): void;
  };
  /** Viewer id to stable layer id, for measurement owners. */
  readonly identity: { stableIdFor(viewerId: string): string | null | undefined };
  /** The active layer, read only; the shelf never sets it. */
  readonly scans: { activeExportTargetId(): string | null; onActiveChange(fn: () => void): () => void };
  /** The terrain runner: its contour layers and their change signal. */
  readonly terrainRunner: ContourReader;
}

export interface MountedResultsShelf extends ResultsShelf {
  readonly index: ResultsIndex;
  refresh(): void;
}

/**
 * A pose that looks at `anchor`. With `fit`, the camera backs off along its
 * current direction until a sphere of that radius fills about the view;
 * without, it keeps the current viewing distance.
 */
export function poseAt(current: Pose, anchor: readonly [number, number, number], fit: number | null = null): Pose {
  let off = [0, 1, 2].map((i) => current.position[i]! - current.target[i]!);
  if (fit != null && fit > 0) {
    const len = Math.hypot(off[0]!, off[1]!, off[2]!) || 1;
    const want = fit * 2.4;
    off = off.map((v) => (v / len) * want);
  }
  return {
    target: [anchor[0], anchor[1], anchor[2]],
    position: [anchor[0] + off[0]!, anchor[1] + off[1]!, anchor[2] + off[2]!],
  };
}

export function mountResultsShelf(
  host: ResultsShelfSources,
  analysePanel: () => ShelfTerrainPanel | null,
  exportPanel: ShelfExportPanel | null,
  navigate: (route: WorkspaceRoute) => void,
  runAction?: (id: string) => void,
): MountedResultsShelf {
  const src = {
    viewer: host.viewer,
    measure: () => host.viewer.measure,
    terrain: analysePanel,
    activeLayerId: () => host.scans.activeExportTargetId(),
  };
  const terrainAim = (): ReturnType<typeof cachedDtmAim> => {
    const ref = src.terrain()?.resultRef();
    return ref ? cachedDtmAim(ref.result.dtm, ref.sceneUpAxis) : null;
  };
  const index = createResultsIndex([
    measurementSource(
      src.measure,
      (stable) => src.viewer.clouds().find((id) => host.identity.stableIdFor(id) === stable) ?? null,
      src.activeLayerId,
    ),
    terrainSource(src.terrain),
    contourSource(() => host.terrainRunner, () => src.viewer.clouds()),
    signalSources({ observatory: observatoryRunnerView, observatoryToScene: observatorySceneTransform, lab: labRun, subscribe: subscribeResultSignals }, src.activeLayerId, terrainAim),
    findingsSource(() => exportPanel),
  ]);

  // The Export mode's terrain lane runs the Analyse panel's own exports.
  const terrainExports: TerrainExportsLane = {
    ready: () => !!src.terrain()?.resultRef(),
    run: (kind: 'dem' | 'contours') => { src.terrain()?.exportProduct(kind); },
  };
  exportPanel?.setTerrainExports(terrainExports);
  let hadTerrain = terrainExports.ready();
  let lastRun: unknown = src.terrain()?.resultRef()?.result ?? null;

  const fallbacks = new Map<ModalResultKind, ReturnType<typeof setTimeout>>();
  const clearFallback = (kind: ModalResultKind): void => {
    const t = fallbacks.get(kind);
    if (t !== undefined) { clearTimeout(t); fallbacks.delete(kind); }
  };
  const offTaken = onResultReopenTaken(clearFallback);
  const shelf = createResultsShelf({
    index,
    navigate,
    aim: (anchor, fit) => src.viewer.applyCameraPose(poseAt(src.viewer.getCameraPose(), anchor, fit)),
    exportTo: (product) => {
      navigate({ mode: 'output', page: null });
      return !!product && !!exportPanel?.select(product);
    },
    activeLayerId: src.activeLayerId,
    // Labs and the Observatory are Analyse pages: Focus opens the page on the
    // run it holds, with nothing recomputed. When the lab never takes the
    // request (its chunk failed to load), the shelf shows the page's route.
    openLabPage: runAction
      ? (e) => {
        if (!(e.type in LAB_PAGE_ACTION)) return false;
        const kind = e.type as ModalResultKind;
        requestResultReopen(kind);
        try {
          runAction(LAB_PAGE_ACTION[kind]);
        } catch {
          takeResultReopen(kind);
          return false;
        }
        // The fallback only reads the request: a chunk that loads later still
        // takes it and shows the kept run instead of computing a new one.
        clearFallback(kind);
        if (!resultReopenPending(kind)) return true;
        fallbacks.set(kind, setTimeout(() => {
          fallbacks.delete(kind);
          if (resultReopenPending(kind)) navigate(e.route);
        }, LAB_OPEN_FALLBACK_MS));
        return true;
      }
      : undefined,
    layerName: (id) => src.viewer.getCloud(id)?.name ?? null,
  });
  const offIndex = index.subscribe(() => {
    const has = terrainExports.ready();
    // A new run re-renders the lane too, so the health row reads that run.
    const run = src.terrain()?.resultRef()?.result ?? null;
    if (has !== hadTerrain || run !== lastRun) {
      hadTerrain = has; lastRun = run;
      exportPanel?.setTerrainExports(terrainExports);
    }
  });
  const refresh = (): void => { index.refresh(); shelf.sync(); };
  // The other-layer notes depend on the active layer, not on the results.
  const offActive = host.scans.onActiveChange(() => shelf.sync());
  refresh();
  const toggle = shelf.element.querySelector('.olv-results-toggle');
  toggle?.addEventListener('click', refresh, { capture: true });
  return {
    ...shelf,
    index,
    refresh,
    dispose: () => {
      offIndex(); offActive(); offTaken();
      for (const t of fallbacks.values()) clearTimeout(t);
      fallbacks.clear();
      toggle?.removeEventListener('click', refresh, { capture: true });
      index.dispose(); exportPanel?.setTerrainExports(null); shelf.dispose();
    },
  };
}
