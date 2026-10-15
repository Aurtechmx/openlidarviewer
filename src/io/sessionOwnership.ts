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
import { frameAnchorLayerId, frameLayer, shiftAnnotation, shiftMeasurement, type SessionLayerRecord, type SessionProjectFrame } from './sessionFrame';
import { fingerprintKey } from '../model/layerIdentity';
import { sourceLocalOwnership, type WorkOwnership } from '../model/workOwnership';
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

// --- persisted layer identity -> open layers ---------------------------------

type Vec3 = readonly [number, number, number];

/**
 * One open layer, as the import reads it: its live stable id plus the source
 * evidence that id was bound on. Every field is a source fact; none is the
 * display name alone.
 */
export interface LiveLayerEvidence {
  /** The stable id this page bound the layer to. */
  readonly layerId: string;
  /** The canonical source-fingerprint key that id is anchored on (`fingerprintKey`). */
  readonly fingerprint: string;
  /** The file's own source origin, or null when the layer has none. */
  readonly sourceOrigin: Vec3 | null;
  /** The layer's own vertical axis. */
  readonly upAxis: 'x' | 'y' | 'z';
  /** Horizontal EPSG the file declares, when it declares one. */
  readonly epsg?: number | null;
}

/** What became of one layer id the file names. */
export type PersistedLayerMatch =
  | { readonly kind: 'resolved'; readonly liveId: string }
  /** No open layer carries this source: the work waits for it. */
  | { readonly kind: 'missing' }
  /** More than one open layer carries this source, or one open layer carries two saved ones. */
  | { readonly kind: 'ambiguous' };

export interface SessionLayerMapping {
  /** Every saved layer id the file names, with its outcome. */
  readonly byId: ReadonlyMap<string, PersistedLayerMatch>;
}

/** A shift below this many source units is the same origin. */
const ORIGIN_TOLERANCE = 1e-6;

/**
 * Whether a fingerprint key records anything beyond a file name. A key that
 * holds a name and nothing that tells content apart (count, extents) collides
 * between different scans, so it can never establish identity on its own.
 */
export function keyHasContentFacts(key: string): boolean {
  const parts = key.split('\0');
  return parts[0] === 'f' && parts.slice(2, 6).some((p) => p !== '');
}

function originsAgree(a: Vec3 | null, b: Vec3): boolean {
  if (!a) return false;
  return [0, 1, 2].every((k) => Math.abs(a[k]! - b[k]!) <= ORIGIN_TOLERANCE);
}

/**
 * Map each layer a session's project frame records onto the open layers.
 *
 * A saved layer is the open layer whose source fingerprint key is identical,
 * whose file origin is the same and whose vertical axis and declared EPSG
 * agree. Anything weaker is not identity: a file name is shared by unrelated
 * captures, so a key without content facts never matches. Several open layers
 * matching one record, or one open layer matched by several records, is
 * ambiguous, and ambiguous work is never bound to whichever layer is active.
 */
export function mapSessionLayers(
  frame: SessionProjectFrame,
  live: readonly LiveLayerEvidence[],
): SessionLayerMapping {
  const candidates = new Map<string, LiveLayerEvidence[]>();
  for (const rec of frame.layers) {
    const epsg = rec.crs?.epsg;
    candidates.set(rec.layerId, keyHasContentFacts(rec.sourceFingerprint)
      ? live.filter((l) => l.fingerprint === rec.sourceFingerprint
        && originsAgree(l.sourceOrigin, rec.sourceOrigin)
        && l.upAxis === rec.upAxis
        && (epsg == null || l.epsg == null || l.epsg === epsg))
      : []);
  }
  const claims = new Map<string, number>();
  for (const c of candidates.values()) if (c.length === 1) claims.set(c[0]!.layerId, (claims.get(c[0]!.layerId) ?? 0) + 1);
  const byId = new Map<string, PersistedLayerMatch>();
  for (const [savedId, c] of candidates) {
    if (c.length === 0) byId.set(savedId, { kind: 'missing' });
    else if (c.length > 1 || claims.get(c[0]!.layerId)! > 1) byId.set(savedId, { kind: 'ambiguous' });
    else byId.set(savedId, { kind: 'resolved', liveId: c[0]!.layerId });
  }
  return { byId };
}

/** Every layer id a session's work and arrangement name, frame records excluded. */
export function sessionWorkLayerIds(session: InspectionSession): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | undefined): void => { if (id) ids.add(id); };
  for (const m of session.measurements) {
    add(m.owner?.layerId);
    for (const id of m.pickLayers ?? []) add(id);
  }
  for (const a of session.annotations) add(a.owner?.layerId);
  add(session.layerId);
  return ids;
}

