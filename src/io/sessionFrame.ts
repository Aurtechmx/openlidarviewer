/**
 * sessionFrame.ts: the session v8 project frame.
 *
 * Through v7 a session described ONE scan: a single origin, a single scan
 * summary, and measurement and annotation collections with nothing to say about
 * which layer they came from. That is exactly why multi-layer mounting is
 * disabled (`MULTI_LAYER_MOUNT_ENABLED`, `app/LayerService.ts`). The file
 * cannot express which layer a saved measurement belongs to, so mounting could
 * move or mis-attribute it.
 *
 * v8 adds the missing structure: one project origin, plus one record per layer
 * holding the layer's stable id, the source fingerprint that id is anchored on,
 * the display name kept separate from the identity, the layer's own source
 * origin, its Float64 transform into the project frame, its resolved CRS and its
 * up axis. Saved work then names its owner (`model/workOwnership.ts`) and is
 * read back through that layer's origin rather than through a single global one.
 *
 * Two rules run through the whole module:
 *
 *   • Float64 everywhere. These numbers are frame data, not render data. A
 *     transform that has been through a 32-bit slot has lost the millimetre the
 *     mount budget exists to protect.
 *   • Refuse rather than guess. A frame whose declared numbers contradict each
 *     other is rejected on read AND on write, because a coerced frame does not
 *     fail visibly. It silently relocates every measurement resolved through
 *     it. This is the same reasoning `parseUpAxis` already applies in
 *     `session.ts`, applied to the other half of the coordinate contract.
 *
 * Pure (no DOM, no three.js), so it is unit-tested in Node.
 */

import { parseResolvedCrs, type SerializedResolvedCrs } from './sessionCrs';
import type { WorkOwnership } from '../model/workOwnership';

export type { SerializedResolvedCrs };

type Vec3 = readonly [number, number, number];

/** The vertical axis of a layer's own source frame. */
export type FrameUpAxis = 'x' | 'y' | 'z';

/**
 * One layer, as a session records it.
 *
 * `layerId` is the identity and `sourceName` is the label; they are separate
 * fields because a rename must not change what work belongs to, and two scans
 * dropped under one filename must not become one layer.
 */
export interface SessionLayerRecord {
  /** Stable layer identity, never derived from a name (see `model/layerIdentity.ts`). */
  readonly layerId: string;
  /** The canonical source-fingerprint key the id is anchored on. */
  readonly sourceFingerprint: string;
  /** The display label at export time. Disclosure only; never an identity. */
  readonly sourceName: string;
  /** The layer's own origin, as its FILE declared it, in source-CRS units (Float64). */
  readonly sourceOrigin: Vec3;
  /**
   * source-local → project-local, Float64. Either `sourceOrigin − projectOrigin`
   * (the layer is placed in the project frame) or all-zero (the layer keeps its
   * own frame). A horizontal-only placement carries the X/Y offset and a zero Z,
   * which is what a layer with an unproven vertical datum is given.
   */
  readonly sourceToProject: Vec3;
  /** The layer's resolved CRS, when it declared one. */
  readonly crs?: SerializedResolvedCrs;
  /** The layer's own vertical axis. */
  readonly upAxis: FrameUpAxis;
}

/** The project's shared frame and every layer expressed in it. */
export interface SessionProjectFrame {
  /** The one origin every placed layer maps into, in source-CRS units (Float64). */
  readonly projectOrigin: Vec3;
  readonly layers: readonly SessionLayerRecord[];
}

/** What a caller supplies to build a record; the transform is derived, not trusted. */
export interface SessionFrameLayerInput {
  readonly layerId: string;
  readonly sourceFingerprint: string;
  readonly sourceName: string;
  readonly sourceOrigin: Vec3;
  readonly crs?: SerializedResolvedCrs;
  readonly upAxis: FrameUpAxis;
  /** True when the layer is placed in the project frame. Default false (own frame). */
  readonly placed?: boolean;
  /**
   * False when the placement is horizontal only: the layer shares X/Y but its
   * vertical reference is unproven, so its Z stays on its own origin. Default
   * true, matching a fully verified placement.
   */
  readonly placedVertically?: boolean;
}

