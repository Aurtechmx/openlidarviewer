/**
 * gpuErrorLedger.test.ts
 *
 * Pins the pure GPU-error bookkeeping and device-wiring extracted from `Viewer`
 * for v0.5.7 Gate 10: the de-dup / cap / reset ledger, the device-lost
 * suppression rule, and the `uncapturederror` + `device.lost` wiring driven by a
 * fake device (so the whole path is covered without a real GPU). `Viewer` cannot
 * be instantiated under vitest — it builds a real WebGPURenderer — so this is the
 * unit coverage for behaviour that used to be trapped inside it.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GpuErrorLedger,
  GPU_ERROR_CAP,
  wireGpuDeviceErrors,
  formatUncapturedError,
  formatDeviceLost,
  type GpuDeviceLike,
} from '../src/render/gpuErrorLedger';

describe('GpuErrorLedger — dedup, cap, reset', () => {
  it('admits a distinct message once and rejects the duplicate', () => {
    const led = new GpuErrorLedger();
    expect(led.admit('GPUValidationError: bad pipeline')).toBe(true);
    expect(led.admit('GPUValidationError: bad pipeline')).toBe(false);
    expect(led.admit('GPUValidationError: bad pipeline')).toBe(false);
    expect(led.size).toBe(1);
  });

  it('admits several distinct messages, each once', () => {
    const led = new GpuErrorLedger();
    expect(led.admit('a')).toBe(true);
    expect(led.admit('b')).toBe(true);
    expect(led.admit('a')).toBe(false);
    expect(led.size).toBe(2);
  });

  it('bounds the remembered set at the cap, then clears and re-admits', () => {
    const led = new GpuErrorLedger({ cap: 3 });
    expect(led.admit('m0')).toBe(true);
    expect(led.admit('m1')).toBe(true);
    expect(led.admit('m2')).toBe(true);
    expect(led.size).toBe(3);
    // m0 is still remembered until the cap forces a clear.
    expect(led.admit('m0')).toBe(false);
    // The 4th distinct message hits the cap: the set clears, then admits it.
    expect(led.admit('m3')).toBe(true);
    expect(led.size).toBe(1);
    // After the clear an earlier message is admissible again (harmless re-report).
    expect(led.admit('m0')).toBe(true);
  });

  it('falls back to the default cap for a non-positive or non-finite cap', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const led = new GpuErrorLedger({ cap: bad });
      // Admitting the default cap of distinct messages must not trip a clear.
      for (let i = 0; i < GPU_ERROR_CAP; i++) expect(led.admit(`x${i}`)).toBe(true);
      expect(led.size).toBe(GPU_ERROR_CAP);
    }
  });

  it('reset forgets surfaced messages so they are admitted again', () => {
    const led = new GpuErrorLedger();
    expect(led.admit('same text')).toBe(true);
    expect(led.admit('same text')).toBe(false);
    led.reset();
    expect(led.size).toBe(0);
    expect(led.admit('same text')).toBe(true);
  });
});

describe('GpuErrorLedger — device-lost suppression', () => {
  it('drops non-device-lost noise once the device is lost', () => {
    const led = new GpuErrorLedger();
    led.noteDeviceLost();
    expect(led.deviceLost).toBe(true);
    expect(led.admit('GPUValidationError: post-loss frame noise')).toBe(false);
  });

  it('still admits the device-lost message itself after loss', () => {
    const led = new GpuErrorLedger();
    led.noteDeviceLost();
    expect(led.admit('GPUDeviceLost: the graphics device was lost (destroyed).')).toBe(true);
  });

  it('reset does not clear the device-lost flag (a lost device stays lost)', () => {
    const led = new GpuErrorLedger();
    led.noteDeviceLost();
    led.reset();
    expect(led.deviceLost).toBe(true);
    expect(led.admit('GPUOutOfMemoryError: whatever')).toBe(false);
  });
});

describe('formatUncapturedError / formatDeviceLost', () => {
  it('formats an uncaptured-error event as "Kind: detail"', () => {
    class GPUValidationError {
      message: string;
      constructor(message: string) {
        this.message = message;
      }
    }
    const event = { error: new GPUValidationError('binding group mismatch') };
    expect(formatUncapturedError(event)).toBe('GPUValidationError: binding group mismatch');
  });

  it('falls back to generic labels when the event shape is unexpected', () => {
    expect(formatUncapturedError({})).toBe('GPUError: [object Object]');
    expect(formatUncapturedError('weird')).toBe('GPUError: weird');
  });

  it('formats a device-lost payload into the actionable reload message', () => {
    expect(formatDeviceLost({ reason: 'destroyed', message: 'evicted' })).toBe(
      'GPUDeviceLost: the graphics device was lost (destroyed). evicted Reload the page to continue.',
    );
    expect(formatDeviceLost(undefined)).toBe(
      'GPUDeviceLost: the graphics device was lost (unknown). Reload the page to continue.',
    );
  });
});

/** A fake WebGPU device: records listeners and exposes a resolvable `lost`. */
function fakeDevice(withLost = true): {
  device: GpuDeviceLike;
  fire: (event: unknown) => void;
  loseDevice: (info: { reason?: string; message?: string }) => void;
  listenerCount: () => number;
} {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  let resolveLost: ((info: { reason?: string; message?: string }) => void) | null = null;
  const device: GpuDeviceLike = {
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    lost: withLost
      ? new Promise((res) => {
          resolveLost = res;
        })
      : undefined,
  };
  return {
    device,
    fire: (event) => listeners.get('uncapturederror')?.forEach((cb) => cb(event)),
    loseDevice: (info) => resolveLost?.(info),
    listenerCount: () => listeners.get('uncapturederror')?.size ?? 0,
  };
}

