/**
 * renderBackendChoice.test.ts
 *
 * The WebKit / iOS open-crash guard: `chooseRenderBackend` must route to the
 * WebGL 2 fallback whenever WebGPU cannot produce an adapter — the exact
 * condition (navigator.gpu present, requestAdapter() -> null) that makes an
 * unguarded WebGPU renderer throw "null is not an object" on WebKit while
 * working on desktop Chromium.
 */

import { describe, it, expect } from 'vitest';
import {
  chooseRenderBackend,
  type RenderAdapterProbe,
} from '../src/render/renderBackendChoice';

describe('chooseRenderBackend', () => {
  it('falls back to WebGL 2 when requestAdapter resolves null (the WebKit/iOS case)', async () => {
    const gpu: RenderAdapterProbe = { requestAdapter: async () => null };
    await expect(chooseRenderBackend(gpu)).resolves.toBe('webgl2');
  });

  it('falls back to WebGL 2 when requestAdapter resolves undefined', async () => {
    const gpu: RenderAdapterProbe = { requestAdapter: async () => undefined };
    await expect(chooseRenderBackend(gpu)).resolves.toBe('webgl2');
  });

  it('uses WebGPU when a real adapter comes back (desktop Chromium stays on WebGPU)', async () => {
    const gpu: RenderAdapterProbe = { requestAdapter: async () => ({ features: new Set() }) };
    await expect(chooseRenderBackend(gpu)).resolves.toBe('webgpu');
  });

  it('falls back to WebGL 2 when requestAdapter throws', async () => {
    const gpu: RenderAdapterProbe = {
      requestAdapter: async () => {
        throw new Error('blocked by privacy shield');
      },
    };
    await expect(chooseRenderBackend(gpu)).resolves.toBe('webgl2');
  });

  it('falls back to WebGL 2 when navigator.gpu is absent', async () => {
    await expect(chooseRenderBackend(undefined)).resolves.toBe('webgl2');
    await expect(chooseRenderBackend(null)).resolves.toBe('webgl2');
  });

  it('falls back to WebGL 2 when gpu is present but lacks requestAdapter', async () => {
    await expect(
      chooseRenderBackend({} as unknown as RenderAdapterProbe),
    ).resolves.toBe('webgl2');
  });

  it('never throws — every failure mode resolves to a usable choice', async () => {
    const rejecting: RenderAdapterProbe = { requestAdapter: () => Promise.reject(new Error('x')) };
    await expect(chooseRenderBackend(rejecting)).resolves.toBe('webgl2');
  });
});
