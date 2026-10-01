/**
 * embedBridge.ts
 *
 * The optional cross-frame control protocol for embedded OpenLiDARViewer.
 *
 * Outbound: once the viewer is ready it posts a single `ready` message to the
 * embedding parent. Inbound: it accepts a fixed, validated set of four
 * commands — `load-file`, `jump-camera`, `toggle-layer`, `focus-annotation`.
 *
 * The verb set is closed: every message is shape-validated, anything
 * unrecognised is ignored, and the bridge performs only these four specific,
 * bounded actions — it never evaluates arbitrary instructions. All four are
 * safe regardless of origin (a local camera move, a layer toggle, an
 * annotation focus, or parsing host-provided bytes entirely in-page).
 *
 * Message interpretation is a pure function (`interpretEmbedMessage`), so it is
 * unit-tested; `startEmbedBridge` is the thin browser glue.
 */

import type { SavedCameraState } from '../render/annotate/types';

/** The tag identifying messages this viewer sends. */
const SOURCE = 'openlidarviewer';

/**
 * Byte ceiling on an embed `load-file` buffer. The host pushes the whole file in
 * one `postMessage`. NOTE the ceiling can only bound the DECODE allocation, not
 * the message delivery: a structured CLONE copies the ArrayBuffer into this
 * frame before `interpretEmbedMessage` runs, so the copy happens regardless of
 * this limit. A host that wants to avoid that copy should TRANSFER the buffer
 * (`postMessage(msg, [buffer])`), which moves ownership with no clone; the
 * ceiling then rejects an over-large decode after a cheap, non-copying delivery.
 * Kept deliberately modest for an iframe embed (512 MiB) — a viewer meant to be
 * embedded should not be handed multi-gigabyte payloads over postMessage.
 */
export const MAX_EMBED_FILE_BYTES = 512 * 1024 * 1024;

/** A validated inbound command — the discriminated result of one message. */
export type EmbedCommand =
  | { kind: 'load-file'; buffer: ArrayBuffer; name: string }
  | { kind: 'jump-camera'; camera: SavedCameraState }
  | { kind: 'toggle-layer'; id: string; visible: boolean }
  | { kind: 'focus-annotation'; id: string };

/** Handlers the host frame's commands are dispatched to. */
export interface EmbedBridgeHandlers {
  onLoadFile: (buffer: ArrayBuffer, name: string) => void;
  onJumpCamera: (camera: SavedCameraState) => void;
  onToggleLayer: (id: string, visible: boolean) => void;
  onFocusAnnotation: (id: string) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Validate a finite-number triple. */
function asVec3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return [v[0], v[1], v[2]];
}

/** Validate a camera-state payload — position and target required. */
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

/**
 * Interpret a raw `MessageEvent.data` value as an embed command, or `null`
 * when it is not a valid, recognised command. Pure — no side effects.
 */
export function interpretEmbedMessage(data: unknown): EmbedCommand | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'load-file':
      // The buffer is host-supplied and copied into this frame whole; cap its
      // byteLength so an absurd size is dropped here, not in the decoder.
      return data.buffer instanceof ArrayBuffer &&
        data.buffer.byteLength <= MAX_EMBED_FILE_BYTES &&
        typeof data.name === 'string'
        ? { kind: 'load-file', buffer: data.buffer, name: data.name }
        : null;
    case 'jump-camera': {
      const camera = asCamera(data.camera);
      return camera ? { kind: 'jump-camera', camera } : null;
    }
    case 'toggle-layer':
      return typeof data.id === 'string' && typeof data.visible === 'boolean'
        ? { kind: 'toggle-layer', id: data.id, visible: data.visible }
        : null;
    case 'focus-annotation':
      return typeof data.id === 'string'
        ? { kind: 'focus-annotation', id: data.id }
        : null;
    default:
      return null;
  }
}

/** Options for `startEmbedBridge`. */
export interface EmbedBridgeOptions {
  /**
   * Origins that may drive the viewer. The `ready` message goes to each of
   * them, and inbound commands from any other origin are dropped. When the
   * list is empty or unset, the bridge sends nothing and accepts nothing.
   */
  readonly allowedOrigins?: readonly string[];
}

/**
 * Read the embed-bridge allow-list off the page URL:
 *
 *   - `?embedParent=https://embed.example.com` allows one origin.
 *   - `?embedOrigins=https://a.example.com,https://b.example.com` allows a
 *     comma-separated list and takes precedence over `embedParent`.
 *
 * Returns `{}` when neither parameter is present.
 */
export function embedBridgeOptionsFromUrl(search: string): EmbedBridgeOptions {
  let allowedOrigins: string[] | undefined;
  try {
    const params = new URLSearchParams(search);
    const parent = params.get('embedParent');
    if (parent) allowedOrigins = [parent];
    const origins = params.get('embedOrigins');
    if (origins) {
      allowedOrigins = origins
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } catch {
    /* URL parsing failure → fall back to defaults */
  }
  return allowedOrigins ? { allowedOrigins } : {};
}

/**
 * Start the embed bridge: announce readiness to each allowed origin and
 * listen for the documented commands from the embedding parent on one of
 * those origins. With no allow-list the bridge is inert. Returns a disposer
 * that removes the listener.
 */
export function startEmbedBridge(
  handlers: EmbedBridgeHandlers,
  options: EmbedBridgeOptions = {},
): () => void {
  const allow = options.allowedOrigins ?? [];

  // Announce readiness to the embedding parent on each allowed origin; the
  // browser delivers only the one matching the parent's actual origin.
  if (window.parent && window.parent !== window) {
    for (const origin of allow) {
      window.parent.postMessage(
        { source: SOURCE, type: 'ready', version: __APP_VERSION__ },
        origin,
      );
    }
  }

  const onMessage = (event: MessageEvent): void => {
    // Only the actual embedding parent may drive the viewer — never a sibling
    // iframe, an opener, or a popup that postMessages into this window. The
    // source check runs UNCONDITIONALLY: at top level `window.parent === window`,
    // so this accepts only a message from the window itself and drops an opener
    // (which is a DIFFERENT window). Guarding it behind `window.parent !== window`
    // — as this once did — skipped the check entirely at top level and let an
    // opener that did `window.open('…?embed=1')` then postMessage drive the app.
    // A genuine iframe embed is unaffected: `event.source === window.parent` still.
    if (event.source !== window.parent) return;
    if (!allow.includes(event.origin)) return;
    const command = interpretEmbedMessage(event.data);
    if (!command) return;
    switch (command.kind) {
      case 'load-file':
        handlers.onLoadFile(command.buffer, command.name);
        return;
      case 'jump-camera':
        handlers.onJumpCamera(command.camera);
        return;
      case 'toggle-layer':
        handlers.onToggleLayer(command.id, command.visible);
        return;
      case 'focus-annotation':
        handlers.onFocusAnnotation(command.id);
        return;
    }
  };

  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
