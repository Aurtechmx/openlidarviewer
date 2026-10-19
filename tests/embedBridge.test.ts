import { afterEach, describe, expect, it, test, vi } from 'vitest';
import {
  embedBridgeOptionsFromUrl,
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

/** How a fake window is framed. */
interface FrameShape {
  /** `location.ancestorOrigins`, immediate parent first (Chromium, WebKit). */
  ancestorOrigins?: string[];
  /** The origin readable off `parent.location` (a same-origin parent). Absent: a cross-origin parent whose location throws. */
  parentLocationOrigin?: string;
}

/**
 * Install a fake `window` for one startEmbedBridge run and capture its 'message'
 * listener. `topLevel: true` makes `window.parent === window` (a page opened
 * directly — the situation an opener/popup exploits); `topLevel: false` gives a
 * DISTINCT parent object (a genuine iframe embed), cross-origin unless `shape`
 * says otherwise.
 */
function withWindow(topLevel: boolean, shape: FrameShape = {}) {
  let listener: ((e: MessageEvent) => void) | null = null;
  const win: Record<string, unknown> = {
    addEventListener: (type: string, cb: (e: MessageEvent) => void) => {
      if (type === 'message') listener = cb;
    },
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
    location: { origin: 'https://viewer.example', ancestorOrigins: shape.ancestorOrigins },
  };
  const parent: Record<string, unknown> = topLevel ? win : { postMessage: vi.fn() };
  if (!topLevel) {
    Object.defineProperty(parent, 'location', {
      get: () => {
        if (shape.parentLocationOrigin === undefined) throw new Error('SecurityError: cross-origin');
        return { origin: shape.parentLocationOrigin };
      },
    });
  }
  win.parent = parent;
  win.top = topLevel ? win : parent;
  (globalThis as { window?: unknown }).window = win;
  return {
    parent,
    win,
    dispatch: (e: { source: unknown; origin: string; data: unknown }) =>
      listener?.(e as unknown as MessageEvent),
    listening: () => listener !== null,
  };
}

const HOST = { deployerOrigins: ['https://host.example'], allowedOrigins: ['https://host.example'] };

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
    const dispose = startEmbedBridge(handlers, HOST);
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
    const dispose = startEmbedBridge(handlers, HOST);
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
    const dispose = startEmbedBridge(handlers, HOST);
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

  it.each([
    ['jump-camera', { type: 'jump-camera', camera: { position: [1, 2, 3], target: [0, 0, 0] } }, 'onJumpCamera'],
    ['toggle-layer', { type: 'toggle-layer', id: 'cloud_0', visible: false }, 'onToggleLayer'],
    ['focus-annotation', { type: 'focus-annotation', id: 'a1' }, 'onFocusAnnotation'],
  ] as const)('REFUSES %s when no origin allow-list is configured', (_label, data, handler) => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers); // no allowedOrigins
    env.dispatch({ source: env.parent, origin: 'https://host.example', data });
    expect(calls[handler]).not.toHaveBeenCalled();
    dispose();
  });

  it('accepts the page\'s own origin with no allow-list, and refuses others', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false, { parentLocationOrigin: 'https://viewer.example' });
    const dispose = startEmbedBridge(handlers);
    env.dispatch({ source: env.parent, origin: 'https://viewer.example', data: { type: 'focus-annotation', id: 'a1' } });
    env.dispatch({ source: env.parent, origin: 'https://host.example', data: { type: 'focus-annotation', id: 'a2' } });
    expect(calls.onFocusAnnotation).toHaveBeenCalledTimes(1);
    expect(calls.onFocusAnnotation).toHaveBeenCalledWith('a1');
    expect((env.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage.mock.calls.map((c) => c[1])).toEqual(['https://viewer.example']);
    dispose();
  });

  it('sends no ready message to a foreign origin when none is configured', () => {
    const { handlers } = makeHandlers();
    const env = withWindow(false, { parentLocationOrigin: 'https://viewer.example' });
    const dispose = startEmbedBridge(handlers);
    const post = (env.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage;
    expect(post.mock.calls.map((c) => c[1])).toEqual(['https://viewer.example']);
    dispose();
  });

  it('sends ready only to each configured origin', () => {
    const { handlers } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers, { deployerOrigins: ['https://a.example', 'https://b.example'], allowedOrigins: ['https://a.example', 'https://b.example'] });
    const post = (env.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage;
    expect(post.mock.calls.map((c) => c[1])).toEqual(['https://viewer.example', 'https://a.example', 'https://b.example']);
    dispose();
  });

  // Once an embedder configures allowedOrigins, the list gates EVERY command
  // (not just load-file): a genuine-parent state command runs only from a listed
  // origin, and an unlisted or null/opaque origin is dropped before it runs.
  // Table-driven so the one dispatch+assert shape is written once.
  it.each([
    ['a listed origin', 'https://host.example', true],
    ['an unlisted origin', 'https://attacker.example', false],
    ['a null/opaque origin', 'null', false],
  ] as const)('with an allow-list set, a state command from %s runs=%s', (_label, origin, shouldRun) => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers, HOST);
    env.dispatch({ source: env.parent, origin, data: { type: 'toggle-layer', id: 'cloud_0', visible: true } });
    if (shouldRun) expect(calls.onToggleLayer).toHaveBeenCalledWith('cloud_0', true);
    else expect(calls.onToggleLayer).not.toHaveBeenCalled();
    dispose();
  });
});

