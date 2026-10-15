/**
 * classEditLayers.ts
 *
 * Which open static layers carry class edits that an action would discard.
 *
 * Per-point class edits live only in the layer's display buffer: the session
 * file and the recovery journal do not keep them. So every action that removes
 * layers asks about the exact layers it removes, not the active one. Close
 * scan and an exclusive streaming open remove every static layer; the layer
 * row's remove control removes one. Visibility, the lock and the active
 * selection play no part: a hidden, locked or inactive layer is removed all
 * the same.
 *
 * A layer counts when its classes differ from its file, read from the layer's
 * classification provenance and edit epoch.
 */

import { classificationDiffersFromSource } from '../export/fullResClassGuard';

/** The viewer surface read here. */
export interface ClassEditLayerReader {
  clouds(): readonly string[];
  getCloud(id: string): { readonly name?: string; readonly classificationProvenance?: string } | null | undefined;
  classificationEpoch(id: string): number;
}

/** Whether one layer's classes differ from its file. An unknown id reads false. */
export function layerHasClassEdits(id: string, viewer: ClassEditLayerReader | null | undefined): boolean {
  const cloud = viewer?.getCloud(id);
  if (!viewer || !cloud) return false;
  return classificationDiffersFromSource(cloud.classificationProvenance ?? 'none', viewer.classificationEpoch(id));
}

/** Names of the layers in `ids` that carry class edits, in the order given. */
export function editedLayerNames(ids: Iterable<string>, viewer: ClassEditLayerReader | null | undefined): string[] {
  if (!viewer) return [];
  const names: string[] = [];
  for (const id of ids) {
    if (layerHasClassEdits(id, viewer)) names.push(viewer.getCloud(id)?.name || id);
  }
  return names;
}

/** Names of every open static layer that carries class edits. */
export function editedStaticLayerNames(viewer: ClassEditLayerReader | null | undefined): string[] {
  return viewer ? editedLayerNames(viewer.clouds(), viewer) : [];
}

/** "a", "a and b", "a, b and c". */
export function joinLayerNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The work-summary phrase for class edits on the named layers. */
export function describeClassEdits(names: readonly string[]): string {
  return names.length > 0 ? `class edits on ${joinLayerNames(names)}` : 'class edits that differ from the file';
}

/**
 * How to keep class edits before they are discarded. The session file does not
 * store them, so it points to the LAS export of the edited layer instead.
 */
export function keepClassEditsLine(names: readonly string[]): string {
  if (names.length === 0) return 'The session file does not store class edits. Export the scan as LAS to keep them.';
  const which = names.length === 1 ? `${names[0]} as LAS` : 'each of these layers as LAS';
  return `The session file does not store class edits. To keep them, export ${which} at display resolution.`;
}

/**
 * The class-edit part of the work Close scan and an exclusive streaming open
 * would discard. Both remove every static layer, so every one is read.
 */
export function staticClassEditWork(viewer: ClassEditLayerReader | null | undefined): { classEdits: boolean; classEditLayers: string[] } {
  const classEditLayers = editedStaticLayerNames(viewer);
  return { classEdits: classEditLayers.length > 0, classEditLayers };
}

/** For removing one layer: how to keep its class edits, or null when it has none. */
export function layerRemovalClassEditsLine(id: string, viewer: ClassEditLayerReader | null | undefined): string | null {
  const names = editedLayerNames([id], viewer);
  return names.length > 0 ? keepClassEditsLine(names) : null;
}
