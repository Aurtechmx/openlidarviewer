/**
 * deviceNotice.test.ts
 *
 * WebGL context loss and restore reach the user: the reporter raises a DOM
 * event, asks for a frame after a restore, records both in the error ledger, and
 * the binder shows them on the toast.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_LOST_NOTICE, CONTEXT_RESTORED_NOTICE, bindDeviceNotices, deviceNoticeReporter,
} from '../src/render/deviceNotice';
import { DeviceGeneration, watchDeviceChanges, type RendererWithDeviceLoss } from '../src/render/gpuErrorLedger';
import { clearErrorLedger, errorLedgerSnapshot } from '../src/app/diagnostics/errorLedger';

function toast() {
  return { setError: vi.fn() };
}

beforeEach(() => clearErrorLedger());

describe('device notices', () => {
  it('a WebGL loss then restore shows both notices and requests one frame after the restore', () => {
    const canvas = new EventTarget();
    const renderer: RendererWithDeviceLoss = {};
    const requestFrame = vi.fn();
    const t = toast();
    const unbind = bindDeviceNotices(canvas, t);
    const generation = new DeviceGeneration();
    const detach = watchDeviceChanges(canvas as unknown as HTMLCanvasElement, renderer, generation, deviceNoticeReporter(canvas, requestFrame));

    renderer.onDeviceLost?.({ api: 'WebGL', message: 'lost' });
    expect(t.setError).toHaveBeenCalledWith(CONTEXT_LOST_NOTICE);
    expect(requestFrame).not.toHaveBeenCalled();

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(requestFrame).toHaveBeenCalledTimes(1);
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
    const requestFrame = vi.fn();
    deviceNoticeReporter(canvas, requestFrame)('webgpu-device-lost');
    expect(t.setError).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('both notices say the project is unchanged, and the restore one does not promise a redraw', () => {
    expect(CONTEXT_LOST_NOTICE).toBe('Graphics context lost. Your project is unchanged. Save the session, then reload the page to see the scan again.');
    expect(CONTEXT_RESTORED_NOTICE).toContain('Your project is unchanged');
    expect(CONTEXT_RESTORED_NOTICE).toContain('reload the page');
  });

  it('ignores a backend replacement', () => {
    const target = new EventTarget();
    const t = toast();
    bindDeviceNotices(target, t);
    deviceNoticeReporter(target, () => {})('backend-replaced');
    expect(t.setError).not.toHaveBeenCalled();
  });
});
