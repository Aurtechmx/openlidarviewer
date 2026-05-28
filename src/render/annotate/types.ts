/**
 * types.ts
 *
 * The annotation data model — the core of the inspection layer.
 *
 * Pure data: no three.js, no DOM, so it is unit-tested in Node alongside the
 * session serializer. `Annotation.localPosition` is in LOCAL (render-space)
 * coordinates — the same space the cloud's positions and `Measurement.points`
 * live in. The model carries NO transient UI state (selection, hover, draft
 * flags); those live in the controller, so a serialised annotation stays clean
 * and forward-compatible.
 */

import type { NavMode } from '../NavController';

/** The four annotation categories — each drives a distinct marker style. */
export type AnnotationType = 'note' | 'info' | 'warning' | 'issue';

/** Every annotation type, in display order. */
export const ANNOTATION_TYPES: readonly AnnotationType[] = ['note', 'info', 'warning', 'issue'];

/** A 3-component coordinate in object form. */
export interface Vec3Object {
  x: number;
  y: number;
  z: number;
}

/** A camera viewpoint rich enough to restore a saved view. */
export interface SavedCameraState {
  position: [number, number, number];
  target: [number, number, number];
  /** Navigation mode in effect when the state was captured. */
  mode?: NavMode;
  /** Vertical field of view in degrees, when it differs from the default. */
  fov?: number;
}

/** A point of interest marked on the scan. */
export interface Annotation {
  /** Stable unique identifier. */
  id: string;
  /** User-facing, editable label. */
  title: string;
  /** Optional free-text note. */
  note?: string;
  /** Category — drives the marker styling. */
  type: AnnotationType;
  /** Creation time, epoch milliseconds. */
  createdAt: number;
  /** Last-edit time, epoch milliseconds. */
  updatedAt: number;
  /**
   * Position in LOCAL (render-space) coordinates — the marker anchor.
   *
   * Anchor-persistence guarantee: `localPosition` is a world-space anchor in the
   * scan's render frame, NOT a node-relative offset or a buffer index. When a
   * streaming COPC node is refined (a coarser node is replaced by deeper
   * children covering the same volume), the annotation does not move; its
   * coordinates were captured against the cloud's coordinate system, not
   * against any particular node's mesh.
   */
  localPosition: Vec3Object;
  /** Georeferenced position (local + cloud origin); recomputed on load. */
  worldPosition?: Vec3Object;
  /** Camera viewpoint captured at creation, for "jump to annotation". */
  cameraState?: SavedCameraState;
  /** Optional link to a measurement by its id. */
  linkedMeasurementId?: string;
}

/** Type guard for a valid {@link AnnotationType}. */
export function isAnnotationType(v: unknown): v is AnnotationType {
  return v === 'note' || v === 'info' || v === 'warning' || v === 'issue';
}

/** A reasonably unique id — `crypto.randomUUID` when available, else a fallback. */
export function freshAnnotationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `a_${Math.random().toString(36).slice(2, 11)}`;
}

/** A defensively cloned copy of a coordinate. */
function cloneVec3(v: Vec3Object): Vec3Object {
  return { x: v.x, y: v.y, z: v.z };
}

/** Trim a title, falling back to a default when it is empty. */
function cleanTitle(title: string): string {
  const t = title.trim();
  return t.length > 0 ? t : 'Annotation';
}

/** An empty or whitespace-only note normalises to absent. */
function cleanNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  return note.trim().length > 0 ? note : undefined;
}

/** The fields a caller supplies to create an annotation; the rest are filled. */
export interface NewAnnotation {
  title: string;
  note?: string;
  type: AnnotationType;
  localPosition: Vec3Object;
  worldPosition?: Vec3Object;
  cameraState?: SavedCameraState;
  linkedMeasurementId?: string;
}

/**
 * Build a complete {@link Annotation} from the caller-supplied fields, filling
 * the id and the created/updated timestamps. `now` is injectable so tests are
 * deterministic.
 */
export function createAnnotation(input: NewAnnotation, now: number = Date.now()): Annotation {
  const a: Annotation = {
    id: freshAnnotationId(),
    title: cleanTitle(input.title),
    type: input.type,
    createdAt: now,
    updatedAt: now,
    localPosition: cloneVec3(input.localPosition),
  };
  const note = cleanNote(input.note);
  if (note !== undefined) a.note = note;
  if (input.worldPosition) a.worldPosition = cloneVec3(input.worldPosition);
  if (input.cameraState) a.cameraState = input.cameraState;
  if (input.linkedMeasurementId) a.linkedMeasurementId = input.linkedMeasurementId;
  return a;
}

/** An edit to an annotation. Only the provided fields change. */
export interface AnnotationEdit {
  title?: string;
  note?: string;
  type?: AnnotationType;
  /** A measurement id to link, or `null` to clear an existing link. */
  linkedMeasurementId?: string | null;
}

/**
 * Apply an edit to an annotation, returning a NEW annotation with a refreshed
 * `updatedAt`. The original is never mutated — which keeps the model
 * immutable, so a future undo/redo stack can simply retain old objects.
 */
export function editAnnotation(
  a: Annotation,
  edit: AnnotationEdit,
  now: number = Date.now(),
): Annotation {
  const next: Annotation = { ...a, updatedAt: now };
  if (edit.title !== undefined) {
    // A blank title is rejected — the existing title is kept rather than reset.
    const trimmed = edit.title.trim();
    if (trimmed.length > 0) next.title = trimmed;
  }
  if (edit.note !== undefined) {
    const note = cleanNote(edit.note);
    if (note !== undefined) next.note = note;
    else delete next.note;
  }
  if (edit.type !== undefined) next.type = edit.type;
  if (edit.linkedMeasurementId !== undefined) {
    if (edit.linkedMeasurementId === null) delete next.linkedMeasurementId;
    else next.linkedMeasurementId = edit.linkedMeasurementId;
  }
  return next;
}
