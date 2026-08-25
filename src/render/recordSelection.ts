/**
 * recordSelection.ts — naming and marking one display record.
 *
 * Two halves of a single concern, extracted from the Viewer together because
 * they are the two ends of the same act: deciding WHICH display record is meant,
 * and painting exactly that record without losing what was underneath it.
 *
 * THE IDENTITY HALF. The Range Frame Workbench lives behind a lazy chunk and is
 * never handed a reference to the renderer; it reads and writes
 * `model/organizedRangeLink` instead, and the bridge below is the only thing on
 * the renderer's side of that seam. A display record is named by a layer id and
 * a record index and by nothing else. A request for a record the named layer
 * does not hold clears the mark; it never widens into a search for a point that
 * happens to be nearby. A picked point publishes an id only when the renderer
 * actually has one, so a streaming scan — which carries no acquisition grid —
 * publishes a cleared pick rather than an id it invented.
 *
 * THE MARKING HALF. A highlight is a temporary annotation, so whatever colour
 * bytes a point carried before it was marked must be restorable EXACTLY; a
 * cloud that came back a slightly different colour would be a silent edit to
 * the data the user is reading. The snapshot therefore stores the float triples
 * themselves rather than the colour mode they came from. Recomputing the
 * "original" colour from the mode would be a second implementation of the
 * colour pass, and would diverge from it the first time either changed.
 *
 * Free of three.js beyond the `needsUpdate` flag the caller's attribute carries.
 */

import type { PointCloud } from '../model/PointCloud';
import {
  forgetOrganizedRange,
  publishOrganizedPick,
  registerOrganizedRange,
  subscribeOrganizedHighlight,
} from '../model/organizedRangeLink';

/** What the bridge needs from the renderer. Deliberately four small holes. */
export interface OrganizedLinkHost {
  /** The renderer's live layer table, read on demand and never captured. */
  readonly cloudEntries: () => ReadonlyMap<string, { readonly cloud: PointCloud }>;
  readonly setHighlight: (perCloud: ReadonlyMap<string, ReadonlyArray<number>>) => void;
  readonly clearHighlight: () => void;
}

export interface OrganizedLinkBridge {
  /** Publish a mounted layer's acquisition grid, if it carries one. */
  readonly register: (layerId: string, cloud: PointCloud) => void;
  /** Drop a layer that has been unmounted. */
  readonly forget: (layerId: string) => void;
  /** The renderer's id for a mounted cloud, or undefined when it is not mounted. */
  readonly layerIdOf: (cloud: PointCloud) => string | undefined;
  /** Publish an inspected record, or clear the published pick with no id. */
  readonly publishPick: (layerId: string | undefined, record: number) => void;
  /** Drop the highlight subscription. */
  readonly dispose: () => void;
}

export function bindOrganizedRangeLink(host: OrganizedLinkHost): OrganizedLinkBridge {
  const off = subscribeOrganizedHighlight((pick) => {
    if (!pick) {
      host.clearHighlight();
      return;
    }
    const entry = host.cloudEntries().get(pick.layerId);
    // A record outside the layer's own stream marks NOTHING. The alternative —
    // clamping into range, or marking the closest point — would turn a link
    // that is about identity into one that is about proximity, which is the
    // failure the whole subsystem exists to refuse.
    if (!entry || pick.record < 0 || pick.record >= entry.cloud.pointCount) {
      host.clearHighlight();
      return;
    }
    host.setHighlight(new Map([[pick.layerId, [pick.record]]]));
  });

  return {
    register: (layerId, cloud) => registerOrganizedRange(layerId, cloud.name, cloud.organizedRange),
    forget: (layerId) => forgetOrganizedRange(layerId),
    layerIdOf: (cloud) => {
      // A linear scan of a table that holds a handful of entries. The pick path
      // carries the `PointCloud` and not its id, and an id is the only key the
      // link may use: a display name is not unique and does not survive a rename.
      for (const [id, entry] of host.cloudEntries()) {
        if (entry.cloud === cloud) return id;
      }
      return undefined;
    },
    publishPick: (layerId, record) =>
      publishOrganizedPick(layerId ? { layerId, record } : null),
    dispose: off,
  };
}

/** The colour buffer of one layer, and the flag that uploads it. */
export interface HighlightTarget {
  readonly array: Float32Array;
  needsUpdate: boolean;
}

/** What was overwritten for one layer, so it can be put back byte for byte. */
export interface HighlightSnapshot {
  readonly indices: readonly number[];
  readonly saved: Float32Array;
}

/**
 * Paint `indices` of each named layer in `color`, recording what was there.
 *
 * The caller reverts first, so only one selection is ever marked. An index the
 * caller supplies that no layer holds is the caller's error and is not checked
 * here; the identity link that feeds this checks the bound before it calls.
 */
export function applySelectionHighlight(
  perCloud: ReadonlyMap<string, ReadonlyArray<number>>,
  targetFor: (id: string) => HighlightTarget | null,
  color: readonly [number, number, number],
  snapshots: Map<string, HighlightSnapshot>,
): void {
  for (const [id, indices] of perCloud) {
    const target = targetFor(id);
    if (!target) continue;
    const arr = target.array;
    const saved = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      const k = indices[i] * 3;
      saved[i * 3] = arr[k];
      saved[i * 3 + 1] = arr[k + 1];
      saved[i * 3 + 2] = arr[k + 2];
      arr[k] = color[0];
      arr[k + 1] = color[1];
      arr[k + 2] = color[2];
    }
    snapshots.set(id, { indices: indices.slice(), saved });
    target.needsUpdate = true;
  }
}

/** Put every snapshot back and empty the map. */
export function revertSelectionHighlight(
  targetFor: (id: string) => HighlightTarget | null,
  snapshots: Map<string, HighlightSnapshot>,
): void {
  for (const [id, snap] of snapshots) {
    const target = targetFor(id);
    if (!target) continue;
    const arr = target.array;
    for (let i = 0; i < snap.indices.length; i++) {
      const k = snap.indices[i] * 3;
      arr[k] = snap.saved[i * 3];
      arr[k + 1] = snap.saved[i * 3 + 1];
      arr[k + 2] = snap.saved[i * 3 + 2];
    }
    target.needsUpdate = true;
  }
  snapshots.clear();
}
