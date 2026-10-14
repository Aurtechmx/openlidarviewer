/**
 * measurementOwnership.ts
 *
 * Which scan a measurement belongs to, decided once for every scan-specific
 * output (the PDF report, the site KML, the findings ledger and its report).
 *
 * The release rule: when an artifact's owner, frame or permission cannot be
 * resolved, the result is WITHHELD. A scan-specific output never borrows the
 * active scan's units, frame, permissions or dataset identity for a
 * measurement taken on another scan, on a scan that is no longer open, or on a
 * scan more than one open layer claims. Each withheld measurement is counted
 * and the output states why.
 *
 * Pure: no DOM, no viewer. The app hands over the open layers and the active
 * viewer id.
 */

import type { Measurement } from '../render/measure/types';

/**
 * The owner given to work left behind when its scan was replaced. It names no
 * open layer, so every consumer treats the work as taken on a scan that is no
 * longer open.
 */
export const RETIRED_SCAN_OWNER = 'retired-scan';

/** One open layer, as ownership reads it. */
export interface OwnershipLayer {
  readonly viewerId: string;
  /** Stable layer id (`model/layerIdentity`), or null when none was bound. */
  readonly stableId: string | null;
  /** Display name: the file name. */
  readonly name: string;
}

/** The open layers and the scan the output describes. */
export interface OwnershipView {
  readonly layers: readonly OwnershipLayer[];
  /** Viewer id of the scan the output describes (the active scan), or null. */
  readonly activeViewerId: string | null;
}

/** Why a measurement does not belong to the scan an output describes. */
export type OwnershipVerdict =
  | { readonly kind: 'own' }
  /** Taken on another open scan (or across it and this one). */
  | { readonly kind: 'other'; readonly names: readonly string[] }
  /** Names a scan that is not open. */
  | { readonly kind: 'closed' }
  /** Names a scan more than one open layer carries. */
  | { readonly kind: 'ambiguous' }
  /** Records no scan while several are open. */
  | { readonly kind: 'unrecorded' };

/** What ownership reads off a measurement or an annotation. */
export type OwnedItem = Pick<Measurement, 'owner' | 'pickLayers'>;

/** The layer ids a measurement names: its pick record, else its owner. */
export function ownerIdsOf(m: OwnedItem): readonly string[] {
  if (m.pickLayers && m.pickLayers.length > 0) return m.pickLayers;
  return m.owner?.layerId ? [m.owner.layerId] : [];
}

/**
 * The verdict for one measurement. A measurement that records no scan belongs
 * to the active scan only when that scan is the only candidate (it is the one
 * open layer, or a streamed scan with no static layer open); otherwise its
 * owner is unresolved and it is withheld.
 */
export function ownershipOf(m: OwnedItem, view: OwnershipView): OwnershipVerdict {
  const ids = ownerIdsOf(m);
  if (ids.length === 0) {
    const sole = view.layers.length === 0 || (view.layers.length === 1 && view.layers[0]!.viewerId === view.activeViewerId);
    return sole ? { kind: 'own' } : { kind: 'unrecorded' };
  }
  const matches = ids.map((id) => view.layers.filter((l) => l.stableId === id));
  if (matches.some((x) => x.length === 0)) return { kind: 'closed' };
  if (matches.some((x) => x.length > 1)) return { kind: 'ambiguous' };
  const owners = matches.map((x) => x[0]!);
  if (view.activeViewerId !== null && owners.every((l) => l.viewerId === view.activeViewerId)) return { kind: 'own' };
  const names = [...new Set(owners.filter((l) => l.viewerId !== view.activeViewerId).map((l) => l.name))];
  return { kind: 'other', names: names.sort((a, b) => a.localeCompare(b)) };
}

/** The measurements an output for the active scan may hold, and the sentence for the rest. */
export interface OwnedMeasurements<M extends Measurement> {
  readonly own: M[];
  /** How many were left out. */
  readonly withheldCount: number;
  /** Why they were left out, or null when none was. */
  readonly withheld: string | null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Split `measurements` into those the active scan owns and the withheld rest,
 * with one sentence naming each reason.
 */
export function measurementsOwnedByActive<M extends Measurement>(
  measurements: readonly M[],
  view: OwnershipView,
): OwnedMeasurements<M> {
  const own: M[] = [];
  const other = new Map<string, number>();
  let closed = 0;
  let ambiguous = 0;
  let unrecorded = 0;
  for (const m of measurements) {
    const v = ownershipOf(m, view);
    if (v.kind === 'own') own.push(m);
    else if (v.kind === 'other') {
      const key = v.names.join(', ');
      other.set(key, (other.get(key) ?? 0) + 1);
    } else if (v.kind === 'closed') closed++;
    else if (v.kind === 'ambiguous') ambiguous++;
    else unrecorded++;
  }
  const withheldCount = measurements.length - own.length;
  if (withheldCount === 0) return { own, withheldCount, withheld: null };
  // One reason reads without an inner count; several are each counted.
  const counted: Array<[number, string]> = [];
  for (const [names, n] of other) counted.push([n, `taken on ${names}; make that scan active to report ${n === 1 ? 'it' : 'them'} in its own units and frame`]);
  if (closed > 0) counted.push([closed, 'taken on a scan that is no longer open, so the units and frame cannot be resolved']);
  if (ambiguous > 0) counted.push([ambiguous, 'naming a scan that more than one open scan matches']);
  if (unrecorded > 0) counted.push([unrecorded, 'with no record of the scan they were taken on while several scans are open']);
  const parts = counted.length === 1 ? [counted[0]![1]] : counted.map(([n, why]) => `${n} ${why}`);
  return {
    own,
    withheldCount,
    withheld: `${plural(withheldCount, 'measurement', 'measurements')} withheld: ${parts.join('; ')}.`,
  };
}

/** The ownership view of a viewer: its open layers and the active scan. */
export function ownershipViewOf(
  view: { clouds(): readonly string[]; getCloud(id: string): { readonly name: string } | undefined },
  stableIdFor: (viewerId: string) => string | null,
  activeViewerId: string | null,
): OwnershipView {
  const layers: OwnershipLayer[] = [];
  for (const id of view.clouds()) {
    const c = view.getCloud(id);
    if (c) layers.push({ viewerId: id, stableId: stableIdFor(id), name: c.name });
  }
  return { layers, activeViewerId };
}

/**
 * Split saved work into what a session of the active scan may hold and what it
 * must leave out. Work whose scan is no longer open, or that more than one open
 * layer claims, has no frame to be written in, so it is left out and counted.
 * Work on another open layer keeps its own recorded owner and is kept.
 */
export function partitionSessionWork<T extends OwnedItem>(
  items: readonly T[],
  view: OwnershipView,
): { readonly keep: T[]; readonly leftOut: number } {
  const keep = items.filter((i) => {
    const kind = ownershipOf(i, view).kind;
    return kind !== 'closed' && kind !== 'ambiguous';
  });
  return { keep, leftOut: items.length - keep.length };
}