describe('wireGpuDeviceErrors — device seam', () => {
  it('returns null when there is no usable device', () => {
    expect(wireGpuDeviceErrors(null, { onError: () => {} })).toBeNull();
    expect(wireGpuDeviceErrors(undefined, { onError: () => {} })).toBeNull();
    expect(wireGpuDeviceErrors({}, { onError: () => {} })).toBeNull();
  });

  it('forwards uncaptured errors to onError with a formatted message', () => {
    const fake = fakeDevice();
    const onError = vi.fn();
    const detach = wireGpuDeviceErrors(fake.device, { onError });
    expect(detach).not.toBeNull();
    expect(fake.listenerCount()).toBe(1);

    class GPUValidationError {
      message: string;
      constructor(message: string) {
        this.message = message;
      }
    }
    fake.fire({ error: new GPUValidationError('bad bind group') });
    expect(onError).toHaveBeenCalledWith('GPUValidationError: bad bind group');
  });

  it('surfaces device.lost once via onDeviceLost with the reload message', async () => {
    const fake = fakeDevice();
    const onDeviceLost = vi.fn();
    wireGpuDeviceErrors(fake.device, { onError: () => {}, onDeviceLost });
    fake.loseDevice({ reason: 'destroyed', message: 'context evicted' });
    await fake.device.lost; // let the .then microtask run
    await Promise.resolve();
    expect(onDeviceLost).toHaveBeenCalledTimes(1);
    expect(onDeviceLost).toHaveBeenCalledWith(
      'GPUDeviceLost: the graphics device was lost (destroyed). context evicted Reload the page to continue.',
    );
  });

  it('detach removes the listener and stops further onError calls', () => {
    const fake = fakeDevice();
    const onError = vi.fn();
    const detach = wireGpuDeviceErrors(fake.device, { onError })!;
    detach();
    expect(fake.listenerCount()).toBe(0);
    fake.fire({ error: { message: 'ignored' } });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a device.lost that resolves after detach does not call onDeviceLost', async () => {
    const fake = fakeDevice();
    const onDeviceLost = vi.fn();
    const detach = wireGpuDeviceErrors(fake.device, { onError: () => {}, onDeviceLost })!;
    detach();
    fake.loseDevice({ reason: 'destroyed' });
    await fake.device.lost;
    await Promise.resolve();
    expect(onDeviceLost).not.toHaveBeenCalled();
  });

  it('works with a device that exposes no lost promise (WebGL-ish)', () => {
    const fake = fakeDevice(false);
    const onError = vi.fn();
    const detach = wireGpuDeviceErrors(fake.device, { onError });
    expect(detach).not.toBeNull();
    fake.fire({ error: { message: 'x', constructor: { name: 'GPUError' } } });
    expect(onError).toHaveBeenCalledOnce();
  });
});
