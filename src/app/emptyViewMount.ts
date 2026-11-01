/**
 * emptyViewMount.ts: shows the Empty view card when the clip and the filters
 * leave nothing drawn.
 *
 * After each drawn frame it asks the viewer whether any loaded point of a
 * visible scan passes the clip and the filters. Every change to them redraws,
 * so no clip, filter, layer or restore path has to call in, and the viewer
 * remembers its answer until one of them changes.
 */

import { EmptyViewNotice, type EmptyViewCauses } from '../ui/EmptyViewNotice';
import type { Viewer } from '../render/Viewer';

export interface EmptyViewDeps {
  /** The class legend: whether a class is hidden, and its Show all. */
  readonly classes: { isFiltered(): boolean; showAll(): void };
  /** The Inspector's elevation and intensity filters: whether each is on, and both Show all resets. */
  readonly ranges: { elevation(): boolean; intensity(): boolean; clear(): void };
}

export interface EmptyViewMount {
  readonly notice: EmptyViewNotice;
  /** Start checking after each drawn frame; later calls do nothing. */
  watch(v: Pick<Viewer, 'anyPointShown' | 'onDrawnFrame'>): void;
}

export function mountEmptyView(d: EmptyViewDeps & { readonly clip: { readonly enabled: boolean; clear(): void } }): EmptyViewMount {
  const causes = (): EmptyViewCauses => ({
    clip: d.clip.enabled,
    classes: d.classes.isFiltered(),
    elevation: d.ranges.elevation(),
    intensity: d.ranges.intensity(),
  });
  const notice = new EmptyViewNotice({
    turnOffClip: () => d.clip.clear(),
    resetFilters: () => {
      d.classes.showAll();
      d.ranges.clear();
    },
  });
  let watching = false;
  return {
    notice,
    watch(v) {
      if (watching) return;
      watching = true;
      const sync = (): void => notice.sync(v.anyPointShown() === false ? causes() : null);
      v.onDrawnFrame(sync);
      sync();
    },
  };
}
