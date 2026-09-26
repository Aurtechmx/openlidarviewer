/**
 * resultsShelfMount.ts
 *
 * Builds the results index over the live owners and mounts the shelf on it.
 * Part of the lazy workspace shell chunk; `main.ts` passes the owners and
 * nothing else.
 *
 * Refresh signals: the shell calls `refresh()` when a measurement changes and
 * when the mode changes. The Analyse panel and the contour service have no
 * change signal of their own, so a slow re-read (every 2 s while the page is
 * visible) picks up a finished analysis or a closed scan. The re-read only
 * lists ids and titles; it never touches a result's data.
 */

import type { WorkspaceRoute } from '../workspace/workspaceRouter';
import {
  contourSource,
  createResultsIndex,
  measurementSource,
  terrainSource,
  type ContourReader,
  type MeasurementReader,
  type ResultsIndex,
  type TerrainReader,
} from './resultsIndex';
import { createResultsShelf, type ResultsShelf } from './resultsShelf';

type Pose = { position: [number, number, number]; target: [number, number, number] };

export interface ResultsShelfSources {
  readonly viewer: {
    clouds(): string[];
    getCloud(id: string): { readonly name: string } | undefined;
    getCameraPose(): Pose;
    applyCameraPose(pose: Pose): void;
  };
  measure(): MeasurementReader | null;
  terrain(): TerrainReader | null;
  contours(): ContourReader | null;
  activeLayerId(): string | null;
  /** Viewer id to stable layer id, for measurement owners. */
  readonly layerIdentity: { stableIdFor(viewerId: string): string | null | undefined };
}

export interface MountedResultsShelf extends ResultsShelf {
  readonly index: ResultsIndex;
  refresh(): void;
}

/** A pose that looks at `anchor` from the current viewing offset. */
export function poseAt(current: Pose, anchor: readonly [number, number, number]): Pose {
  const off = [0, 1, 2].map((i) => current.position[i]! - current.target[i]!);
  return {
    target: [anchor[0], anchor[1], anchor[2]],
    position: [anchor[0] + off[0]!, anchor[1] + off[1]!, anchor[2] + off[2]!],
  };
}

const REREAD_MS = 2000;

export function mountResultsShelf(
  src: ResultsShelfSources,
  navigate: (route: WorkspaceRoute) => void,
): MountedResultsShelf {
  const index = createResultsIndex([
    measurementSource(
      src.measure,
      (stable) => src.viewer.clouds().find((id) => src.layerIdentity.stableIdFor(id) === stable) ?? null,
      src.activeLayerId,
    ),
    terrainSource(src.terrain),
    contourSource(src.contours, () => src.viewer.clouds()),
  ]);
  index.refresh();
  const shelf = createResultsShelf({
    index,
    navigate,
    aim: (anchor) => src.viewer.applyCameraPose(poseAt(src.viewer.getCameraPose(), anchor)),
    activeLayerId: src.activeLayerId,
    layerName: (id) => src.viewer.getCloud(id)?.name ?? null,
  });
  const refresh = (): void => { index.refresh(); shelf.sync(); };
  const timer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh();
  }, REREAD_MS);
  const toggle = shelf.element.querySelector('.olv-results-toggle');
  toggle?.addEventListener('click', refresh, { capture: true });
  return {
    ...shelf,
    index,
    refresh,
    dispose: () => { clearInterval(timer); shelf.dispose(); },
  };
}
