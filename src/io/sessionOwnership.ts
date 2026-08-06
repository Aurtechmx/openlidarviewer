/**
 * sessionOwnership.ts: attributing saved work that arrived without an owner.
 *
 * A session written before v8 has no ownership at all: it describes one scan,
 * one origin, and one flat list of measurements and annotations. Such a file
 * must still import with everything intact, which means its work has to be
 * attributed to a layer, and the honest way to do that is to assign the anchor
 * (or only) layer and MARK the assignment as inferred, so nothing downstream
 * mistakes a migration's best reading for something the author stated.
 *
 * The rules, in order:
 *   • work that already declares an owner is left exactly as declared;
 *   • work without one is assigned the anchor layer, `inferred: true`;
 *   • when no anchor can be established, the work is left unattributed rather
 *     than given an owner that was invented.
 *
 * The anchor is never taken from a filename or a display label. It comes from
 * the id of the layer actually loaded, from the project frame's anchor record,
 * or from the session's own stored `layerId`, all of which are stable ids.
 *
 * Pure: no DOM, no viewer. Unit-tested in Node.
 */

import type { InspectionSession } from './session';
import { frameAnchorLayerId, frameLayer } from './sessionFrame';
import { sourceLocalOwnership } from '../model/workOwnership';
import type { Measurement } from '../render/measure/types';
import type { Annotation } from '../render/annotate/types';

export interface SessionOwnershipOptions {
  /**
   * The stable id of the layer this session is being restored onto, when the
   * caller knows it. Resolved from the loaded scan's SOURCE FACTS (point count,
   * extents, CRS) through the layer-identity registry, never from its
   * filename, which collides between different scans.
   */
  readonly loadedLayerId?: string;
}

export interface SessionOwnershipMigration {
  /** Measurements with ownership filled in where it was missing. */
  readonly measurements: Measurement[];
  /** Annotations with ownership filled in where it was missing. */
  readonly annotations: Annotation[];
  /** The layer legacy work was attributed to, or null when none could be established. */
  readonly anchorLayerId: string | null;
  readonly inferredMeasurementIds: readonly string[];
  readonly inferredAnnotationIds: readonly string[];
  /** Items left with no owner because no anchor could be established. */
  readonly unattributed: number;
}

/**
 * The layer a session's unowned work belongs to, or null when that cannot be
 * established.
 *
 * Precedence, strongest evidence first: the layer the session is being restored
 * onto (the caller resolved it from source facts), then the frame's own anchor
 * record, then the session's stored layer id. A candidate that a declared frame
 * does not contain is rejected at each step. Attributing work to a layer the
 * file's own frame has never heard of would write a session that cannot be read
 * back.
 */
export function resolveSessionAnchorLayerId(
  session: InspectionSession,
  loadedLayerId?: string,
): string | null {
  const frame = session.projectFrame;
  const known = (id: string | undefined | null): string | null => {
    if (typeof id !== 'string' || id.length === 0) return null;
    if (frame && !frameLayer(frame, id)) return null;
    return id;
  };
  return known(loadedLayerId)
    ?? (frame ? frameAnchorLayerId(frame) : null)
    ?? known(session.layerId)
    ?? null;
}

/**
 * Attribute a session's work, filling in ownership only where the file states
 * none. Never moves geometry: an owner is a statement about which frame the
 * stored coordinates are already in, so recording it changes no coordinate.
 */
export function migrateSessionOwnership(
  session: InspectionSession,
  options: SessionOwnershipOptions = {},
): SessionOwnershipMigration {
  const anchorLayerId = resolveSessionAnchorLayerId(session, options.loadedLayerId);
  const inferredMeasurementIds: string[] = [];
  const inferredAnnotationIds: string[] = [];
  let unattributed = 0;

  const owner = anchorLayerId ? sourceLocalOwnership(anchorLayerId, { inferred: true }) : null;

  const measurements = session.measurements.map((m) => {
    if (m.owner) return m;
    if (!owner) {
      unattributed += 1;
      return m;
    }
    inferredMeasurementIds.push(m.id);
    return { ...m, owner };
  });
  const annotations = session.annotations.map((a) => {
    if (a.owner) return a;
    if (!owner) {
      unattributed += 1;
      return a;
    }
    inferredAnnotationIds.push(a.id);
    return { ...a, owner };
  });

  return {
    measurements,
    annotations,
    anchorLayerId,
    inferredMeasurementIds,
    inferredAnnotationIds,
    unattributed,
  };
}
