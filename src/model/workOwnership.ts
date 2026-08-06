/**
 * workOwnership.ts: which layer a piece of saved work belongs to.
 *
 * A measurement or an annotation is not a property of the project as a whole.
 * It was placed on ONE layer, in that layer's own source-local frame, and it
 * stays meaningful only while it is read back in that frame. With a single
 * layer open the distinction is invisible, because the session's one global
 * origin IS that layer's origin. With several layers it is the difference
 * between a saved distance and a wrong one.
 *
 * So every piece of work carries one of two statements about itself:
 *
 *   • `{ layerId, frame: 'source-local' }`: the stored coordinates are local
 *     to the named layer, and are lifted to the world through THAT layer's
 *     source origin;
 *   • `{ frame: 'project' }`: the stored coordinates are already project-frame
 *     and are lifted through the project origin.
 *
 * The id is the layer's stable identity (`model/layerIdentity.ts`), never a
 * filename and never a display label: two scans dropped under one name are two
 * layers, and a renamed layer is still the same layer. Where ownership has to
 * be RESOLVED rather than read, as when restored work is attached to the layers
 * actually open, the resolution runs on the source facts (point count, extents, CRS)
 * and refuses outright when a filename is all that is known, because a
 * filename-only fingerprint collides across genuinely different scans.
 *
 * Pure: no DOM, no three.js, no io. Unit-tested in Node.
 */

import { fingerprintKey, type LayerFingerprint } from './layerIdentity';

/** Which frame a piece of work's stored coordinates are expressed in. */
export type OwnershipGeometryFrame = 'source-local' | 'project';

/**
 * What a measurement or annotation records about where it belongs.
 *
 * `layerId` is REQUIRED when the frame is `source-local` (the coordinates have
 * no meaning without the layer that anchors them) and optional when the frame
 * is `project` (the coordinates stand on their own; an id, if present, records
 * which layer the work was placed on).
 */
export interface WorkOwnership {
  /** The owning layer's stable id. Required for `source-local`. */
  readonly layerId?: string;
  /** The frame the stored coordinates are already in. */
  readonly frame: OwnershipGeometryFrame;
  /**
   * True when this assignment was INFERRED by a migration rather than declared
   * by whoever placed the work. Legacy sessions carry no ownership at all, and
   * inferring one is the only way to import them without loss. An inferred
   * owner is a best available reading, not a fact the author stated, and every
   * consumer is entitled to know which it is holding.
   */
  readonly inferred?: boolean;
}

/** Work that may carry an owner. Structural, so both measurements and annotations fit. */
export interface OwnedWork {
  readonly owner?: WorkOwnership;
}

/**
 * The minimum a frame has to expose for ownership to be resolvable: the
 * project origin and each layer's source origin. Structural on purpose: the
 * session's `SessionProjectFrame` satisfies it without this pure module
 * depending on the io layer.
 */
export interface OwnershipFrameView {
  readonly projectOrigin: readonly [number, number, number];
  readonly layers: readonly {
    readonly layerId: string;
    readonly sourceOrigin: readonly [number, number, number];
  }[];
}

/** Build a source-local owner. Throws on an empty id rather than writing one. */
export function sourceLocalOwnership(
  layerId: string,
  options: { readonly inferred?: boolean } = {},
): WorkOwnership {
  if (typeof layerId !== 'string' || layerId.length === 0) {
    throw new Error(
      'Source-local ownership needs a layer id: coordinates local to an unnamed layer '
        + 'cannot be read back in any frame.',
    );
  }
  return options.inferred
    ? { layerId, frame: 'source-local', inferred: true }
    : { layerId, frame: 'source-local' };
}

/**
 * Build a project-frame owner: the explicit declaration that the stored
 * coordinates are already in the project frame.
 */
export function projectFrameOwnership(
  options: { readonly layerId?: string; readonly inferred?: boolean } = {},
): WorkOwnership {
  const out: { layerId?: string; frame: OwnershipGeometryFrame; inferred?: boolean } = {
    frame: 'project',
  };
  if (typeof options.layerId === 'string' && options.layerId.length > 0) {
    out.layerId = options.layerId;
  }
  if (options.inferred) out.inferred = true;
  return out as WorkOwnership;
}

/** Whether a value is a usable ownership record. */
export function isWellFormedOwnership(v: unknown): v is WorkOwnership {
  return parseWorkOwnership(v) !== null;
}

/**
 * Read a stored ownership record, or null when it states nothing usable.
 *
 * Null is the honest answer for a malformed claim: the measurement is kept, since
 * a corrupt owner field describes the attribution and not the geometry, and the
 * missing ownership then goes through the same migration path as a legacy
 * session, which marks what it assigns as inferred. Silently keeping a
 * half-parsed owner would assert an attribution nobody made.
 */
