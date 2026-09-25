import { describe, expect, it, vi } from 'vitest';

import { CAPABILITY_KEYS, probeCapabilities, type ProbeGl } from '../src/platform/capabilityProbe';

const fakeGl = (exts: string[] | null = ['EXT_color_buffer_float', 'OES_vendor_private', 'WEBGL_lose_context']): ProbeGl & { lost: number } => {
  const gl = {
    MAX_TEXTURE_SIZE: 1, MAX_RENDERBUFFER_SIZE: 2, MAX_VERTEX_ATTRIBS: 3, lost: 0,
    getParameter: (p: number) => [0, 8192, 4096, 16][p],
    getSupportedExtensions: () => exts,
    getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: () => { gl.lost++; } } : null),
  };
  return gl;
};

/** A browser-like scope where every probed feature is present. */
function fullScope(): Record<string, unknown> {
  class Blob { slice() { return this; } }
  return {
    navigator: {
      gpu: {}, storage: { getDirectory: () => {} }, serviceWorker: {}, maxTouchPoints: 5,
      hardwareConcurrency: 8, deviceMemory: 4,
    },
    document: {
      fullscreenEnabled: true,
      createElement: (tag: string) => (tag === 'input'
        ? { type: 'text', disabled: false, setAttribute(this: { type: string }, _k: string, v: string) { this.type = v; } }
        : { getContext: () => null }),
    },
    Worker: function Worker() {}, Blob, indexedDB: {}, caches: {},
    WebAssembly: { validate: () => true }, SharedArrayBuffer: function SAB() {}, crossOriginIsolated: true,
    OffscreenCanvas: function OC() {}, createImageBitmap: () => {}, CompressionStream: function C() {},
    DecompressionStream: function D() {}, screen: { orientation: { type: 'landscape-primary' } },
    PointerEvent: function P() {}, ontouchstart: null, WebGL2RenderingContext: function G() {},
    matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' || q === '(hover: none)' }),
    devicePixelRatio: 2, innerWidth: 1280, innerHeight: 800,
  };
}

describe('probeCapabilities', () => {
  it('reports AVAILABLE for every field when the platform has it', () => {
    const r = probeCapabilities({ scope: fullScope(), existingGl: fakeGl(), backend: 'webgpu' });
    expect(Object.keys(r).sort()).toEqual([...CAPABILITY_KEYS].sort());
    for (const k of CAPABILITY_KEYS) expect([k, r[k].state]).toEqual([k, 'AVAILABLE']);
    expect(r.webgl2MaxTextureSize.value).toBe(8192);
    expect(r.webgl2MaxRenderbufferSize.value).toBe(4096);
    expect(r.webgl2MaxVertexAttribs.value).toBe(16);
    expect(r.webgl2Extensions.value).toEqual(['EXT_color_buffer_float', 'WEBGL_lose_context']);
    expect(r.viewport.value).toBe('1280x800');
    expect(r.deviceMemory.value).toBe(4);
    expect(r.screenOrientation.value).toBe('landscape-primary');
  });

  it('reads the renderer context and does not create or release one', () => {
    const gl = fakeGl();
    const OffscreenCanvas = vi.fn();
    probeCapabilities({ scope: { ...fullScope(), OffscreenCanvas }, existingGl: gl });
    expect(OffscreenCanvas).not.toHaveBeenCalled();
    expect(gl.lost).toBe(0);
  });

  it('opens one throwaway context when there is none, and releases it', () => {
    const gl = fakeGl();
    const made: unknown[] = [];
    function OffscreenCanvas(this: unknown) { made.push(this); return { getContext: () => gl }; }
    const r = probeCapabilities({ scope: { ...fullScope(), OffscreenCanvas } });
    expect(made).toHaveLength(1);
    expect(gl.lost).toBe(1);
    expect(r.webgl2.state).toBe('AVAILABLE');
  });

  it('reports UNAVAILABLE for every field when the platform lacks it', () => {
    const scope = {
      navigator: { maxTouchPoints: 0, hardwareConcurrency: 4 },
      document: { fullscreenEnabled: false, createElement: () => ({ type: 'text', disabled: false, setAttribute() {} }) },
      WebAssembly: { validate: () => false }, crossOriginIsolated: false, screen: {},
      matchMedia: () => ({ matches: false }),
    };
    const r = probeCapabilities({ scope });
    const expected = CAPABILITY_KEYS.filter((k) => !['devicePixelRatio', 'viewport', 'hardwareConcurrency', 'deviceMemory', 'wasm'].includes(k));
    for (const k of expected) expect([k, r[k].state]).toEqual([k, 'UNAVAILABLE']);
    expect(r.wasm.state).toBe('AVAILABLE');
    expect(r.wasmSimd.state).toBe('UNAVAILABLE');
    expect(probeCapabilities({ scope: {} }).wasmSimd.state).toBe('UNAVAILABLE');
  });

  it('reports WebGPU present but not usable when the renderer chose WebGL 2', () => {
    const r = probeCapabilities({ scope: fullScope(), existingGl: fakeGl(), backend: 'webgl2' });
    expect(r.webgpuPresent.state).toBe('AVAILABLE');
    expect(r.webgpuUsable.state).toBe('UNAVAILABLE');
  });

  it('reports UNKNOWN when the platform does not say, never UNAVAILABLE', () => {
    const throws = () => { throw new Error('blocked'); };
    const scope = {
      navigator: { gpu: {} },
      get indexedDB() { return throws(); },
      get caches() { return throws(); },
      WebAssembly: { validate: throws },
      Blob: new Proxy(function Blob() {}, { get: (t, k) => (k === 'prototype' ? throws() : Reflect.get(t, k)) }),
      screen: { get orientation() { return throws(); } },
      matchMedia: throws,
      WebGL2RenderingContext: function G() {},
      OffscreenCanvas: function OC() { return { getContext: () => null }; },
    };
    const r = probeCapabilities({ scope });
    for (const k of [
      'webgl2', 'webgl2MaxTextureSize', 'webgl2MaxRenderbufferSize', 'webgl2MaxVertexAttribs', 'webgl2Extensions',
      'webgpuUsable', 'blobSlice', 'fileInput', 'indexedDB', 'cacheApi', 'wasmSimd', 'crossOriginIsolated',
      'fullscreen', 'screenOrientation', 'touch', 'coarsePointer', 'noHover', 'devicePixelRatio', 'viewport',
      'hardwareConcurrency', 'deviceMemory',
    ] as const) expect([k, r[k].state]).toEqual([k, 'UNKNOWN']);
  });

  it('treats an absent deviceMemory as UNKNOWN, not weak', () => {
    const scope = fullScope();
    (scope.navigator as Record<string, unknown>).deviceMemory = undefined;
    expect(probeCapabilities({ scope, existingGl: fakeGl() }).deviceMemory).toEqual({ state: 'UNKNOWN' });
  });

  it('reports GL limits UNKNOWN when a live context returns nothing', () => {
    const gl = { ...fakeGl(null), getParameter: () => null };
    const r = probeCapabilities({ scope: fullScope(), existingGl: gl });
    expect(r.webgl2.state).toBe('AVAILABLE');
    expect(r.webgl2MaxTextureSize.state).toBe('UNKNOWN');
    expect(r.webgl2Extensions.state).toBe('UNKNOWN');
  });

  it('validates a real SIMD module in this runtime', () => {
    expect(probeCapabilities({ scope: globalThis }).wasmSimd.state).toBe('AVAILABLE');
  });
});
