/**
 * capabilityProbe.ts
 *
 * Standards-only capability probe. Every field is AVAILABLE, UNAVAILABLE or
 * UNKNOWN, read from web-platform feature detection alone: no user-agent
 * sniffing, no device names. Lazily loaded (Copy diagnostics, or a later
 * calibration); nothing on the startup path imports it.
 *
 * UNKNOWN means the platform did not say (an API that reports nothing, or a
 * check that threw). It is never read as a weakness: an absent `deviceMemory`
 * says nothing about how much memory there is.
 *
 * GPU facts reuse what the app already has. WebGL 2 limits come from the
 * renderer's own context when the caller passes it; only when there is none
 * does the probe open one small offscreen context and release it at once.
 * WebGPU usability is the renderer's backend decision (renderBackendChoice),
 * passed in; the probe never requests an adapter itself.
 */

export type CapabilityState = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

export interface CapabilityField {
  readonly state: CapabilityState;
  /** A number or short token list when the field carries a value. */
  readonly value?: number | string | readonly string[];
}

export type CapabilityReport = Readonly<Record<CapabilityKey, CapabilityField>>;

export const CAPABILITY_KEYS = [
  'webgl2', 'webgl2MaxTextureSize', 'webgl2MaxRenderbufferSize', 'webgl2MaxVertexAttribs', 'webgl2Extensions',
  'webgpuPresent', 'webgpuUsable',
  'webWorkers', 'blobSlice', 'fileInput', 'indexedDB', 'opfs', 'serviceWorker', 'cacheApi',
  'wasm', 'wasmSimd', 'sharedArrayBuffer', 'crossOriginIsolated', 'offscreenCanvas', 'createImageBitmap',
  'compressionStreams', 'fullscreen', 'screenOrientation', 'pointerEvents', 'touch',
  'coarsePointer', 'noHover', 'devicePixelRatio', 'viewport', 'hardwareConcurrency', 'deviceMemory',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Extensions worth reporting for the point renderer; everything else is left out. */
export const RELEVANT_GL_EXTENSIONS = [
  'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend', 'OES_texture_float_linear',
  'EXT_texture_filter_anisotropic', 'WEBGL_multi_draw', 'EXT_disjoint_timer_query_webgl2',
  'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_astc',
  'KHR_parallel_shader_compile', 'WEBGL_lose_context',
] as const;

/** The WebGL 2 surface the probe reads. */
export interface ProbeGl {
  readonly MAX_TEXTURE_SIZE: number;
  readonly MAX_RENDERBUFFER_SIZE: number;
  readonly MAX_VERTEX_ATTRIBS: number;
  getParameter(p: number): unknown;
  getSupportedExtensions(): string[] | null;
  getExtension(name: string): unknown;
}

export interface ProbeOptions {
  /** The renderer's live WebGL 2 context, when the app has one. */
  readonly existingGl?: ProbeGl | null;
  /** The renderer's backend decision; 'webgpu' means an adapter was obtained. */
  readonly backend?: 'webgpu' | 'webgl2' | null;
  /** Global scope to read; tests pass a stub. */
  readonly scope?: unknown;
}

/** Tiny module: one function returning an i8x16.splat (v128). Validates only with SIMD. */
const WASM_SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

const ok: CapabilityField = { state: 'AVAILABLE' };
const no: CapabilityField = { state: 'UNAVAILABLE' };
const unknown: CapabilityField = { state: 'UNKNOWN' };
const flag = (b: boolean): CapabilityField => (b ? ok : no);
const valued = (value: CapabilityField['value']): CapabilityField => ({ state: 'AVAILABLE', value });

function safe(read: () => CapabilityField): CapabilityField {
  try {
    return read();
  } catch {
    return unknown;
  }
}

type Scope = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function positiveNumber(n: unknown): CapabilityField {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? valued(n) : unknown;
}

function media(g: Scope, query: string): CapabilityField {
  if (typeof g.matchMedia !== 'function') return unknown;
  return flag(g.matchMedia(query).matches === true);
}

/** A small offscreen WebGL 2 context, released as soon as it has been read. */
function withThrowawayGl(g: Scope, read: (gl: ProbeGl | null) => void): void {
  let canvas: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (typeof g.OffscreenCanvas === 'function') canvas = new g.OffscreenCanvas(1, 1);
  else if (g.document?.createElement) {
    canvas = g.document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
  }
  const gl = (canvas?.getContext?.('webgl2') ?? null) as ProbeGl | null;
  try {
    read(gl);
  } finally {
    (gl?.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.();
  }
}

function glFields(gl: ProbeGl | null, g: Scope): Pick<CapabilityReport,
  'webgl2' | 'webgl2MaxTextureSize' | 'webgl2MaxRenderbufferSize' | 'webgl2MaxVertexAttribs' | 'webgl2Extensions'> {
  if (!gl) {
    // No context: UNAVAILABLE only when the API itself is missing.
    const state: CapabilityState = typeof g.WebGL2RenderingContext === 'undefined' ? 'UNAVAILABLE' : 'UNKNOWN';
    const f: CapabilityField = { state };
    return { webgl2: f, webgl2MaxTextureSize: f, webgl2MaxRenderbufferSize: f, webgl2MaxVertexAttribs: f, webgl2Extensions: f };
  }
  const num = (p: number) => safe(() => positiveNumber(gl.getParameter(p)));
  return {
    webgl2: ok,
    webgl2MaxTextureSize: num(gl.MAX_TEXTURE_SIZE),
    webgl2MaxRenderbufferSize: num(gl.MAX_RENDERBUFFER_SIZE),
    webgl2MaxVertexAttribs: num(gl.MAX_VERTEX_ATTRIBS),
    webgl2Extensions: safe(() => {
      const list = gl.getSupportedExtensions();
      if (!list) return unknown;
      return valued(RELEVANT_GL_EXTENSIONS.filter((e) => list.includes(e)));
    }),
  };
}

function probeGl(g: Scope, existing: ProbeGl | null | undefined): ReturnType<typeof glFields> {
  if (existing) return glFields(existing, g);
  let out = glFields(null, g);
  try {
    withThrowawayGl(g, (gl) => { out = glFields(gl, g); });
  } catch {
    /* keep the no-context answer */
  }
  return out;
}

export function probeCapabilities(options: ProbeOptions = {}): CapabilityReport {
  const g = (options.scope ?? globalThis) as Scope;
  const nav: Scope = g.navigator ?? {};
  const doc: Scope | undefined = g.document;
  const gpuPresent = nav.gpu != null;
  return {
    ...probeGl(g, options.existingGl),
    webgpuPresent: flag(gpuPresent),
    webgpuUsable: !gpuPresent ? no
      : options.backend === 'webgpu' ? ok
        : options.backend === 'webgl2' ? no
          : unknown,
    webWorkers: flag(typeof g.Worker === 'function'),
    blobSlice: safe(() => flag(typeof g.Blob === 'function' && typeof g.Blob.prototype.slice === 'function')),
    fileInput: safe(() => {
      if (!doc?.createElement) return unknown;
      const input = doc.createElement('input');
      input.setAttribute('type', 'file');
      return flag(input.type === 'file' && !input.disabled);
    }),
    indexedDB: safe(() => flag(g.indexedDB != null)),
    opfs: flag(typeof nav.storage?.getDirectory === 'function'),
    serviceWorker: flag(nav.serviceWorker != null),
    cacheApi: safe(() => flag(g.caches != null)),
    wasm: flag(typeof g.WebAssembly?.validate === 'function'),
    wasmSimd: typeof g.WebAssembly?.validate !== 'function' ? no
      : safe(() => flag(g.WebAssembly.validate(WASM_SIMD_MODULE) === true)),
    sharedArrayBuffer: flag(typeof g.SharedArrayBuffer === 'function'),
    crossOriginIsolated: typeof g.crossOriginIsolated === 'boolean' ? flag(g.crossOriginIsolated) : unknown,
    offscreenCanvas: flag(typeof g.OffscreenCanvas === 'function'),
    createImageBitmap: flag(typeof g.createImageBitmap === 'function'),
    compressionStreams: flag(typeof g.CompressionStream === 'function' && typeof g.DecompressionStream === 'function'),
    fullscreen: !doc ? unknown
      : typeof doc.fullscreenEnabled === 'boolean' ? flag(doc.fullscreenEnabled)
        : flag(typeof doc.documentElement?.requestFullscreen === 'function'),
    screenOrientation: safe(() => (g.screen?.orientation?.type ? valued(String(g.screen.orientation.type)) : no)),
    pointerEvents: flag(typeof g.PointerEvent === 'function'),
    touch: typeof nav.maxTouchPoints === 'number'
      ? (nav.maxTouchPoints > 0 || 'ontouchstart' in g ? valued(nav.maxTouchPoints) : no)
      : ('ontouchstart' in g ? ok : unknown),
    coarsePointer: safe(() => media(g, '(pointer: coarse)')),
    noHover: safe(() => media(g, '(hover: none)')),
    devicePixelRatio: positiveNumber(g.devicePixelRatio),
    viewport: typeof g.innerWidth === 'number' && typeof g.innerHeight === 'number' && g.innerWidth > 0
      ? valued(`${Math.round(g.innerWidth)}x${Math.round(g.innerHeight)}`) : unknown,
    hardwareConcurrency: positiveNumber(nav.hardwareConcurrency),
    deviceMemory: positiveNumber(nav.deviceMemory),
  };
}