/**
 * The mapping for a file with no project frame. Such a file describes one scan,
 * which the scan-identity check has already matched to the active layer, so
 * the one id it names is that layer. A frameless file naming several ids
 * cannot say which is which: each is ambiguous.
 */
export function mapSingleScanSession(
  session: InspectionSession,
  activeLayerId: string | null,
): SessionLayerMapping {
  const ids = sessionWorkLayerIds(session);
  const byId = new Map<string, PersistedLayerMatch>();
  for (const id of ids) {
    byId.set(id, ids.size === 1 && activeLayerId ? { kind: 'resolved', liveId: activeLayerId } : { kind: 'ambiguous' });
  }
  return { byId };
}

/**
 * Records for the layers a session with no project frame names, so work held
 * from it can be written into a frame and read back in the same place.
 *
 * Such a file has one frame, `session.origin`, so every record is a layer in
 * its own frame at that origin. The file's own layer (`session.layerId`) is
 * keyed on the facts its scan summary states, so a later open of that exact
 * scan can be matched to it. Every other id has no source evidence at all and
 * gets a key with no content facts, which never matches an open layer.
 */
export function framelessHeldRecords(session: InspectionSession, layerIds: Iterable<string>): SessionLayerRecord[] {
  const o = session.origin;
  const summary = session.scanSummary;
  return [...layerIds].map((layerId) => {
    const own = !!summary && layerId === session.layerId;
    return {
      layerId,
      sourceFingerprint: own
        ? fingerprintKey({ fileName: summary.fileName, sourcePoints: summary.sourcePoints, width: summary.width, depth: summary.depth, height: summary.height, epsg: summary.epsg, crs: summary.crs, origin: [o[0], o[1], o[2]] })
        : fingerprintKey({}),
      sourceName: own ? summary.fileName : '',
      sourceOrigin: [o[0], o[1], o[2]],
      sourceToProject: [0, 0, 0],
      upAxis: session.upAxis,
    };
  });
}

/**
 * The session with every saved layer id replaced by the open layer it maps to.
 * Frame records, owners, pick records, profile provenance, layer groups and the
 * top-level layer id move together, so the file stays consistent with itself.
 * An id that maps to nothing keeps its saved value, unless that value happens
 * to be a live id of some other layer, in which case it is renamed so it can
 * never be read as that layer.
 */
export function remapSessionLayerIds(
  session: InspectionSession,
  mapping: SessionLayerMapping,
  liveIds: ReadonlySet<string>,
): InspectionSession {
  const to = new Map<string, string>();
  for (const [savedId, match] of mapping.byId) {
    if (match.kind === 'resolved') to.set(savedId, match.liveId);
    else if (liveIds.has(savedId)) to.set(savedId, `${savedId}~unmatched`);
  }
  if (to.size === 0) return session;
  const id = (v: string): string => to.get(v) ?? v;
  const owner = <T extends { owner?: WorkOwnership }>(x: T): T =>
    x.owner?.layerId ? { ...x, owner: { ...x.owner, layerId: id(x.owner.layerId) } } : x;
  const measurements = session.measurements.map((m) => {
    const next = owner(m);
    if (next.pickLayers) next.pickLayers = next.pickLayers.map(id);
    if (next.profileProvenance) {
      next.profileProvenance = {
        ...next.profileProvenance,
        sources: next.profileProvenance.sources.map((s) => ({ ...s, layerId: id(s.layerId) })),
      };
    }
    return next === m ? { ...m, ...(m.pickLayers ? { pickLayers: m.pickLayers.map(id) } : {}) } : next;
  });
  return {
    ...session,
    measurements,
    annotations: session.annotations.map(owner),
    ...(session.layerId ? { layerId: id(session.layerId) } : {}),
    ...(session.layerGroups ? { layerGroups: session.layerGroups.map((g) => ({ ...g, memberIds: g.memberIds.map(id) })) } : {}),
    ...(session.projectFrame
      ? { projectFrame: { ...session.projectFrame, layers: session.projectFrame.layers.map((l) => ({ ...l, layerId: id(l.layerId) })) } }
      : {}),
  };
}

/** Why an item of saved work was not placed among the open layers. */
export type HeldReason = 'missing' | 'ambiguous';

