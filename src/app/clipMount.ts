/**
 * clipMount.ts: the Clip page as the shell builds it.
 *
 * One call from `main.ts` makes the Clip panel and the Box → clip flow and
 * wires them to the viewer:
 *   - apply, and the box drawn in the scene (`Viewer.setClipOutline`);
 *   - the kept-point count over every visible scan, with the active scan's own
 *     figure (what a point-cloud export writes) and, for a display sample, the
 *     file's declared point count;
 *   - Fit to scan over the union of the visible scans;
 *   - the frame's axis units for the numeric fields;
 *   - a recount whenever the points under the clip change: a layer added,
 *     removed, shown, hidden or placed, another layer made active, or the
 *     active layer reloaded at another density. These are read from the
 *     viewer after each drawn frame (every such change redraws), so no load,
 *     layer or placement path has to remember to call in.
 *
 * Everything is reached through accessors, so the deferred Viewer is read at
 * call time and nothing here runs before a scan exists.
 */

import { ClipPanel, type ClipKeptCount } from '../ui/ClipPanel';
import { createClipFlowFromShell, type ClipFlow, type ClipFlowShell } from './clipFlow';
import { sumClipCounts } from '../render/clip/clipBox';
import { fitMergedBounds } from '../render/clip/fitBoundsInProject';
import { toggleTool } from './toggleTool';
import { worldCoordLabels } from '../render/pointInfo';
import type { WorkflowController } from '../ui/WorkflowController';
import type { Viewer } from '../render/Viewer';

export interface ClipMountDeps extends Omit<ClipFlowShell, 'clipPanel' | 'viewer' | 'toggleMeasure'> {
  /** The deferred Viewer; null (or a placeholder) until it has loaded. */
  readonly viewer: () => Viewer | null;
  /** The active scan's viewer id, read at call time. */
  readonly activeId: () => string | null;
  /** The workflow recorder every tool toggle reports to. */
  readonly workflow: Pick<WorkflowController, 'capture'>;
}

export interface ClipMount {
  readonly clipPanel: ClipPanel;
  readonly clipFlow: ClipFlow;
}

/** What the clip's count depends on, cheap to read every frame: the layers, their visibility, size and placement. */
export function clipDataKey(v: Pick<Viewer, 'clouds' | 'isCloudVisible' | 'getCloud' | 'layerProjectOffset'>, activeId: string | null): string {
  return `${activeId ?? ''}#${v.clouds().map((id) => `${id}:${v.isCloudVisible(id) ? 1 : 0}:${v.getCloud(id)?.pointCount ?? 0}:${v.layerProjectOffset(id)?.join(',') ?? ''}`).join('|')}`;
}

/** The Clip page's count for the active scan, over the visible scans. Null when there is no static scan to count. */
export function clipCountFor(v: Viewer | null, activeId: string | null): ClipKeptCount | null {
  if (!v || !activeId) return null;
  const sum = sumClipCounts(v.clipKeptCounts(activeId), activeId);
  if (!sum) return null;
  const cloud = v.getCloud(activeId);
  const declared = cloud ? cloud.sourceDeclaredPointCount ?? cloud.declaredPointCount : undefined;
  return {
    ...sum,
    sourceTotal: declared !== undefined && Number.isFinite(declared) && declared > sum.total ? declared : null,
    name: cloud?.name ?? null,
  };
}

export function mountClip(d: ClipMountDeps): ClipMount {
  // The placeholder before the Viewer loads is a null cast, so read it as nullable.
  const live = (): Viewer | null => d.viewer() ?? null;
  let watching: (() => void) | null = null;
  let key = '';
  /** Once the viewer is up, recount when the data under the clip changes. */
  const watch = (v: Viewer): void => {
    if (watching) return;
    key = clipDataKey(v, d.activeId());
    watching = v.onDrawnFrame(() => {
      const next = clipDataKey(v, d.activeId());
      if (next === key) return;
      key = next;
      clipPanel.invalidateCount();
    });
  };
  const clipPanel = new ClipPanel({
    // The constructor's setVisible(false) → onApply(null) fires before the
    // deferred Viewer exists, and clearing a clip on none is a no-op.
    onApply: (clip) => {
      const v = live();
      if (!v) return;
      watch(v);
      v.setClip(clip);
    },
    onOutline: (box, active) => live()?.setClipOutline(box, active),
    fitBounds: () => fitMergedBounds(live()?.mergedVisibleBounds(true) ?? null),
    keptCount: () => clipCountFor(live(), d.activeId()),
    // The units the Inspect card gives the same local X, Y, Z (none asserted when unknown).
    units: () => {
      const l = worldCoordLabels(d.crs.current() ?? undefined);
      return [l.xUnit.trim(), l.yUnit.trim(), l.zUnit.trim()];
    },
  });
  let flow: ClipFlow | null = null;
  const clipFlow = createClipFlowFromShell({
    ...d,
    clipPanel,
    viewer: () => live() as Viewer,
    // The recorded flip every entry point makes, minus opening the Measure
    // page: Draw clipping box stays on the Clip page. A tool switch ends the
    // result card, as the scene-tool command does.
    toggleMeasure: () => {
      const v = live();
      if (!v) return;
      flow?.dismissCard();
      toggleTool(v, d.workflow, 'measure');
    },
  });
  flow = clipFlow;
  return { clipPanel, clipFlow };
}
