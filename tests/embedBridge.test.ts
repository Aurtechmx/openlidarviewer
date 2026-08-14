import { afterEach, describe, expect, it, test, vi } from 'vitest';
import {
  interpretEmbedMessage,
  startEmbedBridge,
  MAX_EMBED_FILE_BYTES,
  type EmbedBridgeHandlers,
} from '../src/ui/embedBridge';

/**
 * A real (tiny) ArrayBuffer whose reported `byteLength` is shadowed to `size`.
 * Lets a test assert the byte cap without allocating gigabytes — an own data
 * property shadows the ArrayBuffer.prototype.byteLength accessor on read.
 */
function bufferOfSize(size: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  Object.defineProperty(buf, 'byteLength', { value: size, configurable: true });
  return buf;
}

test('a valid jump-camera message is interpreted', () => {
  const cmd = interpretEmbedMessage({
    type: 'jump-camera',
    camera: { position: [1, 2, 3], target: [0, 0, 0], mode: 'orbit', fov: 60 },
  });
  expect(cmd).toEqual({
    kind: 'jump-camera',
    camera: { position: [1, 2, 3], target: [0, 0, 0], mode: 'orbit', fov: 60 },
  });
});

test('a jump-camera with optional mode/fov omitted still parses', () => {
  const cmd = interpretEmbedMessage({
    type: 'jump-camera',
    camera: { position: [1, 1, 1], target: [2, 2, 2] },
  });
  expect(cmd).toEqual({
    kind: 'jump-camera',
    camera: { position: [1, 1, 1], target: [2, 2, 2] },
  });
});

test('a jump-camera missing its target is rejected', () => {
  expect(interpretEmbedMessage({ type: 'jump-camera', camera: { position: [1, 2, 3] } }))
    .toBeNull();
});

test('a camera with a non-finite component is rejected', () => {
  expect(
    interpretEmbedMessage({
      type: 'jump-camera',
      camera: { position: [1, NaN, 3], target: [0, 0, 0] },
    }),
  ).toBeNull();
});

test('toggle-layer requires a string id and a boolean visible', () => {
  expect(interpretEmbedMessage({ type: 'toggle-layer', id: 'cloud_0', visible: false }))
    .toEqual({ kind: 'toggle-layer', id: 'cloud_0', visible: false });
  expect(interpretEmbedMessage({ type: 'toggle-layer', id: 'cloud_0', visible: 'no' }))
    .toBeNull();
});

test('focus-annotation requires a string id', () => {
  expect(interpretEmbedMessage({ type: 'focus-annotation', id: 'a1' }))
    .toEqual({ kind: 'focus-annotation', id: 'a1' });
  expect(interpretEmbedMessage({ type: 'focus-annotation', id: 42 })).toBeNull();
});

test('load-file requires an ArrayBuffer and a name', () => {
  const buffer = new ArrayBuffer(8);
  expect(interpretEmbedMessage({ type: 'load-file', buffer, name: 'a.las' }))
    .toEqual({ kind: 'load-file', buffer, name: 'a.las' });
  expect(interpretEmbedMessage({ type: 'load-file', buffer: 'not-a-buffer', name: 'a.las' }))
    .toBeNull();
});

test('load-file rejects a buffer over the byte cap', () => {
  const buffer = bufferOfSize(MAX_EMBED_FILE_BYTES + 1);
  expect(interpretEmbedMessage({ type: 'load-file', buffer, name: 'a.las' })).toBeNull();
});

test('load-file accepts a buffer exactly at the byte cap', () => {
  const buffer = bufferOfSize(MAX_EMBED_FILE_BYTES);
  expect(interpretEmbedMessage({ type: 'load-file', buffer, name: 'a.las' }))
    .toEqual({ kind: 'load-file', buffer, name: 'a.las' });
});

