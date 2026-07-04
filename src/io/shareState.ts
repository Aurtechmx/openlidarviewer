/**
 * shareState.ts
 *
 * Encodes a reproducible *viewer state* — camera, colour mode, point sizing,
 * and the selected annotation — into a compact URL hash, and decodes it back.
 *
 * It never encodes scan data. A share link reproduces a *view*; the recipient
 * opens the same scan themselves and the saved view is applied on top. This is
 * what makes "share this view" work with no backend and no upload.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

import type { SavedCameraState } from '../render/annotate/types';

/** The reproducible viewer state carried by a share link. Every field optional. */
export interface ShareState {
  /** Camera viewpoint — the headline of a shared view. */
  camera?: SavedCameraState;
  /** Active colour mode id (validated against the loaded cloud on apply). */
  colorMode?: string;
  /** Base point size. */
  pointSize?: number;
  /** Point-size mode id (`adaptive` / `fixed`). */
  pointSizeMode?: string;
  /** The selected annotation's id, when one was selected. */
  selectedAnnotation?: string;
}

/** Hard cap on an accepted hash payload — a sane bound against abuse. */
const MAX_ENCODED_LENGTH = 4096;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Validate a finite-number triple. */
function asVec3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return [v[0], v[1], v[2]];
}

/** Validate a camera-state object — position and target required. */
function asCamera(v: unknown): SavedCameraState | null {
  if (!isRecord(v)) return null;
  const position = asVec3(v.position);
  const target = asVec3(v.target);
  if (!position || !target) return null;
  const camera: SavedCameraState = { position, target };
  // 'pan' joined the mode union in v0.5.5 (P1 hand tool).
  if (v.mode === 'orbit' || v.mode === 'walk' || v.mode === 'fly' || v.mode === 'pan') camera.mode = v.mode;
  if (typeof v.fov === 'number' && Number.isFinite(v.fov)) camera.fov = v.fov;
  return camera;
}

/** Encode a string to URL-safe base64 (no `+`, `/`, or `=` padding). */
function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a URL-safe base64 string. */
function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

/**
 * Encode a viewer state into a compact, URL-safe string — the value placed
 * after `#s=` in a share link. Only the fields that are set are encoded.
 */
export function encodeShareState(state: ShareState): string {
  // A compact object — undefined fields are dropped by JSON.stringify.
  const compact: ShareState = {};
  if (state.camera) compact.camera = state.camera;
  if (state.colorMode) compact.colorMode = state.colorMode;
  if (typeof state.pointSize === 'number') compact.pointSize = state.pointSize;
  if (state.pointSizeMode) compact.pointSizeMode = state.pointSizeMode;
  if (state.selectedAnnotation) compact.selectedAnnotation = state.selectedAnnotation;
  return toBase64Url(JSON.stringify(compact));
}

/**
 * Decode a share-link payload back into a viewer state. Every field is
 * validated; anything malformed is dropped, and a payload that is not valid
 * JSON (or is suspiciously long) yields `null` — never a throw.
 */
export function decodeShareState(encoded: string): ShareState | null {
  if (!encoded || encoded.length > MAX_ENCODED_LENGTH) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(encoded));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const state: ShareState = {};
  const camera = asCamera(raw.camera);
  if (camera) state.camera = camera;
  if (typeof raw.colorMode === 'string') state.colorMode = raw.colorMode;
  if (typeof raw.pointSize === 'number' && Number.isFinite(raw.pointSize)) {
    state.pointSize = raw.pointSize;
  }
  if (typeof raw.pointSizeMode === 'string') state.pointSizeMode = raw.pointSizeMode;
  if (typeof raw.selectedAnnotation === 'string') {
    state.selectedAnnotation = raw.selectedAnnotation;
  }
  return state;
}