export function parseWorkOwnership(v: unknown): WorkOwnership | null {
  if (typeof v !== 'object' || v === null) return null;
  const raw = v as Record<string, unknown>;
  const frame = raw.frame;
  if (frame !== 'source-local' && frame !== 'project') return null;
  const layerId = typeof raw.layerId === 'string' && raw.layerId.length > 0 ? raw.layerId : undefined;
  if (frame === 'source-local' && layerId === undefined) return null;
  const out: { layerId?: string; frame: OwnershipGeometryFrame; inferred?: boolean } = { frame };
  if (layerId !== undefined) out.layerId = layerId;
  if (raw.inferred === true) out.inferred = true;
  return out as WorkOwnership;
}

/**
 * Normalise an owner for writing, throwing when it is not usable.
 *
 * The write side refuses rather than dropping: a session this app writes must
 * be readable by the version that wrote it, and an owner that would not survive
 * its own parser is a file that mis-attributes work on the way back in.
 */
export function serializeWorkOwnership(owner: WorkOwnership, context: string): WorkOwnership {
  const parsed = parseWorkOwnership(owner);
  if (!parsed) {
    throw new Error(
      `${context} carries an unusable ownership record (${JSON.stringify(owner)}). `
        + 'Refusing to write it, because work whose owner cannot be read back would be '
        + 'attributed to whatever layer happened to be open.',
    );
  }
  return parsed;
}

/**
 * Whether a fingerprint carries anything that actually distinguishes one scan
 * from another.
 *
 * A filename does not: two captures are routinely dropped under the same name,
 * and a fingerprint built from a name alone collides between them. Neither does
 * a CRS label, which thousands of unrelated scans share. A point count or a set
 * of extents does, so ownership resolution waits until those source facts have
 * been computed and refuses to run before then.
 */
export function hasDistinguishingSourceFacts(f: LayerFingerprint): boolean {
  if (typeof f.sourcePoints === 'number' && Number.isFinite(f.sourcePoints)) return true;
  const spans = [f.width, f.depth, f.height];
  return spans.some((s) => typeof s === 'number' && Number.isFinite(s));
}

/** A layer ownership can be resolved onto: its stable id and its source facts. */
export interface OwnerCandidate {
  readonly layerId: string;
  readonly facts: LayerFingerprint;
}

/** Why a resolution produced no owner. Never a fallback, always a reason. */
export type OwnerUnresolvedReason = 'filename-only' | 'no-match' | 'ambiguous';

export type OwnerResolution =
  | { readonly kind: 'resolved'; readonly layerId: string }
  | { readonly kind: 'unresolved'; readonly reason: OwnerUnresolvedReason };

/**
 * Resolve which of the open layers a set of source facts belongs to.
 *
 * Fails closed in all three ways it can fail: facts that name only a file
 * (`filename-only`), facts nothing matches (`no-match`), and facts several
 * layers match equally (`ambiguous`). None of them falls back to a nearest
 * guess, because a wrong owner moves saved work rather than merely losing it.
 */
export function resolveOwnerLayer(
  candidates: readonly OwnerCandidate[],
  facts: LayerFingerprint,
): OwnerResolution {
  if (!hasDistinguishingSourceFacts(facts)) {
    return { kind: 'unresolved', reason: 'filename-only' };
  }
  const key = fingerprintKey(facts);
  const matches = candidates.filter((c) => fingerprintKey(c.facts) === key);
  if (matches.length === 0) return { kind: 'unresolved', reason: 'no-match' };
  if (matches.length > 1) return { kind: 'unresolved', reason: 'ambiguous' };
  return { kind: 'resolved', layerId: matches[0].layerId };
}

/**
 * Where a stored point actually is, in the project's source-CRS coordinates.
 *
 * Returns null, never a coordinate, when the frame cannot answer: no owner at
 * all, or an owner naming a layer the frame does not contain (a removed layer).
 * That null is the guarantee behind "removing a layer must not move saved
 * work": the departed layer's work resolves to nothing instead of being
 * silently re-homed onto whichever layer is still there.
 */
export function resolveWorldPoint(
  point: readonly [number, number, number],
  owner: WorkOwnership | undefined,
  frame: OwnershipFrameView,
): [number, number, number] | null {
  if (!owner) return null;
  if (owner.frame === 'project') {
    const o = frame.projectOrigin;
    return [point[0] + o[0], point[1] + o[1], point[2] + o[2]];
  }
  const layer = frame.layers.find((l) => l.layerId === owner.layerId);
  if (!layer) return null;
  const o = layer.sourceOrigin;
  return [point[0] + o[0], point[1] + o[1], point[2] + o[2]];
}
