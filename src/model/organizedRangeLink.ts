/**
 * organizedRangeLink.ts — the two seams that let a UI reach an acquisition grid.
 *
 * `OrganizedRangeFrame` is carried by a `PointCloud`, and a `PointCloud` is
 * handed to the renderer. Nothing between the loader and the interface layer
 * held a reference the Range Frame Workbench could read, and the workbench must
 * not be reachable from the startup shell, so it cannot be handed one at boot.
 *
 * This module is that reference, and it is deliberately two very small stores
 * rather than a service:
 *
 *   REGISTRY  which loaded layer carries which acquisition grid, keyed by the
 *             renderer's own layer id. Written where a layer is mounted and
 *             dropped, read by the panel that offers the launcher.
 *   PICK BUS  the last display record the inspector resolved, published as an
 *             IDENTITY (layer id plus record index) and never as a coordinate.
 *
 * WHY A LAYER ID AND NOT THE NAME THE INSPECTOR SHOWS. `PointInfo.layer` is a
 * display name taken from the file, so two layers loaded from two directories
 * with the same basename are indistinguishable by it, and a rename would break
 * a link that was supposedly about identity. Both stores key on the renderer's
 * own `cloud_N` id, which is unique for the life of the layer and is the same
 * string the active-scan selection uses. `PointInfo` carries that id alongside
 * the name for exactly this reason; see `layerId` there.
 *
 * Pure and DOM-free. Every writer and every reader lives behind a lazy chunk
 * boundary, which is what keeps the workbench out of the eager startup bundle:
 * no eagerly loaded module imports this file.
 */

import type { OrganizedRangeSet } from './OrganizedRange';

/** What one loaded layer contributes to the workbench. */
export interface OrganizedLayerEntry {
  readonly layerId: string;
  /** The layer's display name. Shown, never used to key anything. */
  readonly name: string;
  readonly set: OrganizedRangeSet;
}

const entries = new Map<string, OrganizedLayerEntry>();
const registryListeners = new Set<() => void>();

function notifyRegistry(): void {
  for (const fn of registryListeners) fn();
}

/**
 * Record (or drop) a layer's acquisition grid.
 *
 * A cloud with no `organizedRange` calls this with `undefined`, so re-mounting
 * a layer that lost its topology cannot leave the previous entry readable.
 */
export function registerOrganizedRange(
  layerId: string,
  name: string,
  set: OrganizedRangeSet | undefined,
): void {
  const had = entries.has(layerId);
  if (!set || set.frames.length === 0) {
    if (!had) return;
    entries.delete(layerId);
  } else {
    entries.set(layerId, { layerId, name, set });
  }
  notifyRegistry();
}

/** Forget a layer. Silent when the layer never carried a grid. */
export function forgetOrganizedRange(layerId: string): void {
  if (entries.delete(layerId)) notifyRegistry();
}

/** The entry for a layer, or null. A null id answers null rather than throwing. */
export function organizedRangeFor(layerId: string | null | undefined): OrganizedLayerEntry | null {
  if (!layerId) return null;
  return entries.get(layerId) ?? null;
}

/** Every registered entry, in registration order. */
export function organizedRangeEntries(): readonly OrganizedLayerEntry[] {
  return [...entries.values()];
}

/** Subscribe to registry changes. Returns the unsubscribe. */
export function subscribeOrganizedRange(fn: () => void): () => void {
  registryListeners.add(fn);
  return () => registryListeners.delete(fn);
}

/** A display record the inspector resolved, as an identity and nothing else. */
export interface OrganizedPick {
  readonly layerId: string;
  /** Index into the layer's display record stream. */
  readonly record: number;
}

const pickListeners = new Set<(pick: OrganizedPick | null) => void>();
let lastPick: OrganizedPick | null = null;

/**
 * Publish the inspected record, or `null` when the inspection was cleared.
 *
 * The publisher supplies the record index the renderer picked. It does NOT
 * supply a position, because a workbench that took one would be tempted to
 * search the grid for a nearby cell, which is the failure this whole subsystem
 * exists to refuse.
 */
export function publishOrganizedPick(pick: OrganizedPick | null): void {
  lastPick = pick;
  for (const fn of pickListeners) fn(pick);
}

/** The most recent published pick, for a subscriber that mounted after it. */
export function lastOrganizedPick(): OrganizedPick | null {
  return lastPick;
}

/** Subscribe to inspector picks. Returns the unsubscribe. */
export function subscribeOrganizedPick(fn: (pick: OrganizedPick | null) => void): () => void {
  pickListeners.add(fn);
  return () => pickListeners.delete(fn);
}

const highlightListeners = new Set<(pick: OrganizedPick | null) => void>();

/**
 * Ask the renderer to mark one display record, or clear the mark with `null`.
 *
 * The request carries the same identity the pick bus carries, so the two
 * directions of the link speak one vocabulary. A request naming a record the
 * renderer does not hold is dropped by the renderer; it is never widened into
 * a search for something close by.
 */
export function requestOrganizedHighlight(pick: OrganizedPick | null): void {
  for (const fn of highlightListeners) fn(pick);
}

/** Subscribe to highlight requests. Returns the unsubscribe. */
export function subscribeOrganizedHighlight(
  fn: (pick: OrganizedPick | null) => void,
): () => void {
  highlightListeners.add(fn);
  return () => highlightListeners.delete(fn);
}

/** Drop every entry and the last pick. Exists so a test starts from empty. */
export function resetOrganizedRangeLink(): void {
  entries.clear();
  lastPick = null;
  notifyRegistry();
}