describe('embedBridgeOptionsFromUrl', () => {
  it('normalises each entry to its origin', () => {
    expect(embedBridgeOptionsFromUrl('?embedOrigins=https://a.example/path/, https://B.example:443')).toEqual({
      allowedOrigins: ['https://a.example', 'https://b.example'],
    });
    expect(embedBridgeOptionsFromUrl('?embedParent=https://host.example/page?x=1')).toEqual({
      allowedOrigins: ['https://host.example'],
    });
  });

  it('drops *, null, non-http and malformed entries without throwing', () => {
    expect(embedBridgeOptionsFromUrl('?embedOrigins=*,null,javascript:alert(1),not a url,https://ok.example')).toEqual({
      allowedOrigins: ['https://ok.example'],
    });
    expect(embedBridgeOptionsFromUrl('?embedParent=*')).toEqual({});
    expect(embedBridgeOptionsFromUrl('')).toEqual({});
  });
});

describe('startEmbedBridge — the viewer URL cannot authorise the page that framed it', () => {
  const ATTACKER = 'https://attacker.example';
  const load = { type: 'load-file', name: 'x.las', buffer: new ArrayBuffer(8) };

  it('ignores ?embedParent naming the framing origin when the deployer allows none (no ready, no listener)', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false, { ancestorOrigins: [ATTACKER] });
    const dispose = startEmbedBridge(handlers, { allowedOrigins: [ATTACKER], deployerOrigins: [] });
    expect(env.listening()).toBe(false);
    expect((env.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage).not.toHaveBeenCalled();
    env.dispatch({ source: env.parent, origin: ATTACKER, data: load });
    expect(calls.onLoadFile).not.toHaveBeenCalled();
    dispose();
  });

  it('does the same where the browser gives no ancestorOrigins (cross-origin parent, empty list)', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers, { allowedOrigins: [ATTACKER] });
    expect(env.listening()).toBe(false);
    expect((env.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage).not.toHaveBeenCalled();
    env.dispatch({ source: env.parent, origin: ATTACKER, data: load });
    expect(calls.onLoadFile).not.toHaveBeenCalled();
    dispose();
  });

  it('drops a requested origin the deployer did not list, and accepts the one it did', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers, {
      allowedOrigins: [ATTACKER, 'https://host.example'],
      deployerOrigins: ['https://host.example'],
    });
    env.dispatch({ source: env.parent, origin: ATTACKER, data: { type: 'focus-annotation', id: 'bad' } });
    env.dispatch({ source: env.parent, origin: 'https://host.example', data: { type: 'focus-annotation', id: 'good' } });
    expect(calls.onFocusAnnotation).toHaveBeenCalledTimes(1);
    expect(calls.onFocusAnnotation).toHaveBeenCalledWith('good');
    const post = (env.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage;
    expect(post.mock.calls.map((c) => c[1])).not.toContain(ATTACKER);
    dispose();
  });

  it('with the deployer list set and no request in the URL, serves the listed origins', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false);
    const dispose = startEmbedBridge(handlers, { deployerOrigins: ['https://host.example'] });
    env.dispatch({ source: env.parent, origin: 'https://host.example', data: { type: 'focus-annotation', id: 'a' } });
    expect(calls.onFocusAnnotation).toHaveBeenCalledWith('a');
    dispose();
  });

  it('where ancestorOrigins names a listed parent, talks to that origin alone', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false, { ancestorOrigins: ['https://host.example'] });
    const dispose = startEmbedBridge(handlers, { deployerOrigins: ['https://host.example', 'https://other.example'] });
    const post = (env.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage;
    expect(post.mock.calls.map((c) => c[1])).toEqual(['https://host.example']);
    env.dispatch({ source: env.parent, origin: 'https://other.example', data: { type: 'focus-annotation', id: 'x' } });
    expect(calls.onFocusAnnotation).not.toHaveBeenCalled();
    dispose();
  });

  it('where ancestorOrigins names an unlisted parent, stays silent even though the deployer lists others', () => {
    const { handlers } = makeHandlers();
    const env = withWindow(false, { ancestorOrigins: [ATTACKER] });
    const dispose = startEmbedBridge(handlers, { deployerOrigins: ['https://host.example'], allowedOrigins: [ATTACKER] });
    expect(env.listening()).toBe(false);
    expect((env.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage).not.toHaveBeenCalled();
    dispose();
  });

  it('a same-origin parent is always served, with no deployer list', () => {
    const { handlers, calls } = makeHandlers();
    const env = withWindow(false, { parentLocationOrigin: 'https://viewer.example', ancestorOrigins: ['https://viewer.example'] });
    const dispose = startEmbedBridge(handlers);
    expect(env.listening()).toBe(true);
    env.dispatch({ source: env.parent, origin: 'https://viewer.example', data: load });
    expect(calls.onLoadFile).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe('interpretEmbedMessage — load-file limits', () => {
  it('caps a file at 256 MiB', () => {
    expect(MAX_EMBED_FILE_BYTES).toBe(256 * 1024 * 1024);
  });

  it.each([
    ['a typed-array view', new Uint8Array(8)],
    ['a SharedArrayBuffer', typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(8) : 'skip'],
    ['a string', 'AAAA'],
  ])('rejects %s as the buffer', (_label, buffer) => {
    expect(interpretEmbedMessage({ type: 'load-file', buffer, name: 'a.las' })).toBeNull();
  });

  it('rejects an empty or over-long file name', () => {
    const buffer = new ArrayBuffer(8);
    expect(interpretEmbedMessage({ type: 'load-file', buffer, name: '' })).toBeNull();
    expect(interpretEmbedMessage({ type: 'load-file', buffer, name: 'a'.repeat(256) })).toBeNull();
    expect(interpretEmbedMessage({ type: 'load-file', buffer, name: 'a'.repeat(255) })).not.toBeNull();
  });
});
