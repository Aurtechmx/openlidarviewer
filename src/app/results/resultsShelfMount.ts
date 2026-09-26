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
import { labRun, observatoryRunnerView, observatorySceneTransform, subscribeResultSignals } from './resultSignals';

type Pose = { position: [number, number, number]; target: [number, number, number] };

/** The Analyse panel's read side plus its own export hand-off. */
export interface ShelfTerrainPanel extends TerrainReader {
  exportProduct(kind: 'dem' | 'contours'): boolean;
}

/** The Export panel's read side plus its product selection. */
export interface ShelfExportPanel extends FindingsReader {
  readonly element: HTMLElement;
  select(product: ResultExportProduct): boolean;
  setTerrainExports(t: { ready(): boolean; run(kind: 'dem' | 'contours'): void } | null): void;
}

/** What the host hands the shell for the shelf: the owners, by reference. */
export interface ResultsShelfSources {
  readonly viewer: {
    readonly measure: MeasurementReader;
    clouds(): string[];
    getCloud(id: string): { readonly name: string } | undefined;
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
  const terrainExports = {
    ready: () => !!src.terrain()?.resultRef(),
    run: (kind: 'dem' | 'contours') => { src.terrain()?.exportProduct(kind); },
  };
  exportPanel?.setTerrainExports(terrainExports);
  let hadTerrain = terrainExports.ready();

  const shelf = createResultsShelf({
    index,
    navigate,
    aim: (anchor, fit) => src.viewer.applyCameraPose(poseAt(src.viewer.getCameraPose(), anchor, fit)),
    exportTo: (product) => {
      navigate({ mode: 'output', page: null });
      return !!product && !!exportPanel?.select(product);
    },
    activeLayerId: src.activeLayerId,
    layerName: (id) => src.viewer.getCloud(id)?.name ?? null,
  });
  const offIndex = index.subscribe(() => {
    const has = terrainExports.ready();
    if (has !== hadTerrain) { hadTerrain = has; exportPanel?.setTerrainExports(terrainExports); }
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
    dispose: () => { offIndex(); offActive(); index.dispose(); exportPanel?.setTerrainExports(null); shelf.dispose(); },
  };
}