export interface SessionFrameInput {
  readonly projectOrigin: Vec3;
  readonly layers: readonly SessionFrameLayerInput[];
}

const AXES: readonly FrameUpAxis[] = ['x', 'y', 'z'];

/**
 * Cap on the number of layer records a project frame may declare. One record per
 * loaded layer, so a real project has a handful; 10k is far beyond any genuine
 * frame while bounding how much a hostile file can make the validator allocate
 * and walk. Over-cap is refused, like any other self-inconsistent frame.
 */
export const MAX_FRAME_LAYERS = 10_000;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
}

function toVec3(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]];
}

/**
 * Every way a declared frame contradicts itself, most structural first. An
 * empty list means the frame is internally consistent; it does NOT mean the
 * frame describes the scans currently open, which is a separate question the
 * scan-identity guard answers.
 */
export function validateSessionProjectFrame(frame: unknown): string[] {
  const reasons: string[] = [];
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return ['the project frame is not an object'];
  }
  const raw = frame as Record<string, unknown>;
  const origin = raw.projectOrigin;
  if (!isVec3(origin)) {
    reasons.push('the project origin is not three finite numbers');
  }
  const layers = raw.layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    reasons.push('the frame declares no layers');
    return reasons;
  }
  // Refuse an unbounded layer count up front, before the per-layer walk below —
  // a hostile frame can't make the validator chew through millions of records.
  if (layers.length > MAX_FRAME_LAYERS) {
    reasons.push(`the frame declares ${layers.length} layers, above the ${MAX_FRAME_LAYERS} cap`);
    return reasons;
  }
  const seen = new Set<string>();
  layers.forEach((entry, i) => {
    const where = `layer ${i + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      reasons.push(`${where} is not a record`);
      return;
    }
    const l = entry as Record<string, unknown>;
    const id = l.layerId;
    if (typeof id !== 'string' || id.length === 0) {
      reasons.push(`${where} has no layer id`);
    } else if (seen.has(id)) {
      reasons.push(`duplicate layer id "${id}"`);
    } else {
      seen.add(id);
    }
    const named = typeof id === 'string' && id.length > 0 ? `layer "${id}"` : where;
    if (typeof l.sourceFingerprint !== 'string' || l.sourceFingerprint.length === 0) {
      reasons.push(`${named} has no source fingerprint`);
    }
    if (typeof l.sourceName !== 'string') {
      reasons.push(`${named} has no source name`);
    }
    if (typeof l.upAxis !== 'string' || !AXES.includes(l.upAxis as FrameUpAxis)) {
      reasons.push(`${named} declares up axis ${JSON.stringify(l.upAxis)}; expected "x", "y" or "z"`);
    }
    const sourceOrigin = l.sourceOrigin;
    const sourceToProject = l.sourceToProject;
    if (!isVec3(sourceOrigin)) {
      reasons.push(`${named} has no finite source origin`);
    }
    if (!isVec3(sourceToProject)) {
      reasons.push(`${named} has no finite transform`);
    }
    if (!isVec3(origin) || !isVec3(sourceOrigin) || !isVec3(sourceToProject)) return;

    // The transform is derivable from the two origins, so it is checked rather
    // than believed. Per axis it may be the offset into the project frame, or
    // zero, the layer keeping its own frame on that axis, which is what a
    // horizontal-only placement does with Z.
    const delta: Vec3 = [
      sourceOrigin[0] - origin[0],
      sourceOrigin[1] - origin[1],
      sourceOrigin[2] - origin[2],
    ];
    for (let axis = 0; axis < 3; axis++) {
      const v = sourceToProject[axis];
      if (v !== delta[axis] && v !== 0) {
        reasons.push(
          `${named} declares a transform of ${v} on ${'XYZ'[axis]}, which neither places it `
            + `in the project frame (${delta[axis]}) nor leaves it in its own (0)`,
        );
      }
    }
    // A placement is applied to X and Y together. There is no such thing as a
    // layer that shares an easting but not a northing.
    if (delta[0] !== 0 && delta[1] !== 0) {
      const placedX = sourceToProject[0] === delta[0];
      const placedY = sourceToProject[1] === delta[1];
      if (placedX !== placedY) {
        reasons.push(`${named} is placed on one horizontal axis only`);
      }
    }
  });
  return reasons;
}

function refuse(reasons: readonly string[]): never {
  throw new Error(
    `Session project frame is inconsistent: ${reasons.join('; ')}. `
      + 'Refusing rather than guessing, because the frame decides where every saved '
      + 'measurement and annotation is read back.',
  );
}

/** Normalise a validated record: known fields only, Float64 copies, CRS re-parsed. */
function normalizeRecord(raw: Record<string, unknown>): SessionLayerRecord {
  const crs = parseResolvedCrs(raw.crs);
  const record: SessionLayerRecord = {
    layerId: raw.layerId as string,
    sourceFingerprint: raw.sourceFingerprint as string,
    sourceName: raw.sourceName as string,
    sourceOrigin: toVec3(raw.sourceOrigin as Vec3),
    sourceToProject: toVec3(raw.sourceToProject as Vec3),
    ...(crs ? { crs } : {}),
    upAxis: raw.upAxis as FrameUpAxis,
  };
  return record;
}

/**
 * Read a stored project frame, refusing an inconsistent one.
 *
 * Deliberately NOT the tolerant "drop what is malformed" path the display
 * fields use. Dropping a broken clip box costs a visual setting; dropping or
 * repairing a broken frame changes where saved geometry lands, with nothing on
 * screen to say it happened.
 */
export function parseSessionProjectFrame(raw: unknown): SessionProjectFrame {
  const reasons = validateSessionProjectFrame(raw);
  if (reasons.length > 0) refuse(reasons);
  const doc = raw as { projectOrigin: Vec3; layers: readonly Record<string, unknown>[] };
  return {
    projectOrigin: toVec3(doc.projectOrigin),
    layers: doc.layers.map(normalizeRecord),
  };
}

/**
 * The document form of a frame, refusing to write an inconsistent one. A
 * session this app writes has to be readable by the version that wrote it, so
 * the write side runs the same check as the read side.
 */
export function serializeSessionProjectFrame(frame: SessionProjectFrame): SessionProjectFrame {
  const reasons = validateSessionProjectFrame(frame);
  if (reasons.length > 0) refuse(reasons);
  return {
    projectOrigin: toVec3(frame.projectOrigin),
    layers: frame.layers.map((l) => normalizeRecord(l as unknown as Record<string, unknown>)),
  };
}

/**
 * Build a frame from the layers currently loaded, deriving each transform from
 * the origins rather than accepting one from the caller. Two sources for the
 * same number is how a frame becomes internally inconsistent.
 */
export function buildSessionProjectFrame(input: SessionFrameInput): SessionProjectFrame {
  const origin = input.projectOrigin;
  const layers = input.layers.map((l): SessionLayerRecord => {
    const placed = l.placed === true;
    const vertical = l.placedVertically !== false;
    const dx = l.sourceOrigin[0] - origin[0];
    const dy = l.sourceOrigin[1] - origin[1];
    const dz = l.sourceOrigin[2] - origin[2];
    const sourceToProject: Vec3 = placed ? [dx, dy, vertical ? dz : 0] : [0, 0, 0];
    return {
      layerId: l.layerId,
      sourceFingerprint: l.sourceFingerprint,
      sourceName: l.sourceName,
      sourceOrigin: toVec3(l.sourceOrigin),
      sourceToProject,
      ...(l.crs ? { crs: l.crs } : {}),
      upAxis: l.upAxis,
    };
  });
  const frame: SessionProjectFrame = { projectOrigin: toVec3(origin), layers };
  const reasons = validateSessionProjectFrame(frame);
  if (reasons.length > 0) refuse(reasons);
  return frame;
}

/** One layer's record, or null when the frame does not contain it. */
export function frameLayer(
  frame: SessionProjectFrame,
  layerId: string | undefined,
): SessionLayerRecord | null {
  if (!layerId) return null;
  return frame.layers.find((l) => l.layerId === layerId) ?? null;
}

/**
 * The layer sitting on the project origin, when exactly one does: the layer
 * legacy work is attributed to. Null when none or several do, because "the
 * anchor" is then not a fact about this frame and guessing at it is how work
 * gets attributed to the wrong scan.
 */
export function frameAnchorLayerId(frame: SessionProjectFrame): string | null {
  const o = frame.projectOrigin;
  const on = frame.layers.filter(
    (l) => l.sourceOrigin[0] === o[0] && l.sourceOrigin[1] === o[1] && l.sourceOrigin[2] === o[2],
  );
  return on.length === 1 ? on[0].layerId : null;
}

/**
 * The frame with one layer removed.
 *
 * The project origin and every surviving record are carried across UNCHANGED.
 * that is the whole guarantee. Recomputing the origin from the remaining layers
 * would move every measurement that resolves through it, which is precisely the
 * failure the audit names: removing a layer must not move saved work.
 */
export function withoutFrameLayer(
  frame: SessionProjectFrame,
  layerId: string,
): SessionProjectFrame {
  const layers = frame.layers.filter((l) => l.layerId !== layerId);
  if (layers.length === frame.layers.length) return frame;
  if (layers.length === 0) {
    refuse(['the frame declares no layers once that one is removed']);
  }
  return { projectOrigin: frame.projectOrigin, layers };
}

/**
 * The frame with its layers in a different order. Order is presentation: the
 * records themselves are carried across untouched, so nothing that resolves
 * through the frame moves.
 */
export function withFrameLayerOrder(
  frame: SessionProjectFrame,
  order: readonly string[],
): SessionProjectFrame {
  const byId = new Map(frame.layers.map((l) => [l.layerId, l]));
  if (order.length !== frame.layers.length || new Set(order).size !== order.length) {
    throw new Error(
      'Layer order must name every layer in the frame exactly once; '
        + `got ${order.length} for ${frame.layers.length} layers.`,
    );
  }
  const layers: SessionLayerRecord[] = [];
  for (const id of order) {
    const layer = byId.get(id);
    if (!layer) {
      throw new Error(`Layer order names "${id}", which is not in the frame.`);
    }
    layers.push(layer);
  }
  return { projectOrigin: frame.projectOrigin, layers };
}

/** One piece of saved work, for the cross-check below. */
export interface OwnedItemRef {
  readonly id: string;
  readonly owner?: WorkOwnership;
}

/**
 * Refuse a session whose work names a layer its own frame does not contain.
 *
 * An owner pointing at nothing is not a tolerable gap: read back, that work
 * either vanishes or gets re-homed onto whichever layer is open, and both are
 * silent. The file is internally inconsistent, so it is refused the same way an
 * inconsistent transform is.
 */
export function assertOwnershipWithinFrame(
  frame: SessionProjectFrame,
  items: readonly OwnedItemRef[],
  kind: string,
): void {
  const ids = new Set(frame.layers.map((l) => l.layerId));
  const orphans = items.filter(
    (i) => i.owner?.frame === 'source-local' && !ids.has(i.owner.layerId ?? ''),
  );
  if (orphans.length === 0) return;
  const named = orphans
    .slice(0, 3)
    .map((o) => `${o.id} → ${o.owner?.layerId ?? '(none)'}`)
    .join(', ');
  throw new Error(
    `Session ${kind} name a layer the project frame does not contain (${named}). `
      + 'Refusing rather than guessing, because work whose owning layer is missing would '
      + 'otherwise be read in whatever frame happens to be open.',
  );
}
