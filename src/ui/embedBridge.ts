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
  if (v.mode === 'orbit' || v.mode === 'walk' || v.mode === 'fly') camera.mode = v.mode;
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
      return data.buffer instanceof ArrayBuffer && typeof data.name === 'string'
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
   * Target origin for the outbound `ready` ping. The default is `'*'`
   * (broadcast to any parent) because the message payload is just
   * the source tag and version — non-sensitive. Stricter deployments
   * should pass a configured parent origin (e.g.
   * `'https://embed.example.com'`) so the ping is only delivered to
   * the expected host.
   *
   * Per spec, `'*'` is the wildcard; any other value is a literal
   * origin match. The browser drops the message if the parent's
   * actual origin doesn't match.
   */
  readonly readyTargetOrigin?: string;
  /**
   * Allow-list of origins that may issue inbound commands. When non-
   * empty, messages from any origin not in this list are dropped
   * BEFORE shape validation. Empty / undefined preserves the legacy
   * "shape-validation only" behaviour for backward compat with
   * existing embeds that don't configure an origin.
   */
  readonly allowedOrigins?: readonly string[];
}

/**
 * Read the embed-bridge configuration off the page URL. Two
 * URL-parameter conventions are supported:
 *
 *   - `?embedParent=https://embed.example.com` — sets BOTH the
 *     outbound ready target AND the inbound allow-list to the
 *     single host. Convenient for the common case.
 *   - `?embedOrigins=https://a.example.com,https://b.example.com` —
 *     comma-separated allow-list for the inbound side only.
 *
 * Returns `{}` when no params are present.
 */
export function embedBridgeOptionsFromUrl(search: string): EmbedBridgeOptions {
  let readyTargetOrigin: string | undefined;
  let allowedOrigins: string[] | undefined;
  try {
    const params = new URLSearchParams(search);
    const parent = params.get('embedParent');
    if (parent) {
      readyTargetOrigin = parent;
      allowedOrigins = [parent];
    }
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
  const opts: EmbedBridgeOptions = {};
  if (readyTargetOrigin) (opts as { readyTargetOrigin?: string }).readyTargetOrigin = readyTargetOrigin;
  if (allowedOrigins) (opts as { allowedOrigins?: string[] }).allowedOrigins = allowedOrigins;
  return opts;
}

/**
 * Start the embed bridge: announce readiness to the embedding parent and
 * listen for the four documented commands. Returns a disposer that removes the
 * listener.
 *
 * `options.readyTargetOrigin` controls the outbound `ready` ping's
 * target — `'*'` (default) sends to any parent; a literal origin
 * only delivers when the parent's origin matches.
 *
 * `options.allowedOrigins` (when non-empty) gates inbound commands:
 * messages from any origin not in the list are dropped before shape
 * validation. Empty / undefined preserves backward compatibility for
 * existing embeds.
 */
export function startEmbedBridge(
  handlers: EmbedBridgeHandlers,
  options: EmbedBridgeOptions = {},
): () => void {
  const readyTarget = options.readyTargetOrigin ?? '*';
  const allow = options.allowedOrigins;

  // Announce readiness to the embedding parent, if there is one.
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      { source: SOURCE, type: 'ready', version: __APP_VERSION__ },
      readyTarget,
    );
  }

  const onMessage = (event: MessageEvent): void => {
    if (allow && allow.length > 0 && !allow.includes(event.origin)) return;
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
