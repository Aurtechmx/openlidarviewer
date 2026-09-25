/**
 * deviceNotice.test.ts
 *
 * WebGL context loss and restore reach the user: the reporter raises a DOM
 * event, starts the renderer recovery after a restore and reports its outcome,
 * records both in the error ledger, and the binder shows them on the toast.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_LOST_NOTICE, CONTEXT_RECOVERY_FAILED_NOTICE, CONTEXT_RESTORED_NOTICE, bindDeviceNotices, deviceNoticeReporter,
} from '../src/render/deviceNotice';
import { DeviceGeneration, watchDeviceChanges, type RendererWithDeviceLoss } from '../src/render/gpuErrorLedger';
import { clearErrorLedger, errorLedgerSnapshot } from '../src/app/diagnostics/errorLedger';

function toast() {
  return { setError: vi.fn() };
}

beforeEach(() => clearErrorLedger());

describe('device notices', () => {
  it('a WebGL loss then restore shows both notices and runs one recovery after the restore', async () => {
    const canvas = new EventTarget();
    const renderer: RendererWithDeviceLoss = {};
    const requestFrame = vi.fn(async () => true);
    const t = toast();
    const unbind = bindDeviceNotices(canvas, t);
    const generation = new DeviceGeneration();
    const detach = watchDeviceChanges(canvas as unknown as HTMLCanvasElement, renderer, generation, deviceNoticeReporter(canvas, requestFrame));

    renderer.onDeviceLost?.({ api: 'WebGL', message: 'lost' });
    expect(t.setError).toHaveBeenCalledWith(CONTEXT_LOST_NOTICE);
    expect(requestFrame).not.toHaveBeenCalled();

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(t.setError).toHaveBeenLastCalledWith(CONTEXT_RESTORED_NOTICE);
    unbind();
    renderer.onDeviceLost?.({ api: 'WebGL', message: 'lost again' });
    expect(t.setError).toHaveBeenCalledTimes(2);

    expect(errorLedgerSnapshot().map((e) => e.code)).toEqual(['webgl-context-lost', 'webgl-context-restored', 'webgl-context-lost']);
    detach();
  });

  it('leaves a WebGPU device loss to the GPU error path', () => {
    const canvas = new EventTarget();
    const t = toast();
    bindDeviceNotices(canvas, t);
    const requestFrame = vi.fn(async () => true);
    deviceNoticeReporter(canvas, requestFrame)('webgpu-device-lost');
    expect(t.setError).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('a failed or rejected recovery keeps the reload notice', async () => {
    for (const recover of [async () => false, async () => { throw new Error('init'); }]) {
      const target = new EventTarget();
      const t = toast();
      bindDeviceNotices(target, t);
      deviceNoticeReporter(target, recover)('webgl-context-restored');
      await new Promise((r) => setTimeout(r, 0));
      expect(t.setError).toHaveBeenCalledWith(CONTEXT_RECOVERY_FAILED_NOTICE);
    }
  });

  it('the loss notice says the project is unchanged; only a failed restore asks for a reload', () => {
    expect(CONTEXT_LOST_NOTICE).toContain('Your project is unchanged');
    expect(CONTEXT_RESTORED_NOTICE).toBe('Graphics context restored; the view has been redrawn.');
    expect(CONTEXT_RECOVERY_FAILED_NOTICE).toContain('reload the page');
  });

  it('ignores a backend replacement', () => {
    const target = new EventTarget();
    const t = toast();
    bindDeviceNotices(target, t);
    deviceNoticeReporter(target, async () => true)('backend-replaced');
    expect(t.setError).not.toHaveBeenCalled();
  });
});
