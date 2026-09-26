/**
 * renderCoreDisposal.test.ts
 *
 * The render core's dispose seam releases the pipeline, the scene pass and
 * the renderer once, and the Viewer's dispose goes through it. Context
 * recovery releases the previous core by retiring its renderer, since a
 * dispose would lose the context just restored.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type * as THREE from 'three/webgpu';
import { disposeViewerRenderCore } from '../src/render/viewerRenderBootstrap';
import { recoverRenderCore, type ContextRecoveryHost } from '../src/render/contextRecovery';

function fakeCore(order: string[] = []) {
  return {
    renderer: { dispose: vi.fn(() => order.push('renderer')) },
    pipeline: { dispose: vi.fn(() => order.push('pipeline')) },
    scenePass: { dispose: vi.fn(() => order.push('scenePass')) },
  };
}

describe('disposeViewerRenderCore', () => {
  it('releases pipeline, scene pass and renderer in that order', () => {
    const order: string[] = [];
    disposeViewerRenderCore(fakeCore(order) as never);
    expect(order).toEqual(['pipeline', 'scenePass', 'renderer']);
  });

  it('is idempotent', () => {
    const core = fakeCore();
    disposeViewerRenderCore(core as never);
    disposeViewerRenderCore(core as never);
    for (const part of [core.renderer, core.pipeline, core.scenePass]) expect(part.dispose).toHaveBeenCalledTimes(1);
  });

  it('Viewer.dispose releases its core through the seam', () => {
    const src = readFileSync(new URL('../src/render/Viewer.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('  dispose(): void {'));
    expect(body.slice(0, body.indexOf('\n  }\n'))).toContain('disposeViewerRenderCore({ renderer: this._renderer, pipeline: this._post, scenePass: this._scenePass })');
  });
});

describe('context recovery releases the previous core', () => {
  it('retires the old renderer before adopting the new core', async () => {
    const order: string[] = [];
    const animation = { dispose: vi.fn(() => order.push('retire')) };
    const old = { _animation: animation, dispose: vi.fn(), getPixelRatio: () => 1, getSize: (v: { set(x: number, y: number): void }) => v.set(1, 1),
      getClearColor: (c: { copy(x: unknown): unknown }) => c.copy({ clone: () => ({}) }), getClearAlpha: () => 1 };
    const next = { init: vi.fn(async () => {}), setPixelRatio() {}, setSize() {}, setClearColor() {} };
    const h: ContextRecoveryHost = {
      renderer: old as unknown as THREE.WebGPURenderer,
      pipeline: { outputNode: {} } as unknown as THREE.RenderPipeline,
      generation: { current: 1, lost: false } as never,
      create: () => ({ renderer: next as unknown as THREE.WebGPURenderer, pipeline: {} as THREE.RenderPipeline }),
      disposed: () => false,
      adopt: () => { order.push('adopt'); },
    };
    await expect(recoverRenderCore(h)).resolves.toBe(true);
    expect(order).toEqual(['retire', 'adopt']);
    expect(old.dispose).not.toHaveBeenCalled();
  });
});