test('unrecognised, malformed, and non-object messages are rejected', () => {
  expect(interpretEmbedMessage({ type: 'delete-everything' })).toBeNull();
  expect(interpretEmbedMessage({ type: 'jump-camera' })).toBeNull();
  expect(interpretEmbedMessage(null)).toBeNull();
  expect(interpretEmbedMessage('jump-camera')).toBeNull();
  expect(interpretEmbedMessage(undefined)).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// startEmbedBridge — the browser glue's source gate. These exercise the source
// check itself (previously only the pure interpreter was tested), and pin the
// difference between a real embedding parent and an opener at top level.
// ─────────────────────────────────────────────────────────────────────────────

function makeHandlers() {
  const calls = {
    onLoadFile: vi.fn(),
    onJumpCamera: vi.fn(),
    onToggleLayer: vi.fn(),
    onFocusAnnotation: vi.fn(),
  };
  return { handlers: calls as unknown as EmbedBridgeHandlers, calls };
}

/**
 * Install a fake `window` for one startEmbedBridge run and capture its 'message'
 * listener. `topLevel: true` makes `window.parent === window` (a page opened
 * directly — the situation an opener/popup exploits); `topLevel: false` gives a
 * DISTINCT parent object (a genuine iframe embed).
 */
function withWindow(topLevel: boolean) {
  let listener: ((e: MessageEvent) => void) | null = null;
  const win: Record<string, unknown> = {
    addEventListener: (type: string, cb: (e: MessageEvent) => void) => {
      if (type === 'message') listener = cb;
    },
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
  };
  const parent = topLevel ? win : { postMessage: vi.fn() };
  win.parent = parent;
  (globalThis as { window?: unknown }).window = win;
  return {
    parent,
    dispatch: (e: { source: unknown; origin: string; data: unknown }) =>
      listener?.(e as unknown as MessageEvent),
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('startEmbedBridge — only the true embedding parent may drive the viewer', () => {
  it('DROPS a message from an opener at top level (window.parent === window)', () => {
    // A page opened directly (window.parent === window). An opener that did
    // `window.open('…?embed=1')` then postMessage is NOT the parent — the old
    // guard skipped its source check here and processed the command anyway.
    const { handlers, calls } = makeHandlers();
    const env = withWindow(true);
    const dispose = startEmbedBridge(handlers);
    env.dispatch({
      source: { id: 'opener-window' },
      origin: 'https://attacker.example',
      data: { type: 'toggle-layer', id: 'cloud_0', visible: false },
    });
    expect(calls.onToggleLayer).not.toHaveBeenCalled();
    dispose();
  });

  it('ACCEPTS a command from the genuine embedding parent (iframe case unaffected)', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers);
    env.dispatch({
      source: env.parent,
      origin: 'https://host.example',
      data: { type: 'toggle-layer', id: 'cloud_0', visible: true },
    });
    expect(calls.onToggleLayer).toHaveBeenCalledWith('cloud_0', true);
    dispose();
  });

  it('DROPS a top-level self/opener message even when it is well-formed', () => {
    // Defence in depth: at top level the only accepted source is the window
    // itself; a foreign source with a perfectly valid jump-camera is still gone.
    const { handlers, calls } = makeHandlers();
    const env = withWindow(true);
    const dispose = startEmbedBridge(handlers);
    env.dispatch({
      source: { id: 'popup' },
      origin: 'https://attacker.example',
      data: { type: 'jump-camera', camera: { position: [1, 2, 3], target: [0, 0, 0] } },
    });
    expect(calls.onJumpCamera).not.toHaveBeenCalled();
    dispose();
  });

  it('DROPS an oversized load-file even from the genuine parent (byte cap)', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers);
    env.dispatch({
      source: env.parent,
      origin: 'https://host.example',
      data: { type: 'load-file', name: 'x.las', buffer: bufferOfSize(MAX_EMBED_FILE_BYTES + 1) },
    });
    expect(calls.onLoadFile).not.toHaveBeenCalled();
    dispose();
  });

  it('accepts a within-limit load-file from a genuine parent on an ALLOW-LISTED origin', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    // load-file is privileged: it requires an explicitly trusted origin.
    const dispose = startEmbedBridge(handlers, { allowedOrigins: ['https://host.example'] });
    const buffer = new ArrayBuffer(8);
    env.dispatch({
      source: env.parent,
      origin: 'https://host.example',
      data: { type: 'load-file', name: 'x.las', buffer },
    });
    expect(calls.onLoadFile).toHaveBeenCalledWith(buffer, 'x.las');
    dispose();
  });

  it('REFUSES load-file when no origin allow-list is configured (privileged command)', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers); // no allowedOrigins
    env.dispatch({
      source: env.parent,
      origin: 'https://host.example',
      data: { type: 'load-file', name: 'x.las', buffer: new ArrayBuffer(8) },
    });
    expect(calls.onLoadFile).not.toHaveBeenCalled();
    dispose();
  });

  it('still runs the side-effect-free commands without an allow-list (back-compat)', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers); // no allowedOrigins
    env.dispatch({
      source: env.parent,
      origin: 'https://host.example',
      data: { type: 'jump-camera', camera: { position: [1, 2, 3], target: [0, 0, 0] } },
    });
    expect(calls.onJumpCamera).toHaveBeenCalled();
    dispose();
  });
});
