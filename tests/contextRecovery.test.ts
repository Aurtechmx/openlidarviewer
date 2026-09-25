/**
 * contextRecovery.test.ts
 *
 * The sequencing of the rebuild after a WebGL context restore: a fresh core is
 * built and initialised, it inherits the drawing-buffer state and the EDL
 * output node, the lost renderer is retired (never disposed, which would lose
 * the restored context), and a recovery overtaken by another loss or by the
 * owner's disposal keeps the old state.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';

import { carryRendererState, recoverRenderCore, retireRenderer, type ContextRecoveryHost } from '../src/render/contextRecovery';
import { DeviceGeneration } from '../src/render/deviceGeneration';

function fakeRenderer(init: () => Promise<unknown> = async () => {}) {
  const canvas = new EventTarget();
  const onLost = vi.fn();
  canvas.addEventListener('webglcontextlost', onLost);
  const roDispose = vi.fn();
  const ro = { onDispose: roDispose as () => void };
  const r = {
    ratio: 1, w: 0, h: 0, clear: new THREE.Color(0), alpha: 1, localClippingEnabled: false,
    init: vi.fn(init),
    dispose: vi.fn(),
    getPixelRatio() { return this.ratio; },
    setPixelRatio(v: number) { this.ratio = v; },
    getSize(t: THREE.Vector2) { return t.set(this.w, this.h); },
    setSize(w: number, h: number) { this.w = w; this.h = h; },
    getClearColor(t: THREE.Color) { return t.copy(this.clear); },
    getClearAlpha() { return this.alpha; },
    setClearColor(c: THREE.Color, a: number) { this.clear.copy(c); this.alpha = a; },
    domElement: canvas,
    backend: { _onContextLost: onLost },
    _animation: { dispose: vi.fn() },
    _objects: { _renderObjects: new Set([ro]), dispose: vi.fn(function (this: { _renderObjects: Set<typeof ro> }) { for (const o of this._renderObjects) o.onDispose(); }) },
    _geometries: { dispose: vi.fn() },
  };
  return { r, canvas, onLost, roDispose, asRenderer: r as unknown as THREE.WebGPURenderer };
}

function host(overrides: Partial<ContextRecoveryHost> = {}) {
  const old = fakeRenderer();
  old.r.ratio = 1.5; old.r.w = 800; old.r.h = 600; old.r.clear.set(0x123456); old.r.localClippingEnabled = true;
  const next = fakeRenderer();
  const outputNode = { edl: true };
  const pipeline = { outputNode } as unknown as THREE.RenderPipeline;
  const nextPipeline = { outputNode: { throwaway: true } } as unknown as THREE.RenderPipeline;
  const scenePass = { dispose: vi.fn() };
  const generation = new DeviceGeneration();
  generation.note('webgl-context-lost');
  generation.note('webgl-context-restored');
  const adopt = vi.fn();
  const h: ContextRecoveryHost = {
    renderer: old.asRenderer, pipeline, generation,
    create: vi.fn(() => ({ renderer: next.asRenderer, pipeline: nextPipeline, scenePass })),
    disposed: () => false,
    adopt,
    ...overrides,
  };
  return { h, old, next, outputNode, nextPipeline, scenePass, generation, adopt };
}

describe('context recovery', () => {
  it('builds, initialises and adopts a fresh core carrying the old state and EDL node', async () => {
    const { h, old, next, outputNode, nextPipeline, scenePass, adopt } = host();
    await expect(recoverRenderCore(h)).resolves.toBe(true);
    expect(next.r.init).toHaveBeenCalledTimes(1);
    expect(nextPipeline.outputNode).toBe(outputNode);
    expect(scenePass.dispose).toHaveBeenCalled();
    expect([next.r.ratio, next.r.w, next.r.h, next.r.clear.getHex(), next.r.localClippingEnabled]).toEqual([1.5, 800, 600, 0x123456, true]);
    expect(adopt).toHaveBeenCalledWith({ renderer: next.asRenderer, pipeline: nextPipeline });
    // The lost renderer is retired, not disposed.
    expect(old.r.dispose).not.toHaveBeenCalled();
    expect(old.r._animation.dispose).toHaveBeenCalled();
    expect(old.r._geometries.dispose).toHaveBeenCalled();
    expect(old.roDispose).not.toHaveBeenCalled();
    old.canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(old.onLost).not.toHaveBeenCalled();
    // The new renderer keeps its listener.
    next.canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(next.onLost).toHaveBeenCalledTimes(1);
  });

  it('adopts only after init resolves', async () => {
    let release: () => void = () => {};
    const next = fakeRenderer(() => new Promise<void>((r) => { release = r; }));
    const { h, adopt } = host({ create: () => ({ renderer: next.asRenderer, pipeline: {} as THREE.RenderPipeline }) });
    const done = recoverRenderCore(h);
    await Promise.resolve();
    expect(adopt).not.toHaveBeenCalled();
    release();
    await expect(done).resolves.toBe(true);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it('a loss during init abandons the new core and keeps the old one', async () => {
    let gen: DeviceGeneration | null = null;
    const next = fakeRenderer(async () => { gen?.note('webgl-context-lost'); });
    const { h, old, adopt, generation } = host({ create: () => ({ renderer: next.asRenderer, pipeline: {} as THREE.RenderPipeline }) });
    gen = generation;
    await expect(recoverRenderCore(h)).resolves.toBe(false);
    expect(adopt).not.toHaveBeenCalled();
    expect(next.r._animation.dispose).toHaveBeenCalled();
    expect(next.r.dispose).not.toHaveBeenCalled();
    expect(old.r._animation.dispose).not.toHaveBeenCalled();
  });

  it('a disposed owner adopts nothing', async () => {
    const { h, adopt, next } = host({ disposed: () => true });
    await expect(recoverRenderCore(h)).resolves.toBe(false);
    expect(adopt).not.toHaveBeenCalled();
    expect(next.r._animation.dispose).toHaveBeenCalled();
  });

  it('a failing init reports failure without adopting', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const next = fakeRenderer(async () => { throw new Error('no context'); });
    const { h, adopt } = host({ create: () => ({ renderer: next.asRenderer, pipeline: {} as THREE.RenderPipeline }) });
    await expect(recoverRenderCore(h)).resolves.toBe(false);
    expect(adopt).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('retiring tolerates a renderer without the private fields', () => {
    expect(() => retireRenderer({} as THREE.WebGPURenderer)).not.toThrow();
    const a = fakeRenderer(); const b = fakeRenderer();
    a.r.localClippingEnabled = false; b.r.localClippingEnabled = true;
    carryRendererState(a.asRenderer, b.asRenderer);
    expect(b.r.localClippingEnabled).toBe(false);
  });
});