/**
 * Split saved work into what names only resolved layers (or none) and what
 * names a layer that is missing or ambiguous. Run on the REMAPPED session with
 * the mapping keyed by live id, so resolved ids are recognised by value.
 */
export function partitionHeldWork(
  session: InspectionSession,
  unresolved: ReadonlyMap<string, HeldReason>,
): {
  readonly measurements: Measurement[];
  readonly annotations: Annotation[];
  readonly held: { readonly measurements: Measurement[]; readonly annotations: Annotation[] };
  readonly missing: number;
  readonly ambiguous: number;
} {
  let missing = 0;
  let ambiguous = 0;
  const reasonOf = (ids: readonly string[]): HeldReason | null => {
    const r = ids.map((i) => unresolved.get(i)).filter((x): x is HeldReason => !!x);
    if (r.length === 0) return null;
    return r.includes('ambiguous') ? 'ambiguous' : 'missing';
  };
  const count = (r: HeldReason): void => { if (r === 'missing') missing++; else ambiguous++; };
  const measurements: Measurement[] = [];
  const heldM: Measurement[] = [];
  for (const m of session.measurements) {
    const r = reasonOf([...(m.owner?.layerId ? [m.owner.layerId] : []), ...(m.pickLayers ?? [])]);
    if (r) { heldM.push(m); count(r); } else measurements.push(m);
  }
  const annotations: Annotation[] = [];
  const heldA: Annotation[] = [];
  for (const a of session.annotations) {
    const r = reasonOf(a.owner?.layerId ? [a.owner.layerId] : []);
    if (r) { heldA.push(a); count(r); } else annotations.push(a);
  }
  return { measurements, annotations, held: { measurements: heldM, annotations: heldA }, missing, ambiguous };
}

/** The open scene a restore is written into, as owner normalisation reads it. */
export interface RestoreTarget {
  /** Live ids of the open layers. */
  readonly liveIds: ReadonlySet<string>;
  /** True when the open scene has a project frame. */
  readonly hasProjectFrame: boolean;
  /** The origin a live layer's scene coordinates are local to, or null when it is not open. */
  layerOrigin(layerId: string): Vec3 | null;
  /** The origin work rebased by the session's single delta is local to (the active layer's). */
  readonly exportOrigin: Vec3;
  /** A live layer's own file origin, or null. */
  sourceOrigin(layerId: string): Vec3 | null;
}

/**
 * Restate each restored item's owner the way the open scene holds work on that
 * layer, moving its coordinates to match. With a project frame open, work is
 * `project` and local to its layer's scene origin; with none (a single layer in
 * its own frame), the same coordinates are local to the layer's file origin and
 * the owner says `source-local`. Writing it back with a `project` owner and no
 * frame would make the next import refuse it.
 *
 * `rebasedBy` says which origin the rebase left each item local to: the
 * owning layer's scene origin (`layer`), the session's single delta onto the
 * active layer (`export`), or its own file origin, untouched (`source`).
 * Work with no owner, or an owner naming no open layer, is returned as it is.
 */
export function normalizeRestoredOwners(
  measurements: readonly Measurement[],
  annotations: readonly Annotation[],
  rebasedBy: (id: string, owner: WorkOwnership) => 'layer' | 'export' | 'source',
  upAxis: 'y' | 'z',
  target: RestoreTarget,
): { readonly measurements: Measurement[]; readonly annotations: Annotation[] } {
  const plan = (id: string, owner: WorkOwnership | undefined): { d: Vec3; owner: WorkOwnership } | null => {
    const L = owner?.layerId;
    if (!owner || !L || !target.liveIds.has(L)) return null;
    const to = target.layerOrigin(L);
    if (!to) return null;
    const how = rebasedBy(id, owner);
    const from = how === 'layer' ? to : how === 'export' ? target.exportOrigin : target.sourceOrigin(L);
    if (!from) return null;
    const next: WorkOwnership = {
      layerId: L,
      frame: target.hasProjectFrame ? 'project' : 'source-local',
      ...(owner.inferred ? { inferred: true } : {}),
    };
    return { d: [from[0] - to[0], from[1] - to[1], from[2] - to[2]], owner: next };
  };
  return {
    measurements: measurements.map((m) => {
      const p = plan(m.id, m.owner);
      return p ? { ...shiftMeasurement(m, p.d, upAxis), owner: p.owner } : m;
    }),
    annotations: annotations.map((a) => {
      const p = plan(a.id, a.owner);
      return p ? { ...shiftAnnotation(a, p.d), owner: p.owner } : a;
    }),
  };
}
