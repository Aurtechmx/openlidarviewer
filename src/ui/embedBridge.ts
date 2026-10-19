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
 * bounded in what they can do (a local camera move, a layer toggle, an
 * annotation focus, or parsing host-provided bytes entirely in-page), but they
 * still change what the viewer shows, so they are accepted only from a parent
 * the embed policy trusts (`embedPolicy.ts`): the viewer's own origin or one on
 * the deployer's build-time allow-list. Nothing in the viewer's URL can add to
 * that list.
 *
 * Message interpretation is a pure function (`interpretEmbedMessage`), so it is
 * unit-tested; `startEmbedBridge` is the thin browser glue.
 */

import type { SavedCameraState } from '../render/annotate/types';
import {
  decideFramePolicy,
  deployerEmbedOrigins,
  readFrameFacts,
  toOrigin,
} from './embedPolicy';

/** The tag identifying messages this viewer sends. */
const SOURCE = 'openlidarviewer';

/**
 * Byte ceiling on an embed `load-file` buffer. The host pushes the whole file in
 * one `postMessage`. NOTE the ceiling can only bound the DECODE allocation, not
 * the message delivery: a structured CLONE copies the ArrayBuffer into this
 * frame before `interpretEmbedMessage` runs, so the copy happens regardless of
 * this limit, and a receiver cannot tell a cloned buffer from a transferred
 * one. A host that wants to avoid that copy should TRANSFER the buffer
 * (`postMessage(msg, [buffer])`), which moves ownership with no clone; the
 * ceiling then rejects an over-large decode after a cheap, non-copying delivery.
 * A viewer meant to be embedded should not be handed larger payloads over
 * postMessage than 256 MiB; a bigger scan is opened in the viewer itself.
 */
export const MAX_EMBED_FILE_BYTES = 256 * 1024 * 1024;

/** Longest file name a `load-file` command may carry. */
export const MAX_EMBED_NAME_LENGTH = 255;

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
      // byteLength so an absurd size is dropped here, not in the decoder. Only
      // a plain ArrayBuffer is taken (not a view, a SharedArrayBuffer or a Blob).
      return data.buffer instanceof ArrayBuffer &&
        data.buffer.byteLength <= MAX_EMBED_FILE_BYTES &&
        typeof data.name === 'string' &&
        data.name.length > 0 &&
        data.name.length <= MAX_EMBED_NAME_LENGTH
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
   * Origins the viewer URL asks to embed it. A request only: it narrows the
   * deployer's allow-list and cannot add an origin to it, because whoever
   * framed the page chose the URL.
   */
  readonly allowedOrigins?: readonly string[];
  /** The deployer's allow-list. Defaults to the build-time `OLV_EMBED_ORIGINS`. */
  readonly deployerOrigins?: readonly string[];
}

/**
 * Read the origins the page URL requests:
 *
 *   - `?embedParent=https://embed.example.com` requests one origin.
 *   - `?embedOrigins=https://a.example.com,https://b.example.com` requests a
 *     comma-separated list and takes precedence over `embedParent`.
 *
 * Returns `{}` when neither parameter is present. The result is a request; the
 * bridge honours only the origins the deployer also allows.
 */
export function embedBridgeOptionsFromUrl(search: string): EmbedBridgeOptions {
  const params = new URLSearchParams(search);
  const raw = params.get('embedOrigins')?.split(',') ?? [params.get('embedParent') ?? ''];
  const allowedOrigins = raw.map(toOrigin).filter((o): o is string => o !== null);
  return allowedOrigins.length > 0 ? { allowedOrigins } : {};
}

/**
 * Start the embed bridge: announce readiness to the embedding parent and
 * listen for the documented commands from it. Which parent counts is decided by
 * {@link decideFramePolicy}: the page's own origin, or an origin on the
 * deployer's allow-list. A page framed by anything else gets no `ready` message
 * and no listener. Returns a disposer that removes the listener.
 */
export function startEmbedBridge(
  handlers: EmbedBridgeHandlers,
  options: EmbedBridgeOptions = {},
): () => void {
  const decision = decideFramePolicy(readFrameFacts(window), {
    deployerOrigins: options.deployerOrigins ?? deployerEmbedOrigins(),
    requestedOrigins: options.allowedOrigins,
  });
  if (decision.kind === 'safe') return () => {};
  const allow = decision.origins;

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
