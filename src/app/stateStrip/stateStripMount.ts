/**
 * stateStripMount.ts — wire the state strip to the owners it reads.
 *
 * Mounted by the workspace shell (a lazy chunk), so nothing here reaches the
 * startup chunk. The strip repaints when an owner says something changed: the
 * CRS service, the active layer, Process Studio, the Analyse home's rows, the
 * results index and the task-activity store. Busy indicators are collected,
 * and their elapsed time shown, once a second while a scan is open; the timer
 * stops when the scan closes or the strip is disposed.
 */

import type { SpatialContext } from '../../geo/SpatialContext';
import type { ResolvedCrs } from '../../geo/CoordinateTypes';
import type { ScanFacts } from '../../process/ProcessPlan';
import type { ResultsIndex } from '../results/resultsIndex';
import { lastAnalysisRows, subscribeAnalysisRows } from '../../process/analysisRowsFeed';
import { liveTasks, subscribeTaskActivity } from '../../process/taskActivity';
import { clearBusyWaits, collectBusyTasks, showBusyWaits } from './busyTasks';
import { readStrip } from './stripReads';
import { clipScope, subscribeClipScope } from '../../render/clip/clipScope';
import { createStateStrip, type StripItemId } from '../../ui/stateStrip';

export interface StateStripCrs {
  current(): ResolvedCrs | null;
  context(): SpatialContext;
  subscribe(fn: () => void): () => void;
}

export interface StateStripMountDeps {
  readonly crs: StateStripCrs;
  readonly streamingName: () => string | null | undefined;
  readonly activeCloudName: () => string | null | undefined;
  readonly onActiveChange: (fn: () => void) => () => void;
  readonly studio: { state(): { readonly facts: ScanFacts | null }; subscribe(fn: () => void): () => void };
  readonly results: ResultsIndex | null;
  readonly hasScan: () => boolean;
  readonly open: (item: StripItemId) => void;
}

export const BUSY_POLL_MS = 1000;

export interface MountedStateStrip {
  readonly element: HTMLElement;
  refresh(): void;
  dispose(): void;
}

export function mountStateStrip(d: StateStripMountDeps): MountedStateStrip {
  const strip = createStateStrip({ open: d.open });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const refresh = (): void => {
    if (disposed) return;
    const open = d.hasScan();
    let tasks: ReturnType<typeof liveTasks> = [];
    if (open) {
      collectBusyTasks();
      tasks = liveTasks();
      showBusyWaits(tasks);
    } else {
      clearBusyWaits();
    }
    strip.render(
      open
        ? readStrip({
          streamingName: d.streamingName,
          activeCloudName: d.activeCloudName,
          spatialContext: () => d.crs.context(),
          resolvedCrs: () => d.crs.current(),
          scanFacts: () => d.studio.state().facts,
          analysisRows: lastAnalysisRows,
          results: () => d.results?.entries() ?? [],
          tasks: () => tasks,
          clip: clipScope,
        })
        : null,
    );
    // Re-arm only while a scan is open; one query per tick.
    if (open && timer === null) {
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, BUSY_POLL_MS);
    }
  };

  const offs = [
    d.crs.subscribe(refresh),
    d.onActiveChange(refresh),
    d.studio.subscribe(refresh),
    subscribeAnalysisRows(refresh),
    subscribeTaskActivity(refresh),
    subscribeClipScope(refresh),
    d.results?.subscribe(refresh) ?? (() => {}),
  ];
  refresh();

  return {
    element: strip.element,
    refresh,
    dispose() {
      disposed = true;
      clearBusyWaits();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const off of offs) off();
    },
  };
}
